/**
 * DestinationSelector — lets the depositor pick a deposit destination
 * (issue #320). Two options are offered:
 *
 *   - A specific vault: deposits directly via ERC-4626 `vault.deposit`.
 *   - Portfolio Router: splits USDC across all active vaults by weight
 *     via `router.deposit(amount, [])`.
 *
 * Registered vaults are enumerated from `registry.listVaults()`. The
 * router option is always offered when `routerAddress` is non-zero.
 *
 * The component is a controlled radio group — the parent owns the
 * selected destination and receives updates via `onSelect`.
 */
import type { Address } from "viem";
import { useReadContract } from "wagmi";
import { registryAbi } from "../lib/abi";
import { shortenAddr } from "../lib/routerPreview";

export const ROUTER_DESTINATION = "router" as const;
export type Destination = Address | typeof ROUTER_DESTINATION;

type Props = Readonly<{
  registryAddress: Address;
  routerAddress: Address;
  selected: Destination;
  onSelect: (d: Destination) => void;
}>;

export function DestinationSelector(props: Props) {
  const { data: vaultListRaw } = useReadContract({
    address: props.registryAddress,
    abi: registryAbi,
    functionName: "listVaults",
  });

  const vaults: Address[] = Array.isArray(vaultListRaw) ? (vaultListRaw as Address[]) : [];

  const hasRouter = props.routerAddress !== "0x0000000000000000000000000000000000000000";

  return (
    <fieldset data-testid="destination-selector">
      <legend>Deposit destination</legend>
      {vaults.map((vault) => (
        <label key={vault} data-testid={`destination-vault-${vault.toLowerCase()}`}>
          <input
            type="radio"
            name="deposit-destination"
            value={vault}
            checked={props.selected === vault}
            onChange={() => props.onSelect(vault)}
          />{" "}
          Vault {shortenAddr(vault)}
        </label>
      ))}
      {hasRouter && (
        <label data-testid="destination-router">
          <input
            type="radio"
            name="deposit-destination"
            value={ROUTER_DESTINATION}
            checked={props.selected === ROUTER_DESTINATION}
            onChange={() => props.onSelect(ROUTER_DESTINATION)}
          />{" "}
          Portfolio Router (all active vaults by weight)
        </label>
      )}
      {vaults.length === 0 && !hasRouter && (
        <p className="hint" data-testid="destination-none">
          No vaults registered yet.
        </p>
      )}
    </fieldset>
  );
}
