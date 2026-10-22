// Canonical: docs/architecture.md §5.2 — Agent Permissions Gateway

import { useState, type Dispatch, type SetStateAction } from "react";
import { useVaultRegistry } from "../lib/vaultRegistryState";
import { normalizeDestinations } from "../lib/agentDestinations";

type Props = Readonly<{
  selected: readonly string[];
  setSelected: Dispatch<SetStateAction<string[]>>;
  /** The Portfolio Router is never a destination, so it is dropped from any list. */
  routerAddress?: string;
  testIdPrefix?: string;
}>;

/**
 * The owner's explicit choice of vaults the agent may deposit into. Nothing is pre-checked.
 * The list is the registry's vaults plus any address typed in, minus the router.
 */
export function DestinationPicker(props: Props) {
  const p = props.testIdPrefix ?? "";
  const { vaults } = useVaultRegistry();
  const router = props.routerAddress?.toLowerCase();
  const offered = vaults.filter((v) => v.vault.toLowerCase() !== router);
  const chosen = new Set(props.selected.map((a) => a.toLowerCase()));
  const toggle = (addr: string) =>
    props.setSelected((cur) => {
      const has = cur.some((a) => a.toLowerCase() === addr.toLowerCase());
      return has ? cur.filter((a) => a.toLowerCase() !== addr.toLowerCase()) : [...cur, addr];
    });
  const [typed, setTyped] = useState("");

  return (
    <fieldset data-testid={`${p}destinations`}>
      <legend>Vaults the agent may deposit into (select at least one)</legend>
      {offered.map((v) => (
        <label key={v.vault}>
          <input
            type="checkbox"
            data-testid={`${p}destination-${v.vault.toLowerCase()}`}
            checked={chosen.has(v.vault.toLowerCase())}
            onChange={() => toggle(v.vault)}
          />
          {v.name} <code>{v.vault}</code>
        </label>
      ))}
      <label>
        Other ERC-4626 vault addresses (comma separated)
        <input
          data-testid={`${p}destination-extra`}
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
            const extra = normalizeDestinations(
              e.target.value.split(/[\s,]+/).filter(Boolean),
              props.routerAddress ? [props.routerAddress] : [],
            );
            props.setSelected((cur) => [
              ...cur.filter((a) => offered.some((v) => v.vault.toLowerCase() === a.toLowerCase())),
              ...extra,
            ]);
          }}
        />
      </label>
      {props.selected.length === 0 && (
        <p className="hint" data-testid={`${p}destinations-empty`}>
          No vault selected. The gateway refuses a policy with no destinations.
        </p>
      )}
    </fieldset>
  );
}
