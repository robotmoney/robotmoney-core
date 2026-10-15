// Canonical: docs/adr/ADR-0014-governed-upgrades-and-freeze.md §1, §5 — the nine proxies, the freeze

/**
 * ProtocolUpgradesPanel — the implementation and freeze state of the proxied
 * contracts that are not vaults (issue 1810 acceptance: "the dapp and explorer
 * display the implementation address and freeze state"). Every agent consent
 * binds the gateway's implementation version, and every routed deposit runs
 * through the router and the registry, so a holder sees them next to the
 * vaults: the gateway, the PortfolioRouter, the VaultRegistry, the
 * InvestmentCommitteePolicy and the ConsensusRecommendationReceipt. Each vault
 * page shows its own vault.
 *
 * The IC policy and receipt addresses come from the gateway's `icPolicy()` and
 * `consensusReceipt()` on chain. When the dapp cannot read the chain (no
 * wallet on the `mainnet` class), they come from the explorer index's rows of
 * kind `investment_committee` and `consensus_receipt`, and each row says it is
 * indexed. Disclosure only: nothing here gates a write.
 */
import { isAddress, zeroAddress, type Address } from "viem";
import { useReadContracts } from "wagmi";
import { GATEWAY_COMMITTEE_ABI } from "../lib/abi";
import { useWriteChainGuard } from "../lib/useGuardedWriteContract";
import { useIndexedUpgrades } from "../lib/useUpgradeState";
import { depositsReadAllowed } from "../lib/useVaultsDepositsPaused";
import { UpgradeStatePanel } from "./UpgradeStatePanel";

interface Props {
  readonly gatewayAddress: string;
  readonly routerAddress?: string;
  readonly registryAddress?: string;
}

function usable(a: string | null | undefined): a is string {
  return a != null && isAddress(a, { strict: false }) && a.toLowerCase() !== zeroAddress;
}

/** The IC policy and receipt proxies: from the gateway on chain, else from the explorer index. */
function useCommitteeAddresses(gateway: string): {
  icPolicy: string | null;
  receipt: string | null;
} {
  const { state } = useWriteChainGuard();
  const allowed = depositsReadAllowed(state);
  const chainId = state.kind === "ok" ? state.targetChainId : undefined;
  const target = usable(gateway) ? (gateway as Address) : undefined;
  const { data } = useReadContracts({
    allowFailure: true,
    contracts: [
      {
        address: target ?? zeroAddress,
        abi: GATEWAY_COMMITTEE_ABI,
        functionName: "icPolicy" as const,
        chainId,
      },
      {
        address: target ?? zeroAddress,
        abi: GATEWAY_COMMITTEE_ABI,
        functionName: "consensusReceipt" as const,
        chainId,
      },
    ],
    query: { enabled: allowed && target !== undefined },
  });
  const indexed = useIndexedUpgrades(!allowed);
  if (allowed) {
    const ic = data?.[0];
    const rc = data?.[1];
    return {
      icPolicy: ic?.status === "success" && typeof ic.result === "string" ? ic.result : null,
      receipt: rc?.status === "success" && typeof rc.result === "string" ? rc.result : null,
    };
  }
  const rows = indexed != null && Array.isArray(indexed.contracts) ? indexed.contracts : [];
  const byKind = (kind: string) => rows.find((r) => r.contract_kind === kind)?.contract ?? null;
  return { icPolicy: byKind("investment_committee"), receipt: byKind("consensus_receipt") };
}

export function ProtocolUpgradesPanel({ gatewayAddress, routerAddress, registryAddress }: Props) {
  const { icPolicy, receipt } = useCommitteeAddresses(gatewayAddress);
  const rows: ReadonlyArray<{ key: string; title: string; address: string | null }> = [
    { key: "gateway", title: "RobotMoneyGateway", address: gatewayAddress },
    { key: "router", title: "PortfolioRouter", address: routerAddress ?? null },
    { key: "registry", title: "VaultRegistry", address: registryAddress ?? null },
    { key: "ic-policy", title: "InvestmentCommitteePolicy", address: icPolicy },
    { key: "receipt", title: "ConsensusRecommendationReceipt", address: receipt },
  ];
  return (
    <section data-testid="protocol-upgrades">
      <h2>Contract upgrades</h2>
      <p className="hint">
        Each contract below runs behind its own proxy. The timelock can replace its implementation
        after a public delay until the proxy is frozen for good. Withdrawals stay open either way.
      </p>
      {rows.map((r) =>
        usable(r.address) ? (
          <UpgradeStatePanel
            key={r.key}
            address={r.address}
            title={r.title}
            testId={`protocol-upgrade-${r.key}`}
          />
        ) : (
          <div
            key={r.key}
            data-testid={`protocol-upgrade-${r.key}`}
            data-upgrade-state="unconfigured"
          >
            <h3>{r.title}</h3>
            <p className="hint">This deployment does not name this contract.</p>
          </div>
        ),
      )}
    </section>
  );
}
