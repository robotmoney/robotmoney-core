# Core stage table

`stage-table.json` is the one source of truth for the core deploy. It is DATA. The one deploy driver, the publish-contracts CLI (`bun publish-contracts/src/cli.ts`, in this repo), reads it from the repo root and keeps no script, env, artifact or manifest names of its own. Devops checks core out and runs the same CLI. There is no other runner.

`stage-table.test.ts` (bun test) checks the table against the real scripts: every script file and contract exists, every `requiredEnv` name is read by its script, every manifest name is written by it, and no deploy script lacks a stage.

## Schema (version 1)

- `stages[]`, in deploy order:
  - `name`: `libs|recorder|authority|vault|registry|router|gateway|governance|ic-policy|proto|agent|rwa|timelock`.
  - `kind`: always `forge`.
  - `script`: `contracts/script/<File>.s.sol:<Contract>`.
  - `requiredEnv`: names the script reads with no default. This includes `DEPLOYMENT_OUT`. Some are fed by earlier manifests (for example `REGISTRY_ADDRESS`).
  - `optionalEnv`: names the script may read but does not need (no value here changes a deploy parameter).
  - `manifest`: template `deployments/<chain>/<file>.json`. Replace `<chain>` with the chain id. The driver sets `DEPLOYMENT_OUT` to this file.
  - `libraries`: names from the top-level `libraries` to link with `forge script --libraries`. Empty when none.
  - `vault`: `USDC|PROTO|AGENT|RWA` for a vault stage, else `null`.
- `vaults[]`: `{ key, stage, artifact, manifest }` and the vault's rules (issue 1705). `artifact` is the forge contract name for code-hash checks (`RwaBasketVault` for rmRWA). Every rule field is present on every vault, with no default:
  - `deployPaused`: the vault stage leaves deposits paused (`true` on all four, core 1710).
  - `unpauseRow`: the govern row that opens the vault, always `unpause-<key>`.
  - `unpauseInStage13`: stage 13 runs that row. On 8453 the sheet's `GOVERN_UNPAUSE_VAULTS` must list every such vault.
  - `seed`: `none`, or `sheet:<ENV>`, the env name the vault stage reads the seed amount from (rmUSDC: `sheet:SEED_DEPOSIT_USDC`).
  - `eligibilitySource`: `router-stage` (the router stage makes the vault eligible) or `sheet:ELIGIBLE_VAULTS` (the vault's own stage, through `registry.migrateEligibility`).
  - `emergencyLevers`: every `EMERGENCY_ROLE` function of the vault contract, the levers that act without the timelock.
  - `registryNameSource`: `sheet:<ENV>` (a stage registers the vault under that env value) or `script:<CONSTANT>` (the vault script's own constant).
- `vaultRuleDecisions`: for each rule field on which the vaults differ, the decision behind the difference (an issue number or an owner decision). The parser refuses a difference with no decision. The publish-contracts CLI derives its govern rows, evidence steps and verifier expectations from these rules (`publish-contracts/src/vault-rules.ts`), and refuses a `--core-dir` checkout whose table carries other rules. `stage-table.test.ts` ("vault rules") checks each rule against the scripts and contracts, and `contracts/test/FourVaultInitialState.t.sol` runs the four vault stages in process and compares `depositsPaused()` with `deployPaused`.
- `libraries[]`: `{ name, artifact, manifestKey, path }`. `manifestKey` is the key the libs manifest holds the address under. `path` is the source file for `--libraries path:artifact:address`.
- `artifacts`: forge contract names for `gateway`, `router`, `registry`, `governance`, `timelock`, `icPolicy`, `receipt`.
- `proxies` (issue 1809, ADR-0014 §1): the nine contracts that run behind their own `ERC1967Proxy`, each `{ name, stage, field, implementationField, artifact }`: the stage that deploys it, the manifest field of the proxy address and of the implementation behind it, and the implementation's build artifact. `name` is the verifier label (`proxy[<name>]`) and the `--admin-arg proxy=<name>` of the `upgrade-proxy` and `freeze-proxy` govern rows. The list equals `contracts/test/fixtures/storage-layout/proxied.txt` (the storage-layout gate's list). Every proxy stage must require `UPGRADE_AUTHORITY` and `UPGRADE_MODE` (the parser refuses a table that would deploy a proxy with an undeclared authority or mode) and writes `upgrade_authority` and `upgrade_mode` next to the proxy and the implementation.
- `proxyArtifact`: the build every proxy's runtime code must equal (`ERC1967Proxy`). Required when `proxies` lists any.

Run order is the table order. The per-stage wiring (which manifest key feeds which env name) lives in `publish-contracts/src/core-wiring.ts`, not in the table. The post-stage proofs (router wiring, basket vault config, timelock roles) are labels of the one verifier (`publish-contracts/src/verify`).

## Stage 13 (govern)

`stage-table.json` carries a `govern` block that describes stage 13: after the timelock handover the only mainnet operation is the unpause of each of the four vaults, rmUSDC included, because all four deploy paused (`mainnetRows`), one timelock operation per unpause, all scheduled in one sitting, one 48 hour wait. Vault setters, router eligibility and router default weights are deploy-time configuration set in stages 4 to 10 (router through rwa) and asserted by the verify stage. Router weights change on demand through the govern row `apply-receipt` (core 1696): the Safe, through the timelock, releases the Investment Committee's consensus receipt and applies its weights in one timelock call, `RouterGovernance.applyReceipt` (issue 1698). There is no voting by anyone. `update-delay`, `batch` and `cancel` (`twinOnlyRows`) run on the Twin fork only. `stage-table.test.ts` asserts the description.

## The authority stage and the proxies (issue 1809, ADR-0014 §4)

`authority` runs right before the first proxy stage (`vault`). Its script, `DeployUpgradeAuthority.s.sol`, deploys only the `ProposerFloorTimelock` every proxy names as its upgrade authority (the Safe its one proposer and canceller, the executor open, no admin), with the handover's Safe and delay checks, and writes `upgrade-authority.json` (`timelock`, `timelock_codehash`, `safe`, `min_delay`, `deployment_kind`). It grants no role on any Robot Money contract. Every proxy stage reads that timelock as `UPGRADE_AUTHORITY` and the sheet's `UPGRADE_MODE` (`upgradeable` or `frozen-at-deploy`, no default); the `vault` stage also reads `EXCLUSION_LEDGER_FACTORY` (the libs manifest's `exclusion_ledger_factory`). The handover stage (`timelock`) reads the same timelock as `TIMELOCK_ADDRESS`, reuses it, and refuses unless every proxy it hands over names it. So the deployer never holds an upgrade path, not even between stages. The publish-contracts runner reads every proxy back right after its stage (implementation slot, empty admin and beacon slots, authority, mode, frozen flag, initialization) and stops the run on any miss.

## Required env (no defaults)

Every name in `requiredEnv` is read with no fallback. An unset or malformed value reverts the stage. The table lists them per stage. Names that used to default and are now required:

- `DEPLOYMENT_OUT` for every stage. The publish-contracts CLI sets it. Anyone who runs a script directly must set it too. There is no `deployments/<vault>-<chainid>.json` default.
- `vault`: `SEED_DEPOSIT_USDC` (non-zero, 6-decimal units) and `EXIT_FEE_BPS`.
- `governance`: `ADMIN_ADDRESS` and `ROUTER_ADDRESS` only. The stage deploys the weight setter (`RouterGovernance`) with no voting surface (issue 1698): no voter list, voting power, quorum, voting period or execution delay exists. There is no voting by anyone. Router weights change on demand when the Safe, through the timelock, applies a consensus receipt with one `RouterGovernance.applyReceipt(receiptId, payloadDigest, vaults, bps)` call (the `apply-receipt` govern row, core 1696). Stage 11 points the weight setter at the `ConsensusRecommendationReceipt` (`setReceiptContract`) and grants it the register's `ADMIN_ROLE`, so the one call releases the receipt and sets the router weights together.
- `registry`: `VAULT_NAME` (the registered name comes from the sheet; there is no default).
- `proto`, `agent`, `rwa`: the same four names as `vault` (`FEE_RECIPIENT`, `TVL_CAP`, `PER_DEPOSIT_CAP`, `EXIT_FEE_BPS`) and `ROUTER_DEFAULT_BPS`: `none` leaves the basket router-ineligible, otherwise a comma list of bps for the router default vector after this basket flips eligible (rmUSDC, the eligible baskets so far, this vault). The stage makes the basket eligible and sets that vector in one atomic `registry.migrateEligibility`, before the timelock handover.
- `recorder` (core 1676) reads only `DEPLOYMENT_OUT`: it deploys the permissionless Uniswap V4 price recorder for the UniswapV4 entry of `config/agent-token-shortlist.json`, grows its ring to 7,201 slots (the 4 hour USDC sell anchor at 2 s blocks, core 1793) and records the first snapshot. `agent` reads `RECORDER_ADDRESS` (the recorder stage manifest's `recorder`); the other basket stages ignore it. The runner waits for a full 1800 s window of recorder history before the `agent` stage.
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
