// Issue 1927: the runbook 4.15 command list the Twin driver (twin-upgrade-from-v050.ts) runs, with no dependency: the runbook validator's tests import it in a job that never ran
// `bun install` in publish-contracts (scripts/runbook/validate-contract-qa.test.ts), and upgrade-runbook-drift.test.ts holds the runbook equal to it.
/** The release the job publishes first, and the commit its tag names (the live Deploy 3 contracts). */
export const V050_TAG = "release/v0.5.0-rehearsal";
export const V050_SHA = "57fbe61833e9d7f94557d69102138f7c410c1346";
/** The pool liquidity floor of the rmAGENT asset in the v0.5.0 Twin sheet. The job refuses a sheet with any other value: the floor is never lowered (issue 1903, ADR-0016). */
export const AGENT_POOL_FLOOR = "1000000000000000";
/** The vector that stays after the retire (runbook 4.14 and 4.15). */
export const RETIRE_WEIGHTS = "USDC:9500,PROTO:500,RWA:0";

/**
 * The publish-contracts commands of runbook 4.15, in order, as the runbook spells them. upgrade-runbook-drift.test.ts requires the section's command lines to equal this list. `$COMMON`
 * carries --core-dir and --core-sha of the v0.5.0 checkout; `"$PWD"` is the rc (here: the qa) checkout the CLI runs from.
 */
export const UPGRADE_FROM_V050_COMMANDS: readonly string[] = [
  `bun publish-contracts/src/cli.ts deploy-implementation --proxy gateway --upgrade-build "$PWD" $COMMON`,
  `bun publish-contracts/src/cli.ts govern --row upgrade-proxy --proxy gateway --implementation $GATEWAY_IMPL --upgrade-build "$PWD" $COMMON`,
  `bun publish-contracts/src/cli.ts deploy-implementation --proxy receipt --upgrade-build "$PWD" $COMMON`,
  `bun publish-contracts/src/cli.ts govern --row upgrade-proxy --proxy receipt --implementation $RECEIPT_IMPL --migration receipt-submitter-roles --upgrade-build "$PWD" $COMMON`,
  `bun publish-contracts/src/cli.ts govern --row retire-vault --admin-arg vault=$RMAGENT --admin-arg weights=${RETIRE_WEIGHTS} $COMMON`,
  `bun publish-contracts/src/cli.ts verify $COMMON`,
  `bun publish-contracts/src/evidence-check.ts --governed-upgrades $EVIDENCE/publish-run.json --deployment-kind rehearsal --timelock $TIMELOCK --governance $GOVERNANCE --rpc $BASE_RPC_URL`,
  `bun publish-contracts/src/evidence-check.ts --vault-retirements $EVIDENCE/publish-run.json --deployment-kind rehearsal --registry $REGISTRY --timelock $TIMELOCK --rpc $BASE_RPC_URL`,
];

/**
 * Review-operations-001: the environment the 4.15 commands read besides their arguments. Runbook 4.15 exports each (upgrade-runbook-drift.test.ts), and the Twin driver sets each:
 * the Deploy 3 stage manifests are not under the clean v0.5.0 checkout, so PUBLISH_MANIFEST_DIR names their directory.
 */
export const UPGRADE_FROM_V050_ENV = ["PUBLISH_MANIFEST_DIR"] as const;
