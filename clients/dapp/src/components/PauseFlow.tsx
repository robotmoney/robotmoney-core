/**
 * PauseFlow — pause/unpause UI surface for issue #82.
 *
 * Mirrors the AdminFlow shape: builds a structured preview from
 * `lib/preview.ts`, renders it via TxPreview, and only enables the
 * "Sign with wallet" CTA when the preview is OK. No raw-calldata-only
 * signing path exists.
 *
 * Role gating per contracts/gateway/AccessRoles.sol:
 *   - pause()   requires PAUSER_ROLE on the connected wallet.
 *   - unpause() requires ADMIN_ROLE on the connected wallet (asymmetric
 *     by design — see AccessRoles.sol invariant comment).
 *
 * Buttons are disabled when the connected wallet lacks the role; the
 * structured preview still renders so the operator sees what *would*
 * be signed.
 */
import { useAccount, useReadContract, useWriteContract, useChainId } from "wagmi";
import type { Address } from "viem";
import { ADMIN_ROLE_HASH, PAUSER_ROLE_HASH, gatewayAbi } from "../lib/abi";
import { buildPreview, type AdminAction, type PreviewContext } from "../lib/preview";
import { TxPreview } from "./TxPreview";

interface PauseFlowProps {
  gatewayAddress: Address;
  gatewayCodeHashVerified: boolean;
  envClass: PreviewContext["envClass"];
}

export function PauseFlow(props: PauseFlowProps) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();

  const { data: pausedData } = useReadContract({
    address: props.gatewayAddress,
    abi: gatewayAbi,
    functionName: "paused",
    query: { enabled: isConnected },
  });
  const paused = Boolean(pausedData);

  const { data: hasPauserData } = useReadContract({
    address: props.gatewayAddress,
    abi: gatewayAbi,
    functionName: "hasRole",
    args: address ? [PAUSER_ROLE_HASH, address] : undefined,
    query: { enabled: isConnected && Boolean(address) },
  });
  const hasPauserRole = Boolean(hasPauserData);

  const { data: hasAdminData } = useReadContract({
    address: props.gatewayAddress,
    abi: gatewayAbi,
    functionName: "hasRole",
    args: address ? [ADMIN_ROLE_HASH, address] : undefined,
    query: { enabled: isConnected && Boolean(address) },
  });
  const hasAdminRole = Boolean(hasAdminData);

  const { writeContract, isPending } = useWriteContract();

  const ctx: PreviewContext = {
    gateway: props.gatewayAddress,
    gatewayCodeHashVerified: props.gatewayCodeHashVerified,
    envClass: props.envClass,
  };

  const pauseAction: AdminAction = { kind: "pause" };
  const unpauseAction: AdminAction = { kind: "unpause" };

  const pausePreview = buildPreview(pauseAction, ctx);
  const unpausePreview = buildPreview(unpauseAction, ctx);

  const onPause = () => {
    if (!pausePreview.ok) return;
    writeContract({
      address: props.gatewayAddress,
      abi: gatewayAbi,
      functionName: "pause",
      args: [],
    });
  };

  const onUnpause = () => {
    if (!unpausePreview.ok) return;
    writeContract({
      address: props.gatewayAddress,
      abi: gatewayAbi,
      functionName: "unpause",
      args: [],
    });
  };

  return (
    <section data-testid="pause-flow" className="pause-flow">
      <h2>Pause / Unpause</h2>
      <p data-testid="pause-flow-state">
        Gateway state: <code>{paused ? "PAUSED" : "ACTIVE"}</code> · chain <code>{chainId}</code>
      </p>

      <section data-testid="pause-form">
        <h3>Pause</h3>
        <p data-testid="pause-role-status">
          PAUSER_ROLE: <code>{hasPauserRole ? "yes" : "no"}</code>
        </p>
        <TxPreview preview={pausePreview} />
        <button
          data-testid="pause-submit"
          disabled={!isConnected || !pausePreview.ok || !hasPauserRole || paused || isPending}
          onClick={onPause}
        >
          Sign pause with wallet
        </button>
      </section>

      <section data-testid="unpause-form">
        <h3>Unpause</h3>
        <p data-testid="unpause-role-status">
          ADMIN_ROLE: <code>{hasAdminRole ? "yes" : "no"}</code>
        </p>
        <TxPreview preview={unpausePreview} />
        <button
          data-testid="unpause-submit"
          disabled={!isConnected || !unpausePreview.ok || !hasAdminRole || !paused || isPending}
          onClick={onUnpause}
        >
          Sign unpause with wallet
        </button>
      </section>
    </section>
  );
}
