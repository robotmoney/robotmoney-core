# Core stage table

`stage-table.json` is the one source of truth for the core deploy. Core's runner (`core-stages.ts`) and devops publish-contracts both read it. Devops reads it from the core checkout at `DEPLOY_SHA` and keeps no script, env, artifact or manifest names of its own.

`stage-table.test.ts` (bun test) checks the table against the real scripts: every script file and contract exists, every `requiredEnv` name is read by its script, every manifest name is written by it, and no deploy script lacks a stage.

## Schema (version 1)

- `stages[]`, in deploy order:
  - `name`: `libs|vault|registry|router|gateway|governance|ic-policy|proto|agent|rwa|timelock`.
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

Run order, manifest keys and per-stage wiring between stages live in `core-stages.ts` (the runner), not in the table.

## Required env (no defaults)

Every name in `requiredEnv` is read with no fallback. An unset or malformed value reverts the stage. The table lists them per stage. Names that used to default and are now required:

- `DEPLOYMENT_OUT` for every stage. The core runner sets it. A devops caller that runs a script directly must set it too. There is no `deployments/<vault>-<chainid>.json` default.
- `vault`: `SEED_DEPOSIT_USDC` (non-zero, 6-decimal units) and `VAULT_EXIT_FEE_BPS`.
- `governance`: `QUORUM_THRESHOLD` (greater than 1), `VOTING_PERIOD` and `EXECUTION_DELAY` (seconds, at least the contract minimum).
- `proto`, `agent`, `rwa`: `EXIT_FEE_BPS`.

The `vault` manifest (`vault.json`) exposes the seed result: `seed_share_receiver`, `seed_shares` and `deployer_share_balance_after` (always 0, read from the vault after the seed). `SEED_SHARE_RECEIVER` is never zero and never the deployer.

For devops: verify must assert `deployer_share_balance_after == 0` in the manifest, and must read `vault.balanceOf(deployer) == 0` and `vault.balanceOf(seed_share_receiver) >= seed_shares` on chain.

The frozen sheet must carry a value for each of these. `0` is a valid exit fee. `optionalEnv` now holds only `EXPECTED_CHAIN_ID` and `VAULT_NAME`.
