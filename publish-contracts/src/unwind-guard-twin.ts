// The govern arguments of one Twin or stage guard round for the row `set-unwind-guard` (see unwind-guard.ts for the row). No dependency (no viem): scripts/stage/core-stack.ts
// imports this and must resolve without a `bun install` in publish-contracts. unwind-guard.ts re-exports it.
export const UNWIND_GUARD_ROW = "set-unwind-guard";
/**
 * The values the Twin and the stage chain set on every basket stage 13 opened (`token=all`): the baskets hold nothing there, so these prove the row and the verifier label
 * on the real contracts and are never a sizing. On 8453 the operator sizes min-usdc-out from each vault's holding (runbook). Shared by ci/twin-publish.ts and
 * `scripts/stage/core-stack.ts governance ensure`, so the two flows cannot drift.
 */
export const TWIN_UNWIND_MIN_USDC_OUT = "1000000";
export const TWIN_UNWIND_MAX_LOSS_BPS = "500";
/** The govern arguments of one Twin or stage guard round for one basket vault (every active asset, the values above). */
export const twinUnwindGuardArgs = (vault: string): string[] => ["--row", UNWIND_GUARD_ROW, "--admin-arg", `vault=${vault}`, "--admin-arg", "token=all",
  "--admin-arg", `min-usdc-out=${TWIN_UNWIND_MIN_USDC_OUT}`, "--admin-arg", `max-loss-bps=${TWIN_UNWIND_MAX_LOSS_BPS}`];
