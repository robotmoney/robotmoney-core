// Canonical: docs/architecture.md §6.2 — Custody (see also §6.3 Role Separation)

/**
 * PauseFlow — deposit pause/unpause UI surface for issue #82.
 *
 * A deposit pause stops new gateway deposits only. Withdrawals stay open
 * while deposits are paused: no role can block a holder's exit (core 1494).
 *
 * Mirrors the AdminFlow shape: builds a structured preview from
 * `lib/preview.ts`, renders it via TxPreview, and only enables the
 * "Sign with wallet" CTA when the preview is OK. No raw-calldata-only
 * signing path exists.
 *
 * Role gating per contracts/gateway/AccessRoles.sol:
 *   - pauseDeposits()   requires DEPOSIT_PAUSER_ROLE on the connected wallet.
 *   - unpauseDeposits() requires ADMIN_ROLE on the connected wallet
 *     (asymmetric by design — see AccessRoles.sol invariant comment).
 *
 * Buttons are disabled when the connected wallet lacks the role; the
 * structured preview still renders so the operator sees what *would*
 * be signed.
 */
import {
  useAccount,
  useReadContract,
  useSimulateContract,
  useWriteContract,
  useChainId,
} from "wagmi";
import type { Address } from "viem";
import { ADMIN_ROLE_HASH, DEPOSIT_PAUSER_ROLE_HASH, gatewayAbi } from "../lib/abi";
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

  const { data: depositsPausedData } = useReadContract({
    address: props.gatewayAddress,
    abi: gatewayAbi,
    functionName: "depositsPaused",
    query: { enabled: isConnected },
  });
  const depositsPaused = Boolean(depositsPausedData);

  const { data: hasPauserData } = useReadContract({
    address: props.gatewayAddress,
    abi: gatewayAbi,
    functionName: "hasRole",
    args: address ? [DEPOSIT_PAUSER_ROLE_HASH, address] : undefined,
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

  const pauseAction: AdminAction = { kind: "pauseDeposits" };
  const unpauseAction: AdminAction = { kind: "unpauseDeposits" };

  const pausePreview = buildPreview(pauseAction, ctx);
  const unpausePreview = buildPreview(unpauseAction, ctx);

  const { data: pauseSim } = useSimulateContract({
    address: props.gatewayAddress,
    abi: gatewayAbi,
    functionName: "pauseDeposits",
    query: { enabled: isConnected && pausePreview.ok && hasPauserRole && !depositsPaused },
  });
  const { data: unpauseSim } = useSimulateContract({
    address: props.gatewayAddress,
    abi: gatewayAbi,
    functionName: "unpauseDeposits",
    query: { enabled: isConnected && unpausePreview.ok && hasAdminRole && depositsPaused },
  });

  const onPause = () => {
    if (!pauseSim) return;
    writeContract(pauseSim.request);
  };

  const onUnpause = () => {
    if (!unpauseSim) return;
    writeContract(unpauseSim.request);
  };

  return (
    <section data-testid="pause-flow" className="pause-flow">
      <h2>Pause / Unpause Deposits</h2>
      <p data-testid="pause-flow-state">
        Gateway deposits: <code>{depositsPaused ? "PAUSED" : "OPEN"}</code> · withdrawals:{" "}
        <code>OPEN</code> · chain <code>{chainId}</code>
      </p>
      <p className="hint" data-testid="pause-flow-scope">
        A deposit pause stops new deposits only. Withdrawals stay open while deposits are paused.
      </p>

      <section data-testid="pause-form">
        <h3>Pause deposits</h3>
        <p data-testid="pause-role-status">
          DEPOSIT_PAUSER_ROLE: <code>{hasPauserRole ? "yes" : "no"}</code>
        </p>
        <TxPreview preview={pausePreview} />
        <button
          type="button"
          data-testid="pause-submit"
          disabled={!isConnected || !pauseSim || isPending}
          onClick={onPause}
        >
          Sign deposit pause with wallet
        </button>
      </section>

      <section data-testid="unpause-form">
        <h3>Unpause deposits</h3>
        <p data-testid="unpause-role-status">
          ADMIN_ROLE: <code>{hasAdminRole ? "yes" : "no"}</code>
        </p>
        <TxPreview preview={unpausePreview} />
        <button
          type="button"
          data-testid="unpause-submit"
          disabled={!isConnected || !unpauseSim || isPending}
          onClick={onUnpause}
        >
          Sign deposit unpause with wallet
        </button>
      </section>
    </section>
  );
}
