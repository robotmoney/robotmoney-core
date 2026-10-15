// Canonical: docs/technical/contract-upgradeability-plan.md — Release modes and proof

/**
 * GatewayUpgradeStatus — public disclosure of the gateway's upgradeability
 * (issue 1810), read live from the chain by the gateway verifier: the ERC-1967
 * implementation behind the proxy and whether upgrades are permanently frozen.
 *
 * Shown only once verification passed, so the implementation it names is the
 * pinned one. A direct (non-proxy) gateway has no upgrade path. A freeze state
 * that could not be read is said to be unknown, never assumed.
 */
import type { VerificationState } from "../lib/gatewayVerifier";

type Props = Readonly<{ state: VerificationState }>;

export function GatewayUpgradeStatus({ state }: Props) {
  if (state.status !== "verified" || state.implementation === undefined) return null;
  if (state.implementation === null) {
    return (
      <p data-testid="gateway-upgrade-status" data-upgrade-state="direct" className="hint">
        Gateway: direct deployment, not upgradeable.
      </p>
    );
  }
  const upgradeState =
    state.upgradesFrozen === true
      ? "frozen"
      : state.upgradesFrozen === false
        ? "upgradeable"
        : "unknown";
  return (
    <p data-testid="gateway-upgrade-status" data-upgrade-state={upgradeState} className="hint">
      Gateway implementation{" "}
      <span data-testid="gateway-implementation" className="font-mono">
        {state.implementation}
      </span>
      {" — "}
      <span data-testid="gateway-freeze-state">
        {upgradeState === "frozen" && "upgrades permanently frozen."}
        {upgradeState === "upgradeable" &&
          `upgradeable through the timelock${
            state.upgradeTimelock ? ` ${state.upgradeTimelock}` : ""
          }.`}
        {upgradeState === "unknown" && "freeze state unknown."}
      </span>
    </p>
  );
}
