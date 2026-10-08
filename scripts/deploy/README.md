# Core stage table

`stage-table.json` is the one source of truth for the core deploy. It is DATA. The one deploy driver, the publish-contracts CLI (`bun publish-contracts/src/cli.ts`, in this repo), reads it from the repo root and keeps no script, env, artifact or manifest names of its own. Devops checks core out and runs the same CLI. There is no other runner.

`stage-table.test.ts` (bun test) checks the table against the real scripts: every script file and contract exists, every `requiredEnv` name is read by its script, every manifest name is written by it, and no deploy script lacks a stage.

## Schema (version 1)

- `stages[]`, in deploy order:
  - `name`: `libs|recorder|vault|registry|router|gateway|governance|ic-policy|proto|agent|rwa|timelock`.
  - `kind`: always `forge`.
  - `script`: `contracts/script/<File>.s.sol:<Contract>`.
  - `requiredEnv`: names the script reads with no default. This includes `DEPLOYMENT_OUT`. Some are fed by earlier manifests (for example `REGISTRY_ADDRESS`).
  - `optionalEnv`: names the script may read but does not need (no value here changes a deploy parameter).
  - `manifest`: template `deployments/<chain>/<file>.json`. Replace `<chain>` with the chain id. The driver sets `DEPLOYMENT_OUT` to this file.
  - `libraries`: names from the top-level `libraries` to link with `forge script --libraries`. Empty when none.
  - `vault`: `USDC|PROTO|AGENT|RWA` for a vault stage, else `null`.
- `vaults[]`: `{ key, stage, artifact, manifest }`. `artifact` is the forge contract name for code-hash checks (`RwaBasketVault` for rmRWA).
- `libraries[]`: `{ name, artifact, manifestKey, path }`. `manifestKey` is the key the libs manifest holds the address under. `path` is the source file for `--libraries path:artifact:address`.
- `artifacts`: forge contract names for `gateway`, `router`, `registry`, `governance`, `timelock`, `icPolicy`, `receipt`.

Run order is the table order. The per-stage wiring (which manifest key feeds which env name) lives in `publish-contracts/src/core-wiring.ts`, not in the table. The post-stage proofs (router wiring, basket vault config, timelock roles) are labels of the one verifier (`publish-contracts/src/verify`).

## Stage 13 (govern)

`stage-table.json` carries a `govern` block that describes stage 13: after the timelock handover the only mainnet operation is the unpause of each basket vault (`mainnetRows`), one timelock operation per unpause, all scheduled in one sitting, one 48 hour wait. Voting power, quorum, voting period, execution delay, vault setters, router eligibility and router default weights are deploy-time configuration set in stages 4 to 10 (router through rwa) and asserted by the verify stage. `update-delay`, `batch` and `cancel` (`twinOnlyRows`) run on the Twin fork only. `stage-table.test.ts` asserts the description.

## Required env (no defaults)

Every name in `requiredEnv` is read with no fallback. An unset or malformed value reverts the stage. The table lists them per stage. Names that used to default and are now required:

- `DEPLOYMENT_OUT` for every stage. The publish-contracts CLI sets it. Anyone who runs a script directly must set it too. There is no `deployments/<vault>-<chainid>.json` default.
- `vault`: `SEED_DEPOSIT_USDC` (non-zero, 6-decimal units) and `EXIT_FEE_BPS`.
- `governance`: `QUORUM_THRESHOLD` (greater than 1), `VOTING_PERIOD` and `EXECUTION_DELAY` (seconds, at least the contract minimum), `VOTER_ADDRESSES` and `VOTER_POWER` (the deployer sets the voting power of each voter before the timelock handover).
- `registry`: `VAULT_NAME` (the registered name comes from the sheet; there is no default).
- `proto`, `agent`, `rwa`: the same four names as `vault` (`FEE_RECIPIENT`, `TVL_CAP`, `PER_DEPOSIT_CAP`, `EXIT_FEE_BPS`) and `ROUTER_DEFAULT_BPS`: `none` leaves the basket router-ineligible, otherwise a comma list of bps for the router default vector after this basket flips eligible (rmUSDC, the eligible baskets so far, this vault). The stage makes the basket eligible and sets that vector in one atomic `registry.migrateEligibility`, before the timelock handover.
- `recorder` (core 1676) reads only `DEPLOYMENT_OUT`: it deploys the permissionless Uniswap V4 price recorder for the UniswapV4 entry of `config/agent-token-shortlist.json`, grows its ring to 901 slots and records the first snapshot. `agent` reads `RECORDER_ADDRESS` (the recorder stage manifest's `recorder`); the other basket stages ignore it. The runner waits for a full 1800 s window of recorder history before the `agent` stage.
- `proto`, `agent`, `rwa` also read `NAV_DEVIATION_BPS` (1 to 2000, never 0: the vault default 0 disables the ORA-4 deposit check; the script calls `setNavDeviationGuardBps` before the handover and reads it back) and `MIN_POOL_LIQUIDITY` (above 0, a floor for the pool's in-range liquidity: `IUniswapV3Pool.liquidity()` for a V3 pool and the V4 pool's liquidity L (`StateView.getLiquidity`) for a V4 pool, a uint128 L and not a USDC amount; every configured pool must meet it). The sheet names are `VAULT_<PROTO|AGENT|RWA>_NAV_DEVIATION_BPS` and `VAULT_<PROTO|AGENT|RWA>_MIN_POOL_LIQUIDITY`. rmUSDC has neither (issue 1666).

The `vault` manifest (`vault.json`) exposes the seed result: `seed_share_receiver`, `seed_shares` and `deployer_share_balance_after` (always 0, read from the vault after the seed). `SEED_SHARE_RECEIVER` is never zero and never the deployer.

For devops: verify must assert `deployer_share_balance_after == 0` in the manifest, and must read `vault.balanceOf(deployer) == 0` and `vault.balanceOf(seed_share_receiver) >= seed_shares` on chain.

The frozen sheet must carry a value for each of these. `0` is a valid exit fee. `optionalEnv` now holds only `EXPECTED_CHAIN_ID`.

## One env-name set for every vault

rmUSDC (`vault`) and the three basket vaults (`proto`, `agent`, `rwa`) read the same four names: `TVL_CAP`, `PER_DEPOSIT_CAP`, `EXIT_FEE_BPS`, `FEE_RECIPIENT`. The old `VAULT_TVL_CAP`, `VAULT_PER_DEPOSIT_CAP`, `VAULT_EXIT_FEE_BPS` and `FEE_RECIPIENT_ADDRESS` are gone. No script has a default cap or recipient. A missing or malformed value reverts. The registry stage requires `VAULT_NAME`.

## config-check CLI (devops calls this)

`scripts/ci/config-check.ts` is a read-only check of `config/` against a live chain. It never sends a transaction.

```
bun scripts/ci/config-check.ts --rpc <url> [--config-dir <dir>] [--chain <id>] [--out-dir <dir>]
bun scripts/ci/config-check.ts --offline [--config-dir <dir>]
bun scripts/ci/config-check.ts --rpc <base mainnet url> --print-usdc-hashes
```

- `--rpc`: JSON-RPC URL of the target chain. Required unless `--offline`.
- `--config-dir`: directory with the config JSON files. Default: `<repo>/config`.
- `--chain`: chain id the RPC must report. Default 8453. Use 918453 for the Twin chain.
- Exit codes: `0` every check passed, `1` a check failed (or the RPC failed), `2` usage error.
- Output: `config-check-block-<N>.json` in `--out-dir`.

Live checks: code at USDC, the factory and the router, each pool's fee, factory `getPool`, observation cardinality, liquidity and the TVL floor. rmRWA has no oracle, so there is no oracle-band check.

### USDC code-hash check

USDC is one constant on every chain, so the check runs on every chain. The proxy code hash at the USDC address and the implementation code hash behind its FiatTokenProxy implementation slot must equal the values pinned in `config/usdc-hashes.json`. A mock token at the USDC address fails. A `null` pin is refused. Pin the two values once from Base mainnet with `--print-usdc-hashes`, review the diff, and commit. Re-pin only after an owner-approved USDC upgrade.

## CI

`suite-28-core-stages.yml` runs `bun test scripts/deploy scripts/ci` (this table against the real scripts) and the publish-contracts package tests. The Twin chain workflows call `bun publish-contracts/src/cli.ts publish` (through `.github/actions/twin-publish`) with `--chain 918453 --rpc $TWIN_RPC_URL`. The deleted-path gate (`bun scripts/stage/check-deleted-stage-scripts.ts .`) keeps the old runner and its assert scripts absent. `bun scripts/ci/check-no-devops-dependency.ts` keeps core free of any dependency on devops: devops checks core out, never the reverse.
