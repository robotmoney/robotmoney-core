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
import { isAddress, type Address } from "viem";
import { gatewayAbi, ROLE_HASH, type RoleName } from "../lib/abi";
import { buildPreview, type AdminAction, type PreviewContext } from "../lib/preview";
import { TxPreview } from "./TxPreview";
import { PauseFlow } from "./PauseFlow";
import { ConfigExportPanel } from "./ConfigExportPanel";
import { resolveFlags } from "../lib/featureFlags";

interface AdminFlowProps {
  gatewayAddress: Address;
  vaultAddress: Address;
  gatewayCodeHashVerified: boolean;
  envClass: PreviewContext["envClass"];
  flagEnv: Record<string, string | undefined>;
}

export function AdminFlow(props: AdminFlowProps) {
  const flags = resolveFlags(props.flagEnv);
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();

  const { data: pausedData } = useReadContract({
    address: props.gatewayAddress,
    abi: gatewayAbi,
    functionName: "paused",
    query: { enabled: isConnected },
  });
  const paused = Boolean(pausedData);

  const [agent, setAgent] = useState("");
  const [validUntil, setValidUntil] = useState(() =>
    Math.floor(Date.now() / 1000 + 86400).toString(),
  );
  const [maxPerPayment, setMaxPerPayment] = useState("100000000"); // 100 USDC
  const [maxPerWindow, setMaxPerWindow] = useState("1000000000"); // 1000 USDC
  const [shareReceiver, setShareReceiver] = useState("");

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

  return (
    <main className="admin-flow">
      <h1>RobotMoney admin dapp</h1>

      <section data-testid="connect-section">
        {!isConnected ? (
          <>
            <p>Connect a wallet to begin.</p>
            {connectors.map((c) => (
              <button
                key={c.uid}
                data-testid={`connect-${c.id}`}
                onClick={() => connect({ connector: c })}
              >
                Connect {c.name}
              </button>
            ))}
            {connectors.length === 0 && (
              <p data-testid="no-connectors">
                No wallet connector configured. Set VITE_USE_MOCK_WALLET=true for tests, or install
                a browser wallet.
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

      {validAgent && validReceiver && (
        <ConfigExportPanel
          gateway={props.gatewayAddress}
          vault={props.vaultAddress}
          gatewayCodeHash={"0x" + "00".repeat(32)}
          chainId={chainId}
          chainName={props.envClass}
          rpcUrl={props.flagEnv.VITE_FORK_RPC_URL ?? "http://127.0.0.1:8545"}
          agent={agent as Address}
          policy={{
            active: true,
            validUntil: BigInt(validUntil),
            maxPerPayment: BigInt(maxPerPayment),
            maxPerWindow: BigInt(maxPerWindow),
            shareReceiver: shareReceiver as Address,
          }}
        />
      )}
    </main>
  );
}
