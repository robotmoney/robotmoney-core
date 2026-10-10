// The one source of truth for the chain ids and the timelock delay floors. No other file under src defines or compares against these literals
// (tests/constants-single-source.test.ts fails if one appears). The Solidity twin is DeployTimelock.s.sol MIN_PRODUCTION_DELAY and MIN_REHEARSAL_DELAY, pinned equal by the same test.
export const MAINNET_CHAIN_ID = 8453;
export const TWIN_CHAIN_ID = 918453;
export const MAINNET_DELAY_FLOOR = 172800;

/**
 * The deployment kind (issue 1727). `production` is the default and the only kind that ever launches. `rehearsal` is an explicit, sheet-only mode
 * (DEPLOYMENT_KIND=rehearsal) for a Base mainnet REHEARSAL with a short timelock delay. It is never read from the process environment or a CLI flag.
 */
export type DeploymentKind = "production" | "rehearsal";
export const DEPLOYMENT_KINDS: readonly DeploymentKind[] = ["production", "rehearsal"];
/** The timelock delay floor of a rehearsal (15 minutes), on every chain. A rehearsal delay is also always below MAINNET_DELAY_FLOOR (see rehearsalDelayProblem). */
export const REHEARSAL_DELAY_FLOOR = 900;

export const isMainnet = (chainId: number): boolean => chainId === MAINNET_CHAIN_ID;
/**
 * The timelock delay floor. Production: 172800 s on 8453, at least 1 s on any other chain (unchanged). Rehearsal: 900 s on every chain.
 * Every caller passes the kind explicitly from the sheet, so omitting it can only ever give the PRODUCTION floor.
 */
export const delayFloor = (chainId: number, kind: DeploymentKind = "production"): number =>
  kind === "rehearsal" ? REHEARSAL_DELAY_FLOOR : isMainnet(chainId) ? MAINNET_DELAY_FLOOR : 1;

/** A rehearsal timelock delay is 900 s up to just under the production floor, so the delay on chain always agrees with the kind. Empty string when it does. */
export function rehearsalDelayProblem(delay: bigint | number): string {
  const d = BigInt(delay);
  if (d < BigInt(REHEARSAL_DELAY_FLOOR)) return `${d} is below the rehearsal floor ${REHEARSAL_DELAY_FLOOR}`;
  if (d >= BigInt(MAINNET_DELAY_FLOOR)) return `${d} is at or above the production floor ${MAINNET_DELAY_FLOOR}: a rehearsal-kind run carries a delay below it, otherwise the chain cannot tell it from production`;
  return "";
}

/** The label the verifier, the evidence and the logs carry: the kind and the delay, for example `[rehearsal 900s]`. */
export const kindLabel = (kind: DeploymentKind, delay: number | bigint): string => `[${kind} ${delay}s]`;
