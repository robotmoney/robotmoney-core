// The govern row `clear-voted-weights` (issue 1743): the Safe, through the timelock, clears the router's VOTED weight vector so routing falls back to the DEFAULT vector.
// A voted vector (PortfolioRouter.setWeights, or a passed RouterGovernance proposal) overrides the default while votedWeightsActive is true. The deploy no longer leaves one,
// but the first Base mainnet deployment did (its router stage called setWeights), and a vote can set one later. apply-receipt writes the DEFAULT vector, so it refuses while one is active.
// One call: RouterGovernance.clearVotedWeights() (onlyRole(ADMIN_ROLE), held by the timelock), which forwards to PortfolioRouter.clearVotedWeights() (onlyRole(ADMIN_ROLE), held by
// RouterGovernance). No contract change: both functions exist on today's bytecode. This module is pure: it reads no chain and sends nothing.
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";

export const CLEAR_ROW = "clear-voted-weights";
export const GOVERNANCE_CLEAR_ABI = parseAbi(["function clearVotedWeights()"]);

/** The run-manifest key of the row. A later round (a vote set a voted vector again) is `clear-voted-weights:round-N`, like the unpause rows. */
export const CLEAR_RECORD_KEY = CLEAR_ROW;

/** The one call of a clear round: clearVotedWeights() on the deployed RouterGovernance. */
export function buildClearCall(governance: Address): { label: string; target: Address; data: Hex } {
  return { label: "governance.clearVotedWeights()", target: governance, data: encodeFunctionData({ abi: GOVERNANCE_CLEAR_ABI, functionName: "clearVotedWeights" }) };
}
export const clearCalldata = (): Hex => encodeFunctionData({ abi: GOVERNANCE_CLEAR_ABI, functionName: "clearVotedWeights" });

const lc = (x: string): string => x.toLowerCase();
const key = (v: readonly string[], b: readonly (bigint | number)[]): string => v.map((a, k) => `${lc(a)}:${b[k]}`).join(",");

/** Read-back problems: no voted vector is active and the EFFECTIVE weights equal the DEFAULT weights. An empty list is a pass. */
export function clearReadBackProblems(r: { votedWeightsActive: boolean; defaultVaults: readonly string[]; defaultBps: readonly bigint[]; effectiveVaults: readonly string[]; effectiveBps: readonly bigint[] }): string[] {
  const bad: string[] = [];
  if (r.votedWeightsActive) bad.push("router.votedWeightsActive() is still true");
  const d = key(r.defaultVaults, r.defaultBps), e = key(r.effectiveVaults, r.effectiveBps);
  if (e !== d) bad.push(`router.getEffectiveWeights() is [${e}], want the default [${d}]`);
  return bad;
}
