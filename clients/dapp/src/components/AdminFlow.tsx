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
import { gatewayAbi } from "../lib/abi";
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
