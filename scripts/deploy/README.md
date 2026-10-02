# Core stage table

`stage-table.json` is the one source of truth for the core deploy. Core's runner (`core-stages.ts`) and devops publish-contracts both read it. Devops reads it from the core checkout at `DEPLOY_SHA` and keeps no script, env, artifact or manifest names of its own.

`stage-table.test.ts` (bun test) checks the table against the real scripts: every script file and contract exists, every `requiredEnv` name is read by its script, every manifest name is written by it, and no deploy script lacks a stage.

## Schema (version 1)

- `stages[]`, in deploy order:
  - `name`: `libs|vault|registry|router|gateway|governance|ic-policy|proto|agent|rwa|timelock`.
  - `kind`: always `forge`.
  - `script`: `contracts/script/<File>.s.sol:<Contract>`.
  - `requiredEnv`: names the script reads with no default. Some are fed by earlier manifests (for example `REGISTRY_ADDRESS`).
  - `optionalEnv`: names the script reads with a default.
  - `manifest`: template `deployments/<chain>/<file>.json`. Replace `<chain>` with the chain id. The driver sets `DEPLOYMENT_OUT` to this file.
  - `libraries`: names from the top-level `libraries` to link with `forge script --libraries`. Empty when none.
  - `vault`: `USDC|PROTO|AGENT|RWA` for a vault stage, else `null`.
- `vaults[]`: `{ key, stage, artifact, manifest }`. `artifact` is the forge contract name for code-hash checks (`RwaBasketVault` for rmRWA).
- `libraries[]`: `{ name, artifact, manifestKey, path }`. `manifestKey` is the key the libs manifest holds the address under. `path` is the source file for `--libraries path:artifact:address`.
- `artifacts`: forge contract names for `gateway`, `router`, `registry`, `governance`, `timelock`, `icPolicy`, `receipt`.

Run order, manifest keys and per-stage wiring between stages live in `core-stages.ts` (the runner), not in the table.
