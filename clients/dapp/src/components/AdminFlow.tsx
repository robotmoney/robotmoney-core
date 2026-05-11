/**
 * AdminFlow — minimal connect/authorize/revoke surface backed by
 * wagmi. Reads RPC for paused() state, builds previews for each action,
 * and only enables the "Sign with wallet" button when the preview is OK.
 *
 * The admin is the connected wallet (human admin role). The agent
 * address is supplied by the operator (register-only flow per ADR §3.1).
 * Browser-generated keypair flow is gated by featureFlags.
 */
import { useState } from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useWriteContract,
  useChainId,
  useReadContract,
} from "wagmi";
import { targetChainId, targetRpcUrl } from "../lib/wagmi";

interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

/**
 * Force the wallet's stored RPC URL for `targetChainId` to match the
 * one this bundle was built with. Calling `wallet_addEthereumChain`
 * unconditionally is the only reliable way to do this: when the wallet
 * already has the chain but with a different (stale) RPC URL, the
 * standard `wallet_switchEthereumChain` is a no-op for the URL, so the
 * wallet keeps using whatever it had — typically the previous
 * smoke-test session's now-dead tunnel URL.
 *
 * If the URL is unchanged, most wallets dedupe and the user sees no
 * prompt; if it differs, the user sees a single confirmation and the
 * wallet adopts the new URL. Then we switch into the chain.
 */
async function syncDevnetChain(provider: Eip1193Provider): Promise<string | undefined> {
  if (targetChainId === undefined || !targetRpcUrl) {
    return "VITE_DEVNET_RPC_URL is not set in this build — auto network add is disabled.";
  }
  const chainIdHex = `0x${targetChainId.toString(16)}`;
  let addError: unknown;
  try {
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: chainIdHex,
          chainName: "Robot Money devnet",
          rpcUrls: [targetRpcUrl],
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          // MetaMask v11+ sometimes refuses the add without a block
          // explorer entry; the explorer-api URL serves as a sensible
          // stand-in even though it isn't a block-explorer UI.
          blockExplorerUrls: [String(import.meta.env.VITE_EXPLORER_API_URL ?? targetRpcUrl)],
        },
      ],
    });
  } catch (err) {
    addError = err;
    // eslint-disable-next-line no-console
    console.error("wallet_addEthereumChain failed:", err);
  }
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
    return undefined;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("wallet_switchEthereumChain failed:", err);
    const addMsg = addError ? `add: ${(addError as { message?: string }).message ?? addError}` : "";
    const switchMsg = `switch: ${(err as { message?: string }).message ?? err}`;
    return [addMsg, switchMsg].filter(Boolean).join(" — ");
  }
}

function getInjectedProvider(): Eip1193Provider | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
}
import { isAddress, type Address } from "viem";
import { gatewayAbi, ROLE_HASH, type RoleName } from "../lib/abi";
import { buildPreview, type AdminAction, type PreviewContext } from "../lib/preview";
import { TxPreview } from "./TxPreview";
import { PauseFlow } from "./PauseFlow";
import { ConfigExportPanel } from "./ConfigExportPanel";
import { HistoryPane } from "./HistoryPane";
import { resolveFlags } from "../lib/featureFlags";
import { resolveExplorerApiUrl } from "../lib/explorerApi";
import { composeRotationPreview } from "../rotation";
import type { VerificationState } from "../lib/useGatewayVerifier";

interface AdminFlowProps {
  gatewayAddress: Address;
  vaultAddress: Address;
  /** Derived boolean — true only when verification succeeded. */
  gatewayCodeHashVerified: boolean;
  /** Full verification state for rendering the status banner. */
  gatewayVerificationState: VerificationState;
  /** Re-trigger the verification fetch. Wired to the refusal-state retry button. */
  gatewayVerificationRefresh: () => void;
  envClass: PreviewContext["envClass"];
  flagEnv: Record<string, string | undefined>;
}

export function AdminFlow(props: AdminFlowProps) {
  const flags = resolveFlags(props.flagEnv);
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();

  const [networkSyncError, setNetworkSyncError] = useState<string | undefined>(undefined);

  const runSync = async () => {
    const provider = getInjectedProvider();
    if (!provider) {
      setNetworkSyncError("No injected wallet provider (window.ethereum is undefined).");
      return;
    }
    const err = await syncDevnetChain(provider);
    setNetworkSyncError(err);
  };

  // Connect Wallet handles the full devnet network bookkeeping: connect
  // accounts → push the current RPC URL into the wallet via
  // `wallet_addEthereumChain` → switch into the chain. See
  // `syncDevnetChain`.
  const handleConnect = (connector: (typeof connectors)[number]) => {
    connect(
      { connector },
      {
        onSuccess: () => {
          void runSync();
        },
      },
    );
  };

  const handleSwitchChain = () => {
    void runSync();
  };

  const { data: pausedData } = useReadContract({
    address: props.gatewayAddress,
    abi: gatewayAbi,
    functionName: "paused",
    query: { enabled: isConnected },
  });
  const paused = Boolean(pausedData);

  // Read the USDC token address from the gateway contract. Used by
  // ConfigExportPanel so the exported config includes the real usdc_address.
  const { data: usdcAddressData } = useReadContract({
    address: props.gatewayAddress,
    abi: gatewayAbi,
    functionName: "usdc",
    query: { enabled: isConnected },
  });
  const usdcAddress = (usdcAddressData as Address | undefined) ?? ("" as Address);

  const [agent, setAgent] = useState("");
  const [validUntil, setValidUntil] = useState(() =>
    Math.floor(Date.now() / 1000 + 86400).toString(),
  );
  const [maxPerPayment, setMaxPerPayment] = useState("100000000"); // 100 USDC
  const [maxPerWindow, setMaxPerWindow] = useState("1000000000"); // 1000 USDC
  const [shareReceiver, setShareReceiver] = useState("");

  // Rotation flow state: old agent address + new agent address + new policy.
  // The rotation section is independent from the single-action authorize/revoke
  // forms above. Both revoke (old) and authorize (new) previews must be OK
  // before either wallet button is enabled.
  const [rotationOldAgent, setRotationOldAgent] = useState("");
  const [rotationNewAgent, setRotationNewAgent] = useState("");
  const [rotationValidUntil, setRotationValidUntil] = useState(() =>
    Math.floor(Date.now() / 1000 + 86400).toString(),
  );
  const [rotationMaxPerPayment, setRotationMaxPerPayment] = useState("100000000"); // 100 USDC
  const [rotationMaxPerWindow, setRotationMaxPerWindow] = useState("1000000000"); // 1000 USDC
  const [rotationShareReceiver, setRotationShareReceiver] = useState("");
  const [rotationStep, setRotationStep] = useState<"idle" | "revoke-sent" | "done">("idle");

  const validRotationOld = isAddress(rotationOldAgent);
  const validRotationNew = isAddress(rotationNewAgent);
  const validRotationReceiver = isAddress(rotationShareReceiver);

  // Compose the rotation preview (pure, no wallet). May throw on invalid
  // address combinations — caught below so the section degrades gracefully.
  let rotationPreview: ReturnType<typeof composeRotationPreview> | null = null;
  let rotationPreviewError: string | null = null;
  if (validRotationOld && validRotationNew && validRotationReceiver) {
    try {
      rotationPreview = composeRotationPreview(rotationOldAgent, rotationNewAgent, {
        shareReceiver: rotationShareReceiver,
        validUntil: Number(rotationValidUntil),
        maxPerDeposit: BigInt(rotationMaxPerPayment),
        maxPerWindow: BigInt(rotationMaxPerWindow),
      });
    } catch (err) {
      rotationPreviewError = (err as Error).message;
    }
  }

  // ADMIN_ROLE / PAUSER_ROLE grant + revoke. Each role keeps its own
  // address input so the operator can grant ADMIN to one signer and
  // PAUSER to another without retyping. See issue #83 + ADR §3.3.
  const [adminAccount, setAdminAccount] = useState("");
  const [pauserAccount, setPauserAccount] = useState("");

  const { writeContract, isPending } = useWriteContract();

  const ctx: PreviewContext = {
    gateway: props.gatewayAddress,
    gatewayCodeHashVerified: props.gatewayCodeHashVerified,
    envClass: props.envClass,
  };

  // Build the on-chain previews via the existing preview pipeline so the
  // TxPreview component renders structured fields for both rotation steps.
  const rotationRevokeAction: AdminAction | null = validRotationOld
    ? { kind: "revokeAgent", agent: rotationOldAgent as Address }
    : null;
  const rotationAuthorizeAction: AdminAction | null =
    validRotationNew && validRotationReceiver
      ? {
          kind: "authorizeAgent",
          agent: rotationNewAgent as Address,
          policy: {
            active: true,
            validUntil: BigInt(rotationValidUntil),
            maxPerPayment: BigInt(rotationMaxPerPayment),
            maxPerWindow: BigInt(rotationMaxPerWindow),
            shareReceiver: rotationShareReceiver as Address,
          },
        }
      : null;

  const rotationRevokePrev = rotationRevokeAction ? buildPreview(rotationRevokeAction, ctx) : null;
  const rotationAuthorizePrev = rotationAuthorizeAction
    ? buildPreview(rotationAuthorizeAction, ctx)
    : null;

  // Both previews must be structurally OK before either wallet button is enabled.
  const rotationPreviewsOk =
    rotationPreview !== null &&
    rotationRevokePrev?.ok === true &&
    rotationAuthorizePrev?.ok === true;

  const onRotationRevoke = () => {
    if (!rotationRevokeAction || !rotationRevokePrev?.ok) return;
    writeContract({
      address: props.gatewayAddress,
      abi: gatewayAbi,
      functionName: "revokeAgent",
      args: [rotationRevokeAction.agent],
    });
    setRotationStep("revoke-sent");
  };

  const onRotationAuthorize = () => {
    if (!rotationAuthorizeAction || !rotationAuthorizePrev?.ok) return;
    writeContract({
      address: props.gatewayAddress,
      abi: gatewayAbi,
      functionName: "authorizeAgent",
      args: [
        rotationAuthorizeAction.agent,
        {
          active: rotationAuthorizeAction.policy.active,
          validUntil: rotationAuthorizeAction.policy.validUntil,
          maxPerPayment: rotationAuthorizeAction.policy.maxPerPayment,
          maxPerWindow: rotationAuthorizeAction.policy.maxPerWindow,
          shareReceiver: rotationAuthorizeAction.policy.shareReceiver,
        },
      ],
    });
    setRotationStep("done");
  };

  const validAgent = isAddress(agent);
  const validReceiver = isAddress(shareReceiver);

  const authorizeAction: AdminAction | null =
    validAgent && validReceiver
      ? {
          kind: "authorizeAgent",
          agent: agent as Address,
          policy: {
            active: true,
            validUntil: BigInt(validUntil),
            maxPerPayment: BigInt(maxPerPayment),
            maxPerWindow: BigInt(maxPerWindow),
            shareReceiver: shareReceiver as Address,
          },
        }
      : null;

  const revokeAction: AdminAction | null = validAgent
    ? { kind: "revokeAgent", agent: agent as Address }
    : null;

  const authorizePreview = authorizeAction ? buildPreview(authorizeAction, ctx) : null;
  const revokePreview = revokeAction ? buildPreview(revokeAction, ctx) : null;

  const onAuthorize = () => {
    if (!authorizeAction || !authorizePreview?.ok) return;
    writeContract({
      address: props.gatewayAddress,
      abi: gatewayAbi,
      functionName: "authorizeAgent",
      args: [
        authorizeAction.agent,
        {
          active: authorizeAction.policy.active,
          validUntil: authorizeAction.policy.validUntil,
          maxPerPayment: authorizeAction.policy.maxPerPayment,
          maxPerWindow: authorizeAction.policy.maxPerWindow,
          shareReceiver: authorizeAction.policy.shareReceiver,
        },
      ],
    });
  };

  const onRevoke = () => {
    if (!revokeAction || !revokePreview?.ok) return;
    writeContract({
      address: props.gatewayAddress,
      abi: gatewayAbi,
      functionName: "revokeAgent",
      args: [revokeAction.agent],
    });
  };

  // Builds a grant or revoke action for the given role iff the address
  // input parses. Returns null otherwise so the preview block stays hidden
  // and the wallet button stays disabled — same UX shape as the agent flow.
  const validAdminAccount = isAddress(adminAccount);
  const validPauserAccount = isAddress(pauserAccount);

  const grantAdminAction: AdminAction | null = validAdminAccount
    ? { kind: "grantRole", role: "ADMIN_ROLE", account: adminAccount as Address }
    : null;
  const revokeAdminAction: AdminAction | null = validAdminAccount
    ? { kind: "revokeRole", role: "ADMIN_ROLE", account: adminAccount as Address }
    : null;
  const grantPauserAction: AdminAction | null = validPauserAccount
    ? { kind: "grantRole", role: "PAUSER_ROLE", account: pauserAccount as Address }
    : null;
  const revokePauserAction: AdminAction | null = validPauserAccount
    ? { kind: "revokeRole", role: "PAUSER_ROLE", account: pauserAccount as Address }
    : null;

  const grantAdminPreview = grantAdminAction ? buildPreview(grantAdminAction, ctx) : null;
  const revokeAdminPreview = revokeAdminAction ? buildPreview(revokeAdminAction, ctx) : null;
  const grantPauserPreview = grantPauserAction ? buildPreview(grantPauserAction, ctx) : null;
  const revokePauserPreview = revokePauserAction ? buildPreview(revokePauserAction, ctx) : null;

  // Shared writeContract dispatcher for grantRole/revokeRole. The
  // function name maps to the AccessControl entry point on the gateway.
  const submitRoleCall = (fn: "grantRole" | "revokeRole", role: RoleName, account: Address) => {
    writeContract({
      address: props.gatewayAddress,
      abi: gatewayAbi,
      functionName: fn,
      args: [ROLE_HASH[role], account],
    });
  };

  const { gatewayVerificationState } = props;

  return (
    <main className="admin-flow">
      <h1>RobotMoney admin dapp</h1>

      <section data-testid="gateway-verification-status">
        {gatewayVerificationState.status === "pending" && (
          <p data-testid="gateway-verification-pending">
            Verifying gateway bytecode hash… Admin writes are disabled until verification completes.
          </p>
        )}
        {gatewayVerificationState.status === "verified" && (
          <p data-testid="gateway-verification-ok">
            Gateway bytecode verified: <code>{gatewayVerificationState.computedHash}</code>
          </p>
        )}
        {gatewayVerificationState.status === "refused" && (
          <p data-testid="gateway-verification-refused" className="unsafe-banner">
            <strong>Gateway verification refused — admin writes disabled.</strong>{" "}
            {gatewayVerificationState.reason}{" "}
            <button
              data-testid="gateway-verification-retry"
              onClick={props.gatewayVerificationRefresh}
            >
              Re-verify
            </button>
          </p>
        )}
      </section>

      <section data-testid="connect-section">
        {!isConnected ? (
          <>
            <p>Connect a wallet to begin.</p>
            {connectors.map((c) => (
              <button key={c.uid} data-testid={`connect-${c.id}`} onClick={() => handleConnect(c)}>
                Connect {c.name}
              </button>
            ))}
            {connectors.length === 0 && (
              <p data-testid="no-connectors">
                No browser wallet detected. Install a wallet extension (e.g. MetaMask) to continue.
              </p>
            )}
          </>
        ) : (
          <>
            <p>
              Connected: <code data-testid="connected-address">{address}</code> · chain{" "}
              <code data-testid="connected-chain">{chainId}</code> · paused{" "}
              <code data-testid="gateway-paused">{String(paused)}</code>
            </p>
            {targetChainId !== undefined && chainId !== targetChainId && (
              <button data-testid="switch-chain" onClick={handleSwitchChain}>
                Switch to Robot Money devnet
              </button>
            )}
            {networkSyncError && (
              <p data-testid="network-sync-error" className="unsafe-banner">
                <strong>Network setup error:</strong> {networkSyncError}
              </p>
            )}
            <button data-testid="disconnect" onClick={() => disconnect()}>
              Disconnect
            </button>
          </>
        )}
      </section>

      {flags.browserGeneratedCredential ? (
        <section data-testid="browser-keygen" className="unsafe-banner">
          <strong>UNSAFE: software-backed credential</strong>
          <p>Browser-generated keypair flow ENABLED. Fork/devnet only.</p>
        </section>
      ) : (
        <p data-testid="browser-keygen-disabled" hidden>
          Browser-generated credential flow disabled.
        </p>
      )}

      <section data-testid="authorize-form">
        <h2>Authorize agent</h2>
        <label>
          Agent address
          <input
            data-testid="agent-input"
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            placeholder="0x..."
          />
        </label>
        <label>
          Valid-until (unix seconds)
          <input
            data-testid="validUntil-input"
            value={validUntil}
            onChange={(e) => setValidUntil(e.target.value)}
          />
        </label>
        <label>
          Max per payment (USDC base units)
          <input
            data-testid="maxPerPayment-input"
            value={maxPerPayment}
            onChange={(e) => setMaxPerPayment(e.target.value)}
          />
        </label>
        <label>
          Max per window (USDC base units)
          <input
            data-testid="maxPerWindow-input"
            value={maxPerWindow}
            onChange={(e) => setMaxPerWindow(e.target.value)}
          />
        </label>
        <label>
          Share receiver
          <input
            data-testid="shareReceiver-input"
            value={shareReceiver}
            onChange={(e) => setShareReceiver(e.target.value)}
            placeholder="0x..."
          />
        </label>

        {authorizePreview && <TxPreview preview={authorizePreview} />}

        <button
          data-testid="authorize-submit"
          disabled={!isConnected || !authorizePreview?.ok || isPending}
          onClick={onAuthorize}
        >
          Sign authorizeAgent with wallet
        </button>
      </section>

      <PauseFlow
        gatewayAddress={props.gatewayAddress}
        gatewayCodeHashVerified={props.gatewayCodeHashVerified}
        envClass={props.envClass}
      />

      <section data-testid="revoke-form">
        <h2>Revoke agent</h2>
        {revokePreview && <TxPreview preview={revokePreview} />}
        <button
          data-testid="revoke-submit"
          disabled={!isConnected || !revokePreview?.ok || isPending}
          onClick={onRevoke}
        >
          Sign revokeAgent with wallet
        </button>
      </section>

      <section data-testid="rotation-form">
        <h2>Agent rotation (revoke old → authorize new)</h2>
        <p>
          Both previews must be confirmed before wallet signing begins. Do not close this dialog
          between transactions.
        </p>

        {rotationPreview && (
          <p data-testid="rotation-combined-risk" className="rotation-risk-banner">
            {rotationPreview.combinedRiskAnnotation}
          </p>
        )}
        {rotationPreviewError && (
          <p data-testid="rotation-preview-error" className="error">
            {rotationPreviewError}
          </p>
        )}

        <label>
          Old agent address (to revoke)
          <input
            data-testid="rotation-old-agent-input"
            value={rotationOldAgent}
            onChange={(e) => {
              setRotationOldAgent(e.target.value);
              setRotationStep("idle");
            }}
            placeholder="0x..."
          />
        </label>
        <label>
          New agent address (to authorize)
          <input
            data-testid="rotation-new-agent-input"
            value={rotationNewAgent}
            onChange={(e) => {
              setRotationNewAgent(e.target.value);
              setRotationStep("idle");
            }}
            placeholder="0x..."
          />
        </label>
        <label>
          Valid-until (unix seconds)
          <input
            data-testid="rotation-validUntil-input"
            value={rotationValidUntil}
            onChange={(e) => setRotationValidUntil(e.target.value)}
          />
        </label>
        <label>
          Max per payment (USDC base units)
          <input
            data-testid="rotation-maxPerPayment-input"
            value={rotationMaxPerPayment}
            onChange={(e) => setRotationMaxPerPayment(e.target.value)}
          />
        </label>
        <label>
          Max per window (USDC base units)
          <input
            data-testid="rotation-maxPerWindow-input"
            value={rotationMaxPerWindow}
            onChange={(e) => setRotationMaxPerWindow(e.target.value)}
          />
        </label>
        <label>
          Share receiver
          <input
            data-testid="rotation-shareReceiver-input"
            value={rotationShareReceiver}
            onChange={(e) => setRotationShareReceiver(e.target.value)}
            placeholder="0x..."
          />
        </label>

        <div data-testid="rotation-step1">
          <h3>Step 1: revoke old agent</h3>
          {rotationRevokePrev && <TxPreview preview={rotationRevokePrev} />}
          <button
            data-testid="rotation-revoke-submit"
            disabled={!isConnected || !rotationPreviewsOk || rotationStep !== "idle" || isPending}
            onClick={onRotationRevoke}
          >
            Step 1 — Sign revokeAgent(old) with wallet
          </button>
        </div>

        <div data-testid="rotation-step2">
          <h3>Step 2: authorize new agent</h3>
          {rotationAuthorizePrev && <TxPreview preview={rotationAuthorizePrev} />}
          <button
            data-testid="rotation-authorize-submit"
            disabled={
              !isConnected || !rotationPreviewsOk || rotationStep !== "revoke-sent" || isPending
            }
            onClick={onRotationAuthorize}
          >
            Step 2 — Sign authorizeAgent(new) with wallet
          </button>
        </div>

        {rotationStep === "done" && (
          <p data-testid="rotation-complete">Rotation complete. Verify on-chain state.</p>
        )}
      </section>

      <section data-testid="admin-role-form">
        <h2>ADMIN_ROLE grant / revoke</h2>
        <p>
          Mutually exclusive with AGENT_ROLE and PAUSER_ROLE per
          <code> AccessRoles._grantRole</code>. Only DEFAULT_ADMIN_ROLE holders may grant.
        </p>
        <label>
          ADMIN account address
          <input
            data-testid="admin-account-input"
            value={adminAccount}
            onChange={(e) => setAdminAccount(e.target.value)}
            placeholder="0x..."
          />
        </label>
        {grantAdminPreview && (
          <div data-testid="grant-admin-preview-wrap">
            <TxPreview preview={grantAdminPreview} />
          </div>
        )}
        <button
          data-testid="grant-admin-submit"
          disabled={!isConnected || !grantAdminPreview?.ok || isPending}
          onClick={() =>
            grantAdminAction &&
            grantAdminPreview?.ok &&
            submitRoleCall("grantRole", "ADMIN_ROLE", grantAdminAction.account)
          }
        >
          Sign grantRole(ADMIN_ROLE) with wallet
        </button>
        {revokeAdminPreview && (
          <div data-testid="revoke-admin-preview-wrap">
            <TxPreview preview={revokeAdminPreview} />
          </div>
        )}
        <button
          data-testid="revoke-admin-submit"
          disabled={!isConnected || !revokeAdminPreview?.ok || isPending}
          onClick={() =>
            revokeAdminAction &&
            revokeAdminPreview?.ok &&
            submitRoleCall("revokeRole", "ADMIN_ROLE", revokeAdminAction.account)
          }
        >
          Sign revokeRole(ADMIN_ROLE) with wallet
        </button>
      </section>

      <section data-testid="pauser-role-form">
        <h2>PAUSER_ROLE grant / revoke</h2>
        <p>
          PAUSER may call <code>pause()</code> only; <code>unpause()</code> requires ADMIN_ROLE.
          Mutually exclusive with AGENT_ROLE and ADMIN_ROLE on the same account.
        </p>
        <label>
          PAUSER account address
          <input
            data-testid="pauser-account-input"
            value={pauserAccount}
            onChange={(e) => setPauserAccount(e.target.value)}
            placeholder="0x..."
          />
        </label>
        {grantPauserPreview && (
          <div data-testid="grant-pauser-preview-wrap">
            <TxPreview preview={grantPauserPreview} />
          </div>
        )}
        <button
          data-testid="grant-pauser-submit"
          disabled={!isConnected || !grantPauserPreview?.ok || isPending}
          onClick={() =>
            grantPauserAction &&
            grantPauserPreview?.ok &&
            submitRoleCall("grantRole", "PAUSER_ROLE", grantPauserAction.account)
          }
        >
          Sign grantRole(PAUSER_ROLE) with wallet
        </button>
        {revokePauserPreview && (
          <div data-testid="revoke-pauser-preview-wrap">
            <TxPreview preview={revokePauserPreview} />
          </div>
        )}
        <button
          data-testid="revoke-pauser-submit"
          disabled={!isConnected || !revokePauserPreview?.ok || isPending}
          onClick={() =>
            revokePauserAction &&
            revokePauserPreview?.ok &&
            submitRoleCall("revokeRole", "PAUSER_ROLE", revokePauserAction.account)
          }
        >
          Sign revokeRole(PAUSER_ROLE) with wallet
        </button>
      </section>

      {flags.historyPane && validAgent && (
        <HistoryPane agent={agent as Address} apiUrl={resolveExplorerApiUrl(props.flagEnv)} />
      )}

      {validAgent && validReceiver && (
        <ConfigExportPanel
          gateway={props.gatewayAddress}
          vault={props.vaultAddress}
          usdcAddress={usdcAddress}
          gatewayRuntimeHash={
            props.gatewayVerificationState.status === "verified"
              ? props.gatewayVerificationState.computedHash
              : ""
          }
          chainId={chainId}
          agent={agent as Address}
        />
      )}
    </main>
  );
}
