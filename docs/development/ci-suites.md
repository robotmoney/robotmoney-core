# CI Suite Inventory

Each section is one GitHub Actions workflow file. Steps are listed in
execution order as they appear (or should appear) in the job.

The CI job has no special devnet setup step — the test suite itself starts
and tears down the Docker Compose stack whenever it needs a clean slate.

## Foundry version

Two places pin one exact Foundry release, **`v1.8.5`**:

- every "Install Foundry" step of suite 11b
  (`suite-11b-opencode-headless.yml`: the `refusal`, `deposit` and `read` jobs);
- `.github/actions/twin-fork/action.yml`, the action that starts the Twin
  chain. Its install runs after any earlier one in the job and wins on `PATH`,
  so every `anvil`, `cast` and `forge` call after the fork starts, in every
  Twin chain job of every suite, is `v1.8.5`.

Every other `foundry-rs/foundry-toolchain@v1` step in `.github/workflows/`
installs the floating `stable` release. For `generated-docs-freshness` (suite
13) that is deliberate: its expected value is what the current `forge doc`
emits, and its step comment says not to re-pin without regenerating
`contracts/doc/`.

Why suite 11b pins: a floating `stable` moved its `cast` from 1.7.1 to 1.8.1
on 2026-09-05. cast 1.8 changed `cast wallet new --json` from a bare array to
`{"schema_version":1,"success":true,"data":[{…}]}`, the workflow's
`jq '.[0].private_key'` exited 5, and the deposit replay was red every day
after with no repo change (issue #1682). The step now reads the wallet through
`.github/scripts/parse_cast_wallet_new.py`, which accepts both shapes.
`.github/scripts/tests/test_parse_cast_wallet_new.py` (suite 11b
`asserter-tests`, which runs on any PR touching the workflow, the parser or
the twin-fork action) fails when either place installs Foundry without an
exact `vX.Y.Z` tag, or when the two pins differ. Bump them together.

History: Foundry 1.8.0 replaced `forge doc`'s mdbook generator with a
[vocs](https://vocs.dev) site generator and changed how `forge fmt` indents a
struct literal inside a broken method chain. Both changes are silent (`forge
doc` still exits 0), so the release turned `generated-docs-freshness` and
`solidity-lint` red on `dev` with no repo change (issue #1263). Every workflow
was pinned to `v1.7.1` as containment. Issue #1264 regenerated
`contracts/doc/` in the vocs layout, taught the freshness comparator the new
path, and removed that pin everywhere.

Locally: any Foundry ≥ 1.8.0 regenerates `contracts/doc/` in the layout the
freshness comparator expects. Foundry ≤ 1.7.1 emits the mdbook layout, which
the comparator refuses to compare (it names the mismatch rather than reporting
stale docs). For Twin chain work, match CI with `foundryup --install v1.8.5`.

## Environment key

| Symbol | Meaning |
|--------|---------|
| `devnet` | The Twin chain (id 918453): a pinned lazy anvil fork of real Base state, started by `.github/actions/twin-fork` (`scripts/devnet/twin-fork.ts`). One pin per workflow run. The Rust harness reuses it through `TWIN_RPC_URL` or starts its own. No geth, no lighthouse, no genesis snapshot (core 1498, 1496). Services that only need an RPC (explorer-indexer, dapp) point at `TWIN_RPC_URL`. |
| `anvil` | In-process Anvil EVM. No Docker. |
| `fork` | A local anvil forked from the Twin fork (`RMPC_FORK_RPC_URL=$TWIN_RPC_URL`, `RMPC_FORK_BLOCK=$TWIN_PIN_BLOCK`) so each test can warp and rewind without touching the shared chain. The saved `.anvil-state` fixture is not used by these suites. The forge golden fork tests of suites 1 and 2 still load it (ADR-0011). CI fails loudly if zero fork tests run; it never silent-skips. |
| `none` | No chain. Static analysis, pure unit tests, doc checks. |

---

## Suites

### 1–2. Smart contract unit tests, invariant tests, and coverage gate
**Suggested file:** `.github/workflows/forge-tests.yml`
**Environment:** `anvil`
**Trigger paths:** `contracts/**`, `foundry.toml`

**Jobs:**
- `unit` — forge unit tests; runs immediately on trigger
- `invariant` — forge fuzz/invariant tests; runs in parallel with `unit`
- `coverage` — coverage gate check; **needs `unit` and `invariant`** (only worth running if tests pass)

**Steps — `unit` job:**
1. Checkout repository
2. Install Foundry toolchain
3. Cache Foundry build artifacts (`cache/`, `out/`)
4. `forge fmt --check`
5. `forge build`
6. `forge test` — unit tests: every public function, access control boundary, revert path, event emission, ERC-4626 rounding invariant
7. `forge test` (real-TVL pyramid, issue #592; three vaults since ADR-0017) — a dedicated, named
   step guards the real end state so it cannot silently regress:
   the basket vault script suites assert all four PRD §11 vaults deploy
   registered, paused and with config-equal assets (rmAGENT holds RM); `DeployBasketVaultRwa.t.sol` and
   `RwaBasketVaultFork.t.sol` cover the deSPXA basket row and its NAV against the pool TWAP; the
   `BasketVault`/`AgentTokenVault` suites pin per-vault basket composition.

**Steps — `invariant` job:**
1. Checkout repository
2. Install Foundry toolchain
3. Cache Foundry build artifacts (`cache/`, `out/`)
4. `forge build`
5. `forge test` with fuzzer enabled — invariant tests: share accounting, per-agent cap sequences, deposit monotonicity, reentrancy under malicious stub, pause invariant. It runs through `.github/scripts/forge_test_require_executed.sh` on `contracts/test/*Invariant*.t.sol` with `--match-test "^invariant_"`. `forge test` exits 0 when a path filter matches nothing, so the wrapper fails the job when no test passed (issue 1643). The same wrapper guards the per-file `--match-path` steps of the `unit` job. Step 6 runs its self-test, `.github/scripts/tests/test_forge_test_require_executed.sh`, which plants an empty `--match-path` and requires a red result.

**Steps — `coverage` job:**
1. Checkout repository
2. Install Foundry toolchain + Python
3. Cache Foundry build artifacts (`cache/`, `out/`)
4. `forge coverage` with `check_gateway_coverage.py` — enforces branch-coverage gate on `RobotMoneyGateway`

> **The coverage compile is memory-bound, and the budget is now gated (issue #1298).**
> `forge coverage` runs without `--ir-minimum`. That flag enables `viaIR`, whose peak
> RSS grows steeply with the compile set. Peak RSS of the whole coverage run with
> solc 0.8.24, measured on an unconstrained host:
>
> | compile set | `--ir-minimum` | peak RSS | wall |
> |---|---|---|---|
> | 174 files (`dev` @ `969cfc84`) | yes | 17.48 GiB | 7m12s |
> | 178 files (#1293 @ `3faeadd9`) | yes | 18.00 GiB | 9m30s |
> | 174 files | no | 2.27 GiB | 0m24s |
> | 178 files | no | 2.30 GiB | 1m10s |
>
> A GitHub-hosted `ubuntu-latest` runner has 16 GB, and **both `viaIR` figures are
> above it**. `dev` at 174 files survived only because the allocator reuses arenas
> under memory pressure instead of growing; PR #1293's four extra files were enough
> that it no longer could, and the runner was OOM-killed mid-compile at 7m26s of a
> 20-minute timeout. GitHub reports that as `The runner has received a shutdown
> signal` / `exit code 143`, which reads as infrastructure flake and invites a re-run
> that cannot succeed. The kill is **not** a timeout: the two deaths landed at 7m26s
> and 8m42s, different elapsed times, both far short of the 20-minute deadline.
>
> Nothing in `contracts/` needs `viaIR` to compile under coverage's unoptimised
> profile, and dropping it *raised* measured branch coverage (49.0% → 58.5%) because
> `--ir-minimum`'s degraded source mappings were losing branch hits. Two exclusions
> that existed only as `--ir-minimum` workarounds — `^test_getPastVotes_` (AZ-GOV-1)
> and `CustodyInvariantGuardTest` (issue #944) — were removed at the same time, so the
> coverage set grew rather than shrank.
>
> Dropping `viaIR` also collapses the job's sensitivity to compile-set size, from
> ~133 MB per added Solidity file to ~7.7 MB.
>
> The step runs under `.github/scripts/run_coverage_memory_guard.py`, which measures
> the run's peak RSS and **fails the job above 50% of runner RAM**. That is deliberate:
> the next contract-adding PR should meet an explanatory red gate with the number in
> it, not rediscover the cliff as an unfixable "flake". Raising the ceiling is a
> deliberate act (`COVERAGE_MEM_CEILING_PCT`), not a default.

#### Fork tests on the Twin chain (core 1498, 1496; replaces the live-RPC steps of issue #1239)

The `fork-regressions` job (`forge-fork-vault-regressions`) runs the forge fork tests (`VaultForkRegressions`, `DeploySeedDeposit`, `SafeIntegration`, `GovernanceExecutePathAfterHandover`, `RwaBasketVaultFork`, `CoreStagesFork`) on the Twin chain: a pinned lazy anvil fork of real Base state. There is no saved state file, no golden fixture and no live-RPC runner any more.

- **One pin.** The `twin-pin` job chooses the upstream head at the start of the run minus 2 (`.github/actions/twin-pin`). `fork-regressions` needs it and starts the fork with `.github/actions/twin-fork` at that block. Anvil's RPC cache is persisted per pin block.
- **Endpoint.** The upstream is the public `https://mainnet.base.org` (no key, no archive node). The optional secret `BASE_UPSTREAM_RPC` names a paid upstream. It is a secret, not a variable (this repo is public and GitHub does not mask `vars.*`), and the tools never print it. HTTP 429 is retried by anvil (`--retries`, `--fork-retry-backoff`, `--compute-units-per-second`) and by the tool at start up.
- **FORK_RPC_URL.** Every fork test reads it. Unset, the test skips with a named reason (`contracts/test/helpers/ForkSelect.sol`), so the plain unit run stays green on a machine with no chain. Set, an unreachable endpoint fails the test.
- **Runner.** `bun scripts/devnet/forge-fork-tests.ts -- <forge args>` sets `FORK_RPC_URL` to `$TWIN_RPC_URL` and fails a run in which no test executed (skips do not count).
- **Safe set.** `bun scripts/devnet/safe-set.ts` reads the canonical Safe v1.4.1 contracts from the chain and checks each code hash and the singleton lock (core 1447).
- **Clean room.** Each test deploys its own contracts through the production deploy scripts. None reads the live production v1 vault.
- **Deploy-gate entry.** `forge-fork-vault-regressions` is an optional entry in `scripts/ci/required-checks.json` (the deploy-sha gate list of `check-sha-green`): it depends on a public upstream that can rate limit, so a provider outage must not block a deploy sha.

The offline unit tests (`bun test scripts/devnet`) run in the `unit` job: the Twin fork tool, the Safe set check against a stub chain and the runner's executed-test counter.

---

### 3. Solidity quality gate
**Suggested file:** `.github/workflows/solidity-quality.yml`
**Environment:** `none`
**Trigger paths:** `contracts/**`, `foundry.toml`

**Jobs:**
- `lint` — fmt, build, NatSpec check; single job, runs immediately
- `slither` — static analysis; **needs `lint`** (avoids running expensive analysis on code that doesn't build or format-check)

**Steps — `lint` job:**
1. Checkout repository
2. Install Foundry toolchain
3. Cache Foundry build artifacts (`cache/`, `out/`)
4. `forge fmt --check` — formatting
5. `forge build --force` — clean build; zero warnings enforced via `--deny warnings` in `foundry.toml`
6. `forge doc --check` — NatSpec coverage threshold: every `external` and `public` function on `RobotMoneyGateway` must carry `@notice`, `@param`, and `@return` tags; script fails if any are missing

**Steps — `slither` job:**
1. Checkout repository
2. Install Foundry toolchain + Python + Slither
3. Cache Foundry build artifacts (`cache/`, `out/`)
4. `forge build` — produce artifacts for Slither
5. `slither .` — standard detector set (reentrancy, uninitialized storage, dangerous delegatecall, tx.origin, unchecked low-level calls)
6. Dependency audit — check imported OpenZeppelin and Aave interface versions against known-vulnerable releases

---

### 4. Rust quality gate
**Suggested file:** `.github/workflows/rust-quality.yml`
**Environment:** `none`
**Trigger paths:** `clients/rust-payment-client/**`, `testing/ethereum-testnet/e2e-rust/**`, `services/explorer-indexer/**`

**Jobs:**
- `lint` — fmt and clippy across all crates, plus the workspace logging-facade guard, the indexer embedded-migration parity guard and its rebuild-trigger test; runs immediately
- `audit` — dependency vulnerability scan; runs in parallel with `lint` (independent of build cache)
- `doc-coverage` — build and rustdoc threshold check; **needs `lint`** (avoids running a full build on code that fails style checks)
- `test-target-coverage` — every cargo integration-test target is executed by a workflow or allowlisted with a reason (issue #1282); pure Python, no toolchain, so it answers even when the Rust build is broken. See [Integration-test target coverage](#integration-test-target-coverage).

**Steps — `lint` job:**
1. Checkout repository
2. Install Rust toolchain + clippy
3. Cargo cache
4. `cargo fmt --check` — formatting across all crates
5. `cargo clippy --all-targets --all-features -- -D warnings` — zero warnings enforced. `--all-targets` is what type-checks every crate's `tests/` integration binaries; the root manifest is a virtual manifest with no `default-members`, so this one command covers every workspace member. **Do not drop `--all-targets`** — see [Rust `tests/` compile coverage](#rust-tests-compile-coverage) (issue #1295), which fails red if it is removed.
6. `cargo_test_require_executed.sh -p rmpc-logging --test workspace_uses_shared_facade` — every binary and service entrypoint initialises logging through `rmpc_logging::init_service` and not `tracing_subscriber::fmt()` (issue #247). Source-text walk, no chain, no Docker. It was executed by no workflow until issue #1282, so the regression it exists to make load-bearing was not.
7. `cargo_test_require_executed.sh -p explorer-indexer --test migration_set_parity` — the compile-time embedded migration set (`explorer_indexer::db::MIGRATOR`, produced by `sqlx::migrate!("./migrations")`) matches the on-disk `services/explorer-indexer/migrations/` directory: versions, descriptions and SQL text (issue #1416). On stable Rust that macro registers no `rerun-if-changed` for the directory it read — sqlx calls `proc_macro::tracked_path::path()` only under `sqlx_macros_unstable`. It expands each migration it found to `include_str!`, so rustc tracks edits and deletions, but a newly **added** `.sql` file is in no dep-info: before #1416 adding a migration did not force a rebuild, and with `Swatinem/rust-cache` restoring `target/` a PR that only added a migration could go green with that migration never compiled in. `services/explorer-indexer/build.rs` supplies the missing dependency. Filesystem walk plus an iteration over an embedded static, no Postgres, no Docker, no network. It lives in this LIGHT suite rather than [suite 8](#8-explorer-indexer-tests) precisely because suite 8 is `system-correctness` and skips draft PRs — a stale `target/` bites hardest during draft iteration.
8. `.github/scripts/tests/test_indexer_migration_rebuild_trigger.sh` — the behavioural half of step 7 (issue #1416). On a cold build the parity target passes with or without `build.rs`, so it cannot see the trigger go missing. With `target/` warm from step 7, this script adds, edits, reverts and deletes a migration with no `.rs` change and asserts after each that explorer-indexer's own build script re-ran (its `output` file under `target/debug/build/` was rewritten), the crate recompiled, and the parity target passed. Controls: an unchanged tree does **not** re-run the build script, the `indexer` binary recompiles too, and a missing `migrations/` fails the build naming #1416. It mutates the checkout and restores it on exit; each step recompiles only explorer-indexer.

**Steps — `test-target-coverage` job:**
1. Checkout repository
2. `pip install pyyaml`
3. `python3 .github/scripts/check_cargo_test_target_coverage.py --list-executed` — red on any `tests/*.rs` target no workflow runs
4. `bash .github/scripts/tests/test_check_cargo_test_target_coverage.sh` — drives the checker's own failure paths against synthetic workspaces and against this repo plus one synthetic dark file

**Steps — `audit` job:**
1. Checkout repository
2. Install Rust toolchain
3. `cargo install cargo-audit --locked` — install the advisory scanner
4. `cargo audit` — runs over **every** `Cargo.lock` in the repo against the rustsec/advisory-db. There is exactly one: the root workspace lockfile. `services/explorer-indexer`, `testing/doctests`, `testing/ethereum-testnet/e2e-rust`, and `testing/fork-e2e-rust` are workspace **members**, so cargo resolves them against the root lock; the standalone lockfiles they used to carry were removed (issue #1202) because cargo never read or regenerated them and they drifted into pinning versions no build used. The loop is kept as-is so a genuinely standalone workspace added later is audited automatically. Exits non-zero on any vulnerability advisory. Ignore configuration is read from `.cargo/audit.toml`, which suppresses pre-existing sub-high advisories with dated justifications so the gate has a green baseline and blocks merges on any new advisory. To accept a known low-risk advisory temporarily, add its RUSTSEC id to the `ignore` list in that file with a reason and expiry comment.

**Steps — `doc-coverage` job:**
1. Checkout repository
2. Install Rust toolchain + rustdoc
3. Cargo cache
4. `cargo build --all-targets` — clean build; surfaces compile errors not caught by clippy
5. `cargo doc --no-deps --all-features 2>&1 | tee "$RUNNER_TEMP/.../rustdoc.log"` + `check_rustdoc_coverage.py` — enforces doc coverage threshold: every `pub` function, struct, and enum in `rmpc` and `explorer-indexer` crates must carry a doc comment; script exits non-zero if coverage falls below threshold

---

### 5. Fork integration tests (protocol adapters)
**Suggested file:** `.github/workflows/fork-integration.yml`
**Environment:** `fork`
**Tier / triggers:** HEAVY — 5 matrix slots on the Twin chain, 20-25 min wall-clock. Gates every `pull_request` into `dev` (no path filter) and runs on `push` to `dev`. Feature PRs into phase branches skip this suite; `suite-06` (rmpc-unit) provides fast feedback on those.

**The chain is the Twin fork (core 1498, 1496):**
A `pin` job chooses ONE pinned Base block per workflow run (upstream head minus 2, `.github/actions/twin-pin`). Every slot starts the Twin fork at that pin with `.github/actions/twin-fork` (anvil `--fork-url <upstream> --fork-block-number <pin> --chain-id 918453`, upstream `https://mainnet.base.org` unless the optional secret `BASE_UPSTREAM_RPC` is set; anvil's RPC cache is persisted per pin block). There is no saved `.anvil-state` fixture, no genesis alloc and no docker chain. Slots (matrix `include`):

| Slot | Tests | Mode |
|---|---|---|
| `twin-router` | `router` | straight on the Twin fork (`RMPC_TESTNET_RPC_URL`) |
| `twin-gateway-registry` | `gateway_deposit`, `registry` | straight on the Twin fork |
| `twin-light` | `failure_surface_smoke`, the `rmpc_get_*` fork tests | straight on the Twin fork |
| `anvil-devnet-adapters` | `devnet_adapter_round_trip`, `gas_estimate_reality_check`, `landing_price_strip_fork`, `basket_vault_round_trip` (core 1656: `skip_if_no_devnet_fork!` needs `RMPC_FORK_RPC_URL`, so they silently skipped in `twin-light`). `gas_estimate_reality_check` holds deposit gas to 920,000 (measured 833,900 plus about 10%, issue #1683). The slot requires the marker `[gas_estimate_reality_check] deposit gasUsed=`, which the test prints only after that assertion passes (QA plan T3) | each test forks the Twin |
| `anvil-goldens` | `abi_address_sanity`, `dex_route_smoke`, `vault_deposit_redeem_smoke` | each test forks the Twin (`RMPC_FORK_RPC_URL=$TWIN_RPC_URL`, `RMPC_FORK_BLOCK=$TWIN_PIN_BLOCK`) |
| `anvil-governance` | `governance` | each test forks the Twin and deploys its own receipt-path stack; `applyReceipt` releases and applies in one call, with its digest-mismatch and refused-vector cases (issue 1698) |

Coverage is **loud** per the repo test-coverage policy: zero executed fork tests fails CI, never silent-skips. Every wrapped step names its floor, and the floor equals the number of tests the step selects, so one test fewer is red (QA plan v1 T5). `.github/scripts/check_executed_floors.py` (suite 14) counts the tests from the source and fails when a floor in suites 5, 8 or 22 differs: a new test means a new floor in the same PR. Live-Base drift is covered by the nightly Twin fork run (suite 29): every run pins the current head. The landing price strip has no golden price (the pin moves every run): `testing/ethereum-testnet/config/price-strip-pairs.json` holds a sanity band per pair, which still catches wrong decimals, inverted pairs and a missing pool.

Known gap: the `fork-e2e-rust` scenarios and several tests still read the live production v1 addresses from `testing/fork-e2e-rust/src/addresses.rs`. The clean room rule (each test deploys its own vault and reads manifests) is met by suites 7, 8, 10, 14 and the explorer-indexer `fork_indexer` test, not yet by these.

**Why a fork of real Base here, and how it differs from the smoke-test harness (suite 14):**
This suite runs the Rust client (`rmpc`) against **real Base state** (real deployed contracts, real DEX pools, real USDC). The goal is to catch ABI encoding drift, address-constant mistakes, and real-world RPC error shapes. The smoke-test harness (suite 14) runs on the same Twin chain but deploys its own contracts through the one deployment scheme (publish contracts) and tests the stack end to end.

| Concern | Suite 5 | Smoke-test harness (suite 14, `--full-stack`) |
|---|---|---|
| Chain | Twin fork, or a local anvil fork of it | Twin fork |
| Contracts | Already-deployed ones | Freshly deployed through publish contracts |
| Catches | ABI/address/RPC-shape drift | Full-stack flow (dapp→indexer→explorer), the real Safe, the timelock |
| Speed | Seconds per test (instant mining) | Minutes (publish run, image builds) |

A per-test audit of suite-05's coverage against the alternative suites is recorded in [suite-05-audit.md](./suite-05-audit.md) (issue #248). The audit's recommendation is **keep**, with a follow-up slim of two tests that duplicate suite-6 coverage.

**Jobs:**
- `pin` — chooses the run's one pin
- `fork-integration` — the five matrix slots above (`needs: pin`)
- `base-testnet-adapters` — the crate's lib unit tests (floor 26), the `base_testnet_fixture` tests, and `multi_network_adapters`. `parameterized_e2e!` makes one test per network (QA plan v1 T5). The devnet leg runs on the Twin fork with `--skip base_testnet` and requires the Uniswap, Aave and vault-stack OK markers. The Base testnet leg runs in its own step only when `BASE_TESTNET_RPC_URL` and `BASE_TESTNET_FUNDER_KEY` are set, and requires the Uniswap and Aave markers. Without the secrets that step does not run and a warning says so. Under `CI` a leg with no RPC or no funder panics ("Refusing to skip"), and a step proves that with `CI=true` and the testnet env unset. Before T5 both legs were one test, and the devnet leg met the floor of 1 while the testnet leg skipped on every run. Neither leg skips a part any more. The vault-stack part on Base's public testnet is its own test, `vault_stack_base_testnet`: it needs `RM_TESTNET_VAULT_ADDR`, a Robot Money deploy on Base's public testnet (#839), and panics under `CI` without it. No such deploy exists, so every suite 5 step leaves that test out by name (`--skip vault_stack_base_testnet`; the devnet step's `--skip base_testnet` covers it too). Drop the skip when the deploy exists.
- Nightly: the nightly Twin chain workflow (suite 29, issue 1496) reruns the chain suites with one shared pin. It is not a PR gate.

**Steps (`fork-integration`, per slot):**
1. Checkout repository
2. Install Rust toolchain, Cargo cache
3. Start the Twin chain at the run pin (`.github/actions/twin-fork`: installs Foundry and Bun, restores the RPC cache keyed by the pin block, exports `TWIN_RPC_URL` and `TWIN_PIN_BLOCK`)
4. `forge build`
5. `cargo test --no-run --release` — build test binaries
6. `cargo test --release <slot tests> -- --test-threads=1 --nocapture` with `RMPC_TESTNET_RPC_URL` (shared slots) or `RMPC_FORK_RPC_URL` and `RMPC_FORK_BLOCK` (fork slots)

---

### 6. Rust client unit tests
**Suggested file:** `.github/workflows/rmpc-unit.yml`
**Environment:** `none`
**Trigger paths:** none — runs on every PR and push, with no `paths:` filter.
This is not an oversight: step 6 (`plugin_skill_command_examples`, issue
#1203) must run on docs-only PRs that touch only `plugins/**/*.md`, which a
`clients/rust-payment-client/**` filter would exclude — silently reinstating
the false-green shape #1199/#1203 were filed about (issue #1231).

**Jobs:**
- `unit` — single job, no dependencies

**Steps:**
1. Checkout repository
2. Install Rust toolchain
3. Cargo cache
4. `cargo clippy -p rust-payment-client --all-targets -- -D warnings` — type-checks the crate's 23 `tests/` integration binaries in this job, so a struct-literal break in `tests/` fails here rather than only in suite 4 (issue #1295)
5. `cargo test --lib` — calldata builder output, preflight rejection cases, nonce management logic, fee policy guard, JSON output schema conformance, config parsing
6. `cargo_test_require_executed.sh --test plugin_skill_command_examples` — the one integration binary run here (issue #1203); fails red on a zero-tests-collected run

---

### 7. Rust client integration tests
**Suggested file:** `.github/workflows/rmpc-integration.yml`
**Environment:** `devnet` (the Twin chain)
**Tier / triggers:** HEAVY — gates every `pull_request` into `dev` (no path filter) and runs on `push` to `dev`.

**Jobs:**
- `pin` — chooses the run's one pin (`.github/actions/twin-pin`)
- `parity` — the binary-only rmpc tests (no chain)
- `devnet-e2e` — one runner per e2e binary (`smoke`, `scenarios`, `window_cap`, `withdraw`), each with its OWN Twin fork at the run pin; `needs: pin`
- `nonce-race-stress` — in-process stress test, no chain

**Steps — `devnet-e2e` job (per matrix row):**
1. Checkout repository
2. Install the publish-contracts dependencies (`.github/actions/publish-contracts-setup`; the one deploy driver lives in this repo)
3. Install Rust toolchain, Cargo cache
4. Start the Twin chain at the run pin (`.github/actions/twin-fork`, exports `TWIN_RPC_URL`; the harness reuses it)
5. `cargo test --release --test <binary> -- --test-threads=1 --nocapture` in `testing/ethereum-testnet/e2e-rust`. Each binary deploys its own vault through publish contracts. Time-dependent flows warp.

**Steps — `nonce-race-stress` job:**
1. Checkout repository
2. Install Rust toolchain
3. Cargo cache
4. `bash .github/scripts/stress_nonce_race.sh` — runs the race test 100× in-process; no chain

**Version guards — `rmpc-parity` job, ahead of the release build (issues #1191, #1243):**
- `.github/scripts/assert_manifest_ahead_of_tags.sh` — the rmpc manifest must be strictly ahead of every published `rmpc-v*.*.*` release. Scoped to changes under `clients/rust-payment-client/**`, because the state it reports belongs to the branch rather than to the change; the bare `v*.*.*` namespace belongs to `release-dapp` and cannot raise the rmpc floor.
- `.github/scripts/tests/test_assert_manifest_ahead_of_tags.sh` and `.github/scripts/tests/test_bump_rmpc_manifest.sh` — synthetic-repository exercises for the two scripts above, neither of whose real caller runs on a PR. See `docs/development/releasing.md`.

**CLI surface — `rmpc-parity` job (issue #1282):** one further step,
*rmpc CLI surface (deposit, status, self-check, get-\*)*, runs the fifteen
mockito-backed targets that no workflow named before: `cli`, `cli_deposit`,
`cli_status`, `cli_self_check` and the eleven `cli_get_*`
suites. They drive the built `rmpc` binary through `assert_cmd` against a
mockito JSON-RPC server — no chain, no Docker — which is why they belong in this
binary-only job rather than the devnet matrix. `cli_deposit.rs` alone is 687
lines covering the deposit happy path, chain-id mismatch, deposit-paused gateway, fee
cap, concurrent lock, receipt timeout, duplicate replay and revert. Wrapped in
`cargo_test_require_executed.sh`.

**Write seam on a real EVM — `rmpc-parity` job (QA plan T2):** the job installs
Foundry, then runs `RMPC_REQUIRE_ANVIL=1 CARGO_TEST_MIN_EXECUTED=2
cargo_test_require_executed.sh --release --test write_seam_reverted_anvil`.
The test mines a transaction into a blank local anvil, lets it revert, and
asserts the shared write seam refuses it as `ErrTxReverted`. It is the only
revert test that does not mock the receipt. Without `RMPC_REQUIRE_ANVIL=1` a
missing `anvil` makes it return early and pass.

---

### 8. Explorer indexer tests
**Suggested file:** `.github/workflows/explorer-indexer.yml`
**Environment:** `devnet`
**Trigger paths:** `services/explorer-indexer/**`, `testing/explorer-indexer/**`

**Jobs:**
- `fast` — migration idempotency, block ingestion, RPC failure recovery, consensus-receipt indexing, and the reorg + read-path suites; uses a Postgres testcontainer; runs immediately
- `explorer-api` — the `clients/explorer-api` read API: IC committee / regime / consensus-receipt endpoints, plus the HTTP contract, CORS, router-shape and schema-parity suites; Postgres testcontainer. The committee and regime endpoint suites are deprecated (2026-10-20, see IC-1019: the IC policy is removed from the design); CI still runs them today
- `pin` — chooses the run's one Twin chain pin (`.github/actions/twin-pin`)
- `devnet` — the `fork_indexer` test: deploys its OWN vault through publish contracts on the Twin chain (`.github/actions/twin-fork` at the run pin, `TWIN_RPC_URL`) and indexes it; runs in parallel with `fast` (independent environments). Reorg handling is covered by the stub-RPC reorg suites of the `fast` job (an instant-finality anvil chain cannot produce competing tips).

**Steps — `fast` job:**
1. Checkout repository
2. Install Rust toolchain + clippy
3. Cargo cache
4. `cargo fmt --check` + `cargo clippy`
5. `cargo test --no-run`
6. `cargo test --test migrations` — migration idempotency (Postgres testcontainer started by the test)
7. `cargo test --test idempotency` — block ingestion against known deposit events; double-count guard
8. `cargo test --test rpc_failure` — RPC failure recovery; reconnect and resume from last confirmed block
9. `cargo_test_require_executed.sh -p explorer-indexer --test consensus_receipt_indexing` — ReceiptRecorded / ReceiptReleased ingestion and the reorg rewrite of `consensus_receipts` (issue #1247)
10. `cargo_test_require_executed.sh -p explorer-indexer --test system_isolation` and `--test registration_history` (core 1891) — the compiled indexer with no gateway, and agent registration identity, idempotency and rollback-replay equality. Both fail, naming Docker, when the Postgres testcontainer is absent.
11. `cargo_test_require_executed.sh -p explorer-indexer --test cursor_header_reorg --test reorg_cursor_vault_status --test account_history --test account_position_vote_power --test multi_vault --test vault_detail --test vault_registry` — the targets no workflow ran until issue #1282 (`committee_indexing` was retired with the committee tables, core 1891). The first two are the repository's **only** reorg-correctness suites; issue #1283 shipped because they were dark.

**Steps — `explorer-api` job:**
1. Checkout repository
2. Verify Docker is available (loud-skip if the testcontainer resource is missing)
3. Install Rust toolchain + cargo cache
4. `cargo_test_require_executed.sh -p explorer-api --test registration_history --test consensus_receipt_api` — registration-aware account and agent routes, the retired `/v1/committee/*` and `/v1/regime/feed` routes returning 404 (core 1891), and the receipt endpoints (issue #1247). The job keeps its name, `explorer-api-committee-regime`, because it is a required check
5. `cargo_test_require_executed.sh -p explorer-api --test endpoints --test router_introspection --test cors --test canonical_schema` — the four sibling suites left dark when the two above were wired up (issue #1282). `endpoints.rs` is the only executor of the HTTP contract the dApp reads; `router_introspection.rs` is the guard for §11 "the API does not sign, authorize, or write".

**Executed floors (QA plan v1 T5):** every `cargo_test_require_executed.sh` call in this suite names `CARGO_TEST_MIN_EXECUTED`, and the floor equals the number of tests the call selects. Before T5 most calls kept the default floor of 1, so the seven read-path targets (49 tests) were green with one test passing. The ABI drift gate, a bare `cargo test --lib` filter, now runs through the guard too. `.github/scripts/check_executed_floors.py` (suite 14) counts the selected tests from the source and fails on any difference.

Steps 9 and 10 run through `.github/scripts/cargo_test_require_executed.sh`, which fails the step when zero tests were collected — a `tests/<name>.rs` file cargo was never told to run is a silent skip, not coverage. Step 10 additionally sets `EXPLORER_INDEXER_REQUIRE_PG=1`. The fixture panics on an unavailable Postgres testcontainer regardless — the executed-count guard cannot distinguish a real pass from a test that returned early because its fixture handed it `None`, and that shape counted as passed — so the variable is an *assertion* of that mode, not a switch into it: `common::check_require_pg()` (task T30b) accepts unset, `1`, `true` and `yes`, and panics on any value asking for a skip-capable mode, which does not exist.

**Steps — `devnet` job:**
1. Checkout repository
2. Verify Docker is available
3. Install Rust toolchain
4. Cargo cache
5. _(`devnet` job)_ `cargo test --test fork_indexer` — nine tables populated, the heartbeat snapshot lands and a re-run inserts nothing, against a vault deployed by the test on the Twin chain

---

### 9. dApp quality gate
**Suggested file:** `.github/workflows/dapp-quality.yml`
**Environment:** `none`
**Trigger paths:** `clients/dapp/**`

**Jobs:**
- `lint-build` — single job, no dependencies

**Steps:**
1. Checkout repository
2. Setup Bun + Node 22
3. `bun install --frozen-lockfile`
4. `bun run fmt` — Prettier check
5. `bun run lint` — ESLint
6. `bunx tsc -b` — TypeScript type check
7. `bun run build` — verify production build succeeds. **This must stay ahead of `bun run test`**: `clients/dapp/tests/unit/csp.test.ts` asserts the CSP meta tag is baked into `dist/index.html` and now throws when that artifact is absent instead of returning early. With the build second, that assertion silently executed nothing and still reported green (issue #1383) — see [false-green-shapes.md](./false-green-shapes.md) shape `artifact-guard-runs-before-build`.
8. `bun run test` — Vitest: component rendering, browser-side key generation, credential boundary (no key material in DOM), form validation, and the built-bundle CSP assertion above
9. `bash scripts/check-csp.sh` — Enforce strict CSP: builds the production bundle, serves it with `vite preview`, then asserts the `Content-Security-Policy` response header is present and contains `script-src` but neither `unsafe-inline` nor `unsafe-eval`; also checks the baked-in `<meta http-equiv="Content-Security-Policy">` tag in `index.html` (issue #665)
10. `bash scripts/audit-deps.sh` — dependency vulnerability scan wrapping `bun audit --audit-level=high`; exits non-zero on any high or critical advisory (CVSS ≥ 7.0). Uses `bun audit` (not `npm audit`) because the lockfile is `bun.lock`; `npm audit` fails with `ENOLOCK` without a `package-lock.json`. The script carries a dated allowlist of pre-existing high/critical advisories (axios via the wallet-connector SDK, the dev-only vitest UI advisory, and the esbuild Deno-install-path advisory — build-time only, not reachable via bun installs) so the gate has a green baseline and blocks merges on any new advisory. To accept a known advisory temporarily, add its GHSA id to the allowlist in `clients/dapp/scripts/audit-deps.sh` with a reason and expiry. Do not lower `--audit-level`.
11. `bash scripts/check-hsts.sh` — HSTS preload header on the served bundle (issue #671)
12. `bunx playwright test -c playwright.mainnet.config.ts --reporter=list,json` — the mainnet-class bundle in a real browser (QA plan v1 U5, issue 1737 item 3). The config builds its own bundle with `VITE_ENV_CLASS=mainnet` and `VITE_CHAIN_ID=8453` into `dist/mainnet-class`, serves it with `vite preview` on loopback, and runs `tests/mainnet/mainnet-class.spec.ts` against a mocked `window.ethereum`: the mainnet banner is visible, a wallet on chain 1 or 918453 gets the wrong-chain gate and no deposit or approve control, switching to Base lifts the gate, and no signing or sending method reaches the wallet. No chain, no devnet, no key. Suite 10 builds the fork class, so nothing ran this spec before. Playwright exits 0 when every test is skipped, so the step reads the JSON report and requires exactly `MAINNET_CLASS_EXECUTED_FLOOR` (4) passed tests, none skipped and none failed.

---

### 10. dApp E2E tests
**File:** `.github/workflows/suite-10-dapp-e2e.yml`
**Environment:** `devnet` (smoke-test full stack)
**Tier / triggers:** HEAVY — gates every `pull_request` into `dev` (no path filter) and runs on `push` to `dev`.

A `pin` job chooses the run's one Twin chain pin. The `e2e` job starts the Twin fork at that
pin (`.github/actions/twin-fork` with `host: 0.0.0.0` and `block-time: 1`, so the indexer
container can reach it and its safe head keeps moving) and runs every Playwright spec against
the Twin chain through Playwright's `globalSetup` (`devnet-global-setup.ts`), which spawns
`cargo run -p smoke-test -- --full-stack`. The harness reuses the fork through `TWIN_RPC_URL`. The dapp
container in that stack is built with the gateway's runtime keccak-256
pinned via `VITE_GATEWAY_EXPECTED_CODE_HASH`, so verification succeeds
the prod way. There is no local-dev fast path: every spec exercises a
bundle that is bit-identical to a production deployment.

**Design principle — no test-only code in production:** the dapp's
`src/` tree contains no `VITE_USE_MOCK_WALLET`, no
`VITE_GATEWAY_VERIFY_BYPASS_FOR_TEST`, and no other env-gated test
branches. Test seams live entirely in Playwright (`tests/e2e/helpers/`):
a JS-level EIP-1193 provider injected via `page.addInitScript` drives
the prod `injected()` wagmi connector exactly like a real wallet
extension. The harness supplies the real expected code hash. See
`docs/development/smoke-test-design.md`.

**Projects (core 1544):** the Playwright config has two projects over the one devnet. `dapp` runs every
spec except one. `safe-governance` runs `safe-proposal-role-grant.spec.ts` after `dapp` finishes, because
that spec advances the Twin chain clock past the timelock delay (`evm_increaseTime`) and drives the
publish-contracts Safe tool (`bun publish-contracts/src/safe/cli.ts`, installed by the
`publish-contracts-setup` step). The spec is in `REQUIRED_SPECS`, so a skipped or missing run fails the job.
It signs with the real 2-of-3 SafeL2 owner keystores the harness mints and passes through the real timelock.

**No skipped tests (QA plan v1 T5):** the required-coverage reporter (`tests/e2e/reporters/requiredCoverage.ts`) fails a full run that skipped any test, and names it. The spec rule could not see a skip inside a spec whose other tests ran, and three tests skipped on every run that way. `consensus-receipts.spec.ts` needs a receipt a Fusion QA run anchored, so the default config no longer collects it (`testIgnore`); it runs only under `playwright.fusion.config.ts` and fails without `FUSION_RECEIPT_ID` and `FUSION_RECEIPT_URL`. The ProportionPreview alignment test in `number-formatting.spec.ts` now chooses the router destination and enters an amount, so the leg table renders. The balances-panel screenshot test is deleted: no baseline was ever committed, and the panel shows live balances.

**Steps:**
1. Checkout repository (recursive submodules)
2. Setup Bun + Node 22
3. Verify Docker is available
4. Install Rust toolchain + Foundry
5. `bun install --frozen-lockfile`
6. `bunx playwright install --with-deps chromium`
7. `bun run test:e2e` — Playwright globalSetup boots smoke-test full
   stack; runs every spec under `clients/dapp/tests/e2e/` against it
8. Upload Playwright report artifact on failure

---

### 11. OpenCode integration tests
**Suggested files:** `.github/workflows/opencode-smoke.yml` (structural + offline) and `.github/workflows/opencode-headless.yml` (headless agent runs requiring `ANTHROPIC_API_KEY`)

Split into two files because the structural/offline checks are cheap, keyless, and should run on every PR, while the headless runs are expensive, require a model key, and should run nightly or on `workflow_dispatch` only.

**Environment:** `none` (smoke); `devnet` (headless)
**Trigger:** `opencode-smoke.yml` on every PR; `opencode-headless.yml` nightly + `workflow_dispatch` for the live jobs, plus `pull_request` for its offline `asserter-tests` job only (issue #1151)

**Jobs — `opencode-smoke.yml`:**
- `plugin-validate` — manifest and binary checks; runs immediately
- `walkthrough-offline` — Rust offline refusal tests; runs in parallel with `plugin-validate`
- `walkthrough-fork` — **needs `walkthrough-offline`**; adds the fork-backed read-only envelope check

**Steps — `plugin-validate` job:**
1. Checkout repository
2. Install OpenCode at pinned version
3. Verify `plugin.json` parses as valid JSON
4. Verify `SKILL.md` frontmatter is present and well-formed
5. Verify all `references/*.md` links resolve
6. `opencode --version` + `opencode run --help` — binary is functional without a model key

**Steps — `walkthrough-offline` job:**
1. Checkout repository
2. Install Rust toolchain + clippy
3. Cargo cache
4. `cargo fmt --check` + `cargo clippy`
5. `cargo test --test walkthrough_parity` — doc parity between `opencode-readonly-fork.md` and installed harness config
6. `cargo test --test config_template_parses` — TOML config template parses through rmpc's real config loader
7. `cargo test --test refusal_walkthrough` — **safety step**: prompt injection refusal, mainnet gate, out-of-policy amount refusal, unknown tool refusal, secret handling, read-only isolation (offline; no chain)

**Steps — `walkthrough-fork` job:**
1. Checkout repository
2. Install Rust + Foundry toolchain
3. Cargo cache
4. `cargo test --test read_only_walkthrough` — rmpc envelope contract against devnet (current reality: skip-cleans without a live RPC; the Twin chain is the target: a pinned lazy fork of real Base, no secret, loud on missing)

**Jobs — `opencode-headless.yml`:**
- `asserter-tests` — offline, keyless pytest of the transcript asserters, live-fail guard, and replay harness, plus the G12 keystore-generate negative control (`negative_control_keystore_generate_flag.sh`, issue #1235); runs on **every** trigger, including `pull_request`. pytest exits non-zero if it collects zero tests, so a mis-pathed suite reds the job. It also runs the keypair-parse self-test `test_parse_cast_wallet_new.py` (issue #1682, QA plan v1 U2): the cast ≥ 1.8 envelope, the cast ≤ 1.7.1 array and a bare object parse to the same address and key; a missing or malformed address or key, an empty wallet list, `success: false` and non-JSON are refused without echoing the key; the `deposit` job reads the wallet through the parser and runs govern; this workflow and `.github/actions/twin-fork` pin the same exact Foundry release (see [Foundry version](#foundry-version)).
- `refusal` — offline **rmpc CLI-level** refusal assertions (`cargo test --test opencode_refusal`: unknown subcommand and missing `--config` each exit non-zero with a labelled stderr payload), no chain and no model key; runs nightly/dispatch. It invokes no model, so it is not agent-refusal coverage — gap G10 is reopened, see `headless-opencode-tests.md`.
- `deposit` / `read` — **replay coverage** (issue #1210 option C; closes tracker #1233): no model, no `OPENCODE_API_KEY`. Instead of a live agent choosing tool calls, `.github/scripts/replay_headless_transcript.py` executes the same fixed rmpc command sequence the (removed) live-agent prompts always named explicitly, for real, against the job's live devnet, then emits a transcript in the exact shape `opencode run --format json` produces. Every downstream assertion script runs unchanged against that real, freshly-generated transcript.

**Replay coverage (issue #1210 option C; closes re-enablement tracker #1233).** Anonymous OpenCode models no longer execute, and the repository intentionally does not provision `OPENCODE_API_KEY` (option A). Rather than leave the `deposit`/`read` jobs disabled, they now replay the exact rmpc command sequence the disabled live-agent prompts always named explicitly — see `docs/technical/opencode-headless-invocation.md` §12.6. This proves the rmpc CLI contract (syntax, exit codes, output schema) and the full deploy → authorize → deposit pipeline execute correctly, with real on-chain assertions on fresh state every run. It does **not** prove a live LLM would choose this exact tool sequence from the natural-language prompt, and it cannot exercise agent *refusal* on a failed precondition — refusal requires a model making a judgement call, not a fixed script, so gap G10 stays open (see `headless-opencode-tests.md`). Restoring that remains option A.

**Steps — `refusal` job:**
1. Checkout repository
2. Install Rust + Foundry toolchain
3. Cargo cache
4. Run `cargo test --test opencode_refusal` — two CLI-contract assertions (unknown subcommand refuses with non-zero exit; missing required `--config` refuses), no model key and no chain required

**Steps — `deposit` job (replay coverage):**
1. Checkout repository
2. Install Rust + Foundry (pinned `v1.8.5`, the same release as `.github/actions/twin-fork`)
3. Generate fresh agent EOA with `cast wallet new --json`, read through `.github/scripts/parse_cast_wallet_new.py` (any known cast output shape; refuses a missing or malformed field, issue #1682); write keystore via `rmpc-keystore-import` and require its address to equal cast's
4. Deploy the real Aave V3 / Compound V3 / Morpho adapter stack with `.github/actions/twin-publish` and `govern: "true"`: stage 13 unpauses all three vaults through the real Safe and timelock (one Twin time warp). Every vault deploys paused, so without govern the replay's `self-check` and `deposit` refuse with `ErrDepositsPaused` (QA plan v1 U2). Then the depositor authorizes the generated agent on-chain (commit, reveal) and the step asserts `agentOwner` and `AGENT_ROLE`
5. Fund agent ETH balance via `anvil_setBalance`; set USDC approval signed by the generated agent key
6. `replay_headless_transcript.py` executes get-vault → get-agent → get-balance → get-allowance → self-check → deposit in that fixed order against the live devnet, then `assert_headless_live_transcript.py` — loud-fail guard that reds this step on an empty / zero-rmpc transcript
7. `assert_headless_deposit_transcript.py` — asserts tool-call order, deposit exit 0, tx_hash present; `assert_headless_deposit_delta.py` / `assert_headless_deposit_sender.py` — asserts the on-chain vault delta and tx sender

**Steps — `read` job (replay coverage):**
1. Checkout repository
2. Install Rust + Foundry
3. Deploy contracts + fund agent on devnet
4. **Safety step**: read-only isolation assertions — agent in read-only config cannot invoke state-changing tools
5. `replay_headless_transcript.py` executes get-vault → get-gateway → get-balance in that fixed order against the live devnet, then `assert_headless_live_transcript.py` — loud-fail guard that reds this step on an empty / zero-rmpc transcript
6. `assert_headless_read_transcript.py` — asserts vault state, gateway state, and balance queries match JSON schema

---

### 12. OpenClaw integration tests
**Suggested file:** `.github/workflows/openclaw.yml`
**Environment:** `devnet`
**Trigger paths:** `testing/openclaw-config/**`, `plugins/robotmoney-user/**`, `docs/development/openclaw-config.md`

**Jobs:**
- `safety` — shellcheck, mainnet gate, secret handling; runs immediately; no chain required
- `walkthrough` — **needs `safety`**; long-running deposit walkthrough against devnet (current reality: skip-cleans without a live RPC; the Twin chain is the target: a pinned lazy fork of real Base, no secret, loud on missing)

**Steps — `safety` job:**
1. Checkout repository
2. Install Rust toolchain
3. Cargo cache
4. `shellcheck -x testing/openclaw-config/*.sh`
5. `cargo build --manifest-path clients/rust-payment-client/Cargo.toml --bin rmpc`
6. `bash test_mainnet_gate.sh` — **safety step**: OpenClaw configured for fork cannot broadcast against mainnet RPC
7. `bash test_secret_handling.sh` — **safety step**: key material, RPC URLs with embedded API keys, and mnemonic phrases never appear in conversation or logs
8. `bash test_doc_parity.sh` — walkthrough parity between `openclaw-config.md` and installed harness config

**Steps — `walkthrough` job:**
1. Checkout repository
2. Install Rust toolchain
3. Cargo cache
4. `bash test_long_running.sh` — deposit walkthrough driven through OpenClaw runtime against devnet; same transcript assertions as the OpenCode deposit suite
5. Upload the long-running `outcome.txt` from `$RUNNER_TEMP/robotmoney-openclaw/long-running/`; assert it is well-formed (`outcome=pass|skipped|fail`, `reason=` present)

---

### 14. smoke-test library
**Suggested file:** `.github/workflows/smoke-test.yml`
**Environment:** `devnet` (the Twin chain)
**Tier / triggers:** HEAVY — gates every `pull_request` into `dev` (no path filter) and runs on `push` to `dev`.

Validates the `smoke-test` crate — the canonical devnet fixture library — in
isolation, independent of any client (rmpc, dapp, explorer).

**Jobs:** `smoke-test-guards` (hermetic, no chain), `pin` (the run's one Twin chain pin), `devnet` (matrix, `needs: pin`), `changes`, `twin_publish` and `twin_pause_all` (both `needs: [changes, pin]`).

**Steps (`devnet` matrix row):**
1. Checkout repository
2. Install the publish-contracts dependencies (`.github/actions/publish-contracts-setup`; the one deploy driver lives in this repo)
3. Verify Docker is available (the dapp compose stack of `cli_meta`)
4. Install Rust toolchain, Cargo cache
5. Start the Twin chain at the run pin (`.github/actions/twin-fork`, `host: 0.0.0.0`, `block-time: 1`; exports `TWIN_RPC_URL`)
6. `cargo build -p smoke-test` — includes the `smoke-test` CLI binary
7. `cargo clippy -p smoke-test --all-targets -- -D warnings` — type-checks the crate's `tests/` integration binaries in the hermetic `smoke-test-guards` job (issue #1295); `cargo build` alone never compiles them. The same job also runs `bash .github/scripts/tests/test_cargo_test_require_executed.sh`, the self-test proving the executed-test guard's `REQUIRE_EXECUTED_MARKERS` gate goes red on a skipped or truncated devnet test (issue #1371), and `cargo_test_require_executed.sh -p smoke-test --test govern_output_parse` with a floor of 5: the hermetic govern stdout contract, which no step ran before QA plan T2
8. `cargo test -p smoke-test --release --test cli_meta -- --nocapture` — boots `smoke-test --full-stack`, checks the structured endpoint summary, verifies `--dapp-port` / Ctrl-C teardown, and writes `smoke-test-cli_meta.log`
9. `cargo test -p smoke-test --release --test fixture_meta -- --test-threads=1 --nocapture` — deploys contracts, asserts a healthy RPC on a real Base head, the three-vault manifests and the handover
10. `cargo test -p smoke-test --release --test fund_usdc -- --test-threads=1 --nocapture` — the Twin environment steps: fund USDC (a grant of the exact amount on the real FiatToken slot, spendable through the real token's `transfer`), fund gas (exact balance), the chain is the anvil Twin fork (id 918453), and warp moves block time 48h without real waiting.
11. `cargo test -p smoke-test --release --test twin_fork_env -- --test-threads=1 --nocapture` — the same three environment steps straight through `TwinFork` on the real Base USDC, with no publish run: fund USDC sets the real balance slot, fund gas, warp, and the fork is the anvil Twin fork on a real Base head.
12. `cargo test -p smoke-test --release --test governance -- --test-threads=1 --nocapture` — after the publish-contracts run, the deployer holds neither `ADMIN_ROLE` nor `WEIGHT_SETTER_ROLE` on `RouterGovernance`, and the timelock holds both (core 1488, issue 1698). `WEIGHT_SETTER_ROLE` gates `applyReceipt`. There is no voting by anyone: `RouterGovernance` has no voting function (issue 1698).
    Each is wrapped in `cargo_test_require_executed.sh` so a run that silently collects zero tests fails red rather than green (issue #1311 AC). All write `smoke-test-<binary>.log`.
    The `demo_seeding`, `full_stack_demo_tvl`, `faucet_eth` and `faucet_rm` binaries were deleted in core 1488 with demo depositor seeding and the dapp faucet funding. Every devnet row now starts or reuses the Twin chain, funds fresh rehearsal keystores and calls publish contracts (`bun publish-contracts/src/cli.ts`, installed by `.github/actions/publish-contracts-setup`; the stage sheet is the committed `deployments/twin-918453/stage-sheet.env`, `STAGE_SHEET` overrides it).
13. Upload smoke-test logs from `$RUNNER_TEMP/robotmoney-smoke-test/` as a CI artifact, then remove any dapp containers by label as the safety-net teardown. The Twin fork needs none: it dies with the runner.

> **Note:** Step 9 exercises `Fixture::new()` end-to-end — the same code
> path that all devnet-backed suites (7, 8, 10, 11, 12) depend on. A
> failure here blocks those suites before they pay their own boot costs.
>
> **One deployment scheme (core 1488):** the harness deploys nothing itself.
> `Fixture::new()` starts or reuses the Twin chain (918453), funds fresh rehearsal
> keystores (fund gas, fund USDC) and calls the one runbook, "publish contracts" (`publish-contracts/` in this repo, Bun
> TypeScript), with `--chain 918453 --rpc <twin rpc> --sheet <stage sheet>
> --signer keystore --environment stage --core-sha <sha>`. It then reads the
> manifests. All three vaults ship (rmUSDC, rmPROTO, rmRWA); rmAGENT is retired (ADR-0017). The
> deployer holds nothing after handover: the real Safe and the timelock are the
> admin. The matrix is `[cli_meta, fixture_meta, fund_usdc, governance, twin_fork_env]`
> (`fail-fast: false`), one runner per binary.

---

### 13. Cross-cutting doc checks
**Suggested file:** `.github/workflows/doc-checks.yml`
**Environment:** `none`
**Trigger:** All PRs (no `paths:` filter — these catch drift introduced anywhere)

**CI truthfulness.** This suite is also where the repo's catalogue of known
false-green CI shapes — a check that reports green while proving nothing —
is itself kept honest. See
[false-green-shapes.md](./false-green-shapes.md) for the catalogue; step 11
below is what keeps it from drifting into a dangling reference.

**Jobs:**
- `doc-validators` — ADR and runbook compliance checks; runs immediately
- `schema-validators` — migration file placement invariant; runs in parallel with `doc-validators`

**Steps — `doc-validators` job:**
1. Checkout repository
2. Install Python
3. `check_browser_keygen_adr.py` — browser keygen ADR file exists with expected structure
4. `check_dapp_credential_adr.py` — dApp credential ADR compliance
5. `check_demo_runbook.py` — demo runbook headings and required sections present
6. `check_explorer_adr.py` — explorer schema ADR compliance
7. `check_gateway_coverage.py` — gateway coverage report present and above threshold
8. `check_source_doc_reconciliation.py` — source-doc reconciliation file up to date
9. `check_rust_test_target_compile_coverage.py --self-test` then `check_rust_test_target_compile_coverage.py` — asserts every workspace crate with a `tests/` directory is type-checked by an unconditional PR-stage job, and that every `cargo test … --lib` job compiles its own crate's `tests/` binaries (issue #1295). See [Rust `tests/` compile coverage](#rust-tests-compile-coverage). Needs PyYAML, installed by the step above it.
10. `check_evidence_scripts.py --self-test` then `check_evidence_scripts.py` — sweeps every `.github/scripts/...` path named in `docs/**` or `.github/workflows/**` for two of the shapes catalogued in [false-green-shapes.md](./false-green-shapes.md) (issue #1235).
11. `check_false_green_catalogue.py --self-test` then `check_false_green_catalogue.py` — asserts [false-green-shapes.md](./false-green-shapes.md) exists, every section carries its four required parts, and every workflow path and issue number it cites resolves (issue #1272).
12. `check_governance_docs.py --self-test` then `check_governance_docs.py` — `governance-decisions.md`, `prd.md` and `architecture.md` keep the no-voting `applyReceipt` model and carry none of the deleted RouterGovernance voting text; every other Markdown file under `docs/` carries none of that text either, nor the pre-1698 two-call batch of release plus `setDefaultWeights` (QA plan v1 C1; `docs/code-review/` and the QA plan are records and are not read); security-model section references resolve (issues #1646, #1698); every `architecture.md` section reference resolves to a heading, a sibling `robotmoney-frontend` reference excepted, and `architecture.md` keeps its `## 8. Guardrails` section with non-empty `### Invariants` and `### Negative Invariants` lists (QA plan v1 W4).
13. `.github/scripts/tests/test_check_no_router_governance_voting.sh` then `.github/scripts/check_no_router_governance_voting.sh` — no tracked file under `clients/` names, encodes or binds RouterGovernance `propose`, `vote` or `execute` (issue #1698).
14. `scripts/ci/check_reusable_workflow_permissions.py --self-test` then `scripts/ci/check_reusable_workflow_permissions.py` — every job that calls a local reusable workflow grants at least the token permissions each called job asks for, followed through nested calls; a caller with no permissions block is refused. A shortfall makes GitHub refuse the whole run as `startup_failure` (QA plan v1 T1, see [section 29](#29-nightly-twin-fork-nightly-twin-fork)). Needs PyYAML.
15. `check_shipped_issue_markers.py --self-test` then `check_shipped_issue_markers.py --verify-issue-state` — no not-yet-implemented marker under `docs/` (the script's `MARKER` pattern) cites an issue whose work has landed: the script's `SHIPPED` list offline, and every cited issue's state through `gh`. Every such marker cites an issue (the `UNTRACKED` rule). `prd.md`, `architecture.md` and `security-model.md` state the executor policy that `DeployTimelock.s.sol` `EXECUTOR_POLICY` records. `docs/code-review/`, `docs/archive/` and the QA plan are records and are not read (QA plan v1 W1, issue #1817, review F5 and CS-7).
16. `check_doc_test_citations.py --self-test` then `check_doc_test_citations.py` — every Solidity test a doc under `docs/` cites exists: `<File>.t.sol::<name>` (and a later `::<name>` in the same paragraph), `<Contract>.test_<name>` and a backticked bare `test_*` name resolve to a declared function or contract under `contracts/`, a bare Rust or TypeScript test name to a word in the code outside `docs/`, and a `<File>.t.sol:<N>` cite lands on a function line (a range `<N>-<M>` stays inside the file). `docs/code-review/`, `docs/archive/`, `docs/adr/`, `docs/product/`, the QA plan and the two ADR-0010 records (`unified-vault-spec.md`, `base-tokenized-stocks-research.md`) are not read (QA plan v1 W5, issue #1798: `redeem-gas-1482.md` cited a core 1778 fork test that never landed).

- `nightly-and-release-checks` — Bun gates that run on every PR: the nightly dispatch list self-test (`bun scripts/ci/check-nightly-dispatch-selftest.ts`), the Twin chain CI wiring self-test (`bun scripts/devnet/check-twin-chain-ci-selftest.ts`), and the core has no dependency on devops gate.

**No devops dependency gate.** `bun scripts/ci/check-no-devops-dependency.ts` (unit test: `scripts/ci/check-no-devops-dependency.test.ts`, which plants each violation) fails when a core workflow, script, test or doc contains a checkout of the devops repository, the devops read token, the driver-directory variable or an import path into a devops checkout. The dependency direction is devops to core only: devops checks core out, core is public and checks nothing of devops out. The allowlist is in the script: the four files that name the strings to ban them (this gate, its test, the deleted-path gate and its test), a line that says devops checks core out, and an issue reference such as `robotmoney/devops issue 53` (history). The deleted-path gate (`deleted-stage-gate`, suite 28) bans the same strings in its own grep.

**Contract QA runbook gate.** `bun scripts/runbook/validate-contract-qa.ts` (unit test: `scripts/runbook/validate-contract-qa.test.ts`, which plants each drift) fails when `docs/runbooks/contract-qa/template.yaml` or a release file under `releases/` does not parse, when a release file drops, edits or reorders a template step (a release pinned to `templateSha` is checked against the template at that commit, read from git; an unpinned release is checked against the current template), when a step reads state no earlier step writes, when a command names a verb or flag that one of the CLIs the gate models does not have (its `KNOWN_TOOLS`: the `publish-contracts` CLIs, `scripts/stage/core-stack.ts`, `target/debug/rmpc` and the `scripts/` helpers; `cast` and `forge` are not modelled), or when a file holds a credential or a keyed RPC URL. The check runs in the `nightly-and-release-checks` job of suite 13 on every pull request. A production run is a separate, run-time check: `--release R --target production --runnable` refuses while an owner decision is open.

**Steps — `schema-validators` job:**
1. Checkout repository
2. Install Python
3. `check_explorer_migrations.py` — single-canonical-home invariant: migration files exist only in `services/explorer-indexer/migrations/`, no duplicates elsewhere

---

### 16. ABI drift gate
**File:** `.github/workflows/suite-16-abi-drift.yml`
**Environment:** `none` (Foundry + Bun + Rust toolchains, no chain)
**Tier / triggers:** LIGHT — `pull_request` filtered on `contracts/**`,
`foundry.toml`, the drift-gated binding files, `clients/rust-payment-client/abi/**`,
`services/explorer-indexer/src/abi.rs`, and this suite's own scripts; plus
`push` to `dev` / `dev-phase-*`.

Foundry's `out/` is the single canonical ABI source. Every hand-maintained copy
drifts, and history says so: the indexer shipped live ABI drift (#366), the dapp
called a router selector no contract defined (#1281), and `registryAbi.getVault`
decoded a `VaultRegistry` shape that no longer existed (#1348).

**Three independent gates, in increasing cost order:**

1. **Un-gated binding inventory** (`check_abi_binding_inventory.py`, issue #1346).
   `generate_abi_bindings.sh`'s header is the inventory of every client ABI
   binding, split into drift-gated and un-gated. The check fails when a binding
   exists on disk but appears in neither block, when an un-gated entry cites no
   tracking issue, when the cited issue is not OPEN (`--verify-issues-open`, via
   `gh`), or when a file claimed as drift-gated is not actually named in this
   workflow's `git diff --exit-code`. It replaces a comment that said "known
   schema drift, tracked separately" and named no issue for four files — while
   two more had joined the directory unlisted. #1362 then regenerated six of the
   seven un-gated files from their artifacts and moved them into gate 2. #1464 then
   resolved the last, `MockVault.json`: clients bind to the compiler-owned,
   interface-only `contracts/interfaces/IVault.sol` (generated as `IVault.json`,
   in gate 2). No deployed vault inherits it, because vault bytecode is frozen.
   No file is un-gated now. Self-tested
   (`--self-test`) against seven synthetic defect shapes before the real run.
2. **Regenerate and diff.** `forge build`, then `generate_abi_bindings.sh`, then
   `git diff --exit-code` over `Erc20.json`, `RobotMoneyGateway.json`,
   `VaultRegistry.json`, `PortfolioRouter.json`, `RouterGovernance.json`,
   `TimelockController.json`, `InvestmentCommitteePolicy.json` (deprecated
   2026-10-20, see IC-1019; the binding stays until the ABI set is regenerated),
   `ConsensusRecommendationReceipt.json`, `IVault.json` and `abi.generated.ts`. Fix a failure by
   running those two commands locally and committing the result. The six added by
   #1362 were hand-trimmed excerpts; one of them, `VaultRegistry.json`, had
   drifted to a `getVault` shape no deployed contract returns, so `rmpc
   get-vaults` and `rmpc get-vault` could not decode a real registry response —
   the rmpc half of #1348.
3. **Indexer topic-0 cross-check**
   (`cargo test -p explorer-indexer --lib -- abi::tests::event_topics_match_foundry_artifacts`,
   issue #1346). Re-derives 27 event topic-0 hashes from the `out/` artifacts
   built in step 2 and compares them to what the indexer filters `eth_getLogs`
   on. This is the only gate that reads Solidity: suite 8's `abi_drift_gate`
   compares `abi.rs`'s three hand-maintained copies of every signature *only to
   each other*, so all three can be consistently wrong and it stays green. The
   test lives here rather than in suite 8 because this is the only job that both
   compiles the contracts and runs Rust. It panics with instructions when `out/`
   is absent rather than skipping, and runs under
   `cargo_test_require_executed.sh` so a zero-collected run is red.

**Gotchas:**
- The job runs `forge build` before generation, so `out/` always reflects
  current sources rather than a cached artifact.
- The job does not commit; contributors commit the generated files so the diff
  is reviewable in the PR.
- Step 3 runs one named `--lib` test and deliberately does not compile
  `explorer-indexer`'s `tests/` binaries — it is not that crate's unit gate
  (suite 8 and suite 4's `--all-targets` are). See the step comment.
- `generate_abi_bindings.sh` emits BOTH basket vaults (`AgentTokenVault` and
  `ProtocolAssetVault`) into `abi.generated.ts`, and
  `clients/dapp/tests/unit/abi-parity.test.ts` checks the hand-maintained
  `BASKET_VAULT_SHORTLIST_ABI` against each. Until #1364 only `AgentTokenVault`
  declared `shortlist()`, so the dapp called a selector `ProtocolAssetVault` did
  not have and its composition panel rendered "unavailable". Pairing the
  fragment against every basket vault is what turns the next such omission red.

---

### 18. Secrets scan (gitleaks)
**Suggested file:** `.github/workflows/suite-18-secrets-scan.yml`
**Environment:** `none`
**Trigger paths:** All PRs (no `paths:` filter — secrets can appear in any file)

Runs [gitleaks](https://github.com/gitleaks/gitleaks) on every PR commit to
detect accidentally committed credentials before they reach the default branch.
The gate is intentionally path-unfiltered: a secret committed to a test fixture,
a config file, or a doc is just as dangerous as one committed to source code.

**Design rationale (security-model.md §13):**
- A pinned gitleaks binary is used rather than the latest release so the
  detector behaviour is deterministic and upgrades are deliberate.
- The configuration (`.gitleaks.toml`) extends the upstream built-in provider
  ruleset (`[extend] useDefault = true`) so that upstream rule improvements
  (new provider patterns for AWS, GCP, GitHub, Stripe, etc.) flow in
  automatically when the pinned action version is bumped.
- An allowlist in `.gitleaks.toml` covers known-safe test fixtures (Hardhat
  deterministic devnet keys, public on-chain addresses). Every allowlist entry
  carries a comment naming the fixture it covers. Real credentials are never
  allowlisted. When a fixture is removed, its allowlist entry must be deleted too.

**Jobs:**
- `secrets-scan` — single job; runs immediately on every PR

**Steps:**
1. Checkout repository (full history — `fetch-depth: 0` so gitleaks can diff the PR range)
2. Run gitleaks at pinned version with `--config .gitleaks.toml` — scans all commits in the PR; exits non-zero on any unallowlisted secret pattern, blocking merge

---

### 18b. Security gates (cargo-audit, bun-audit, CSP)
**Suggested file:** `.github/workflows/suite-18-security-gates.yml`
**Environment:** `none`
**Trigger paths:** `Cargo.lock`, `clients/dapp/bun.lock`, `clients/dapp/package.json`, `clients/dapp/scripts/audit-deps.sh`, `clients/dapp/scripts/check-csp.sh`, and the workflow file itself

**Jobs:**
- `cargo-audit` — Rust dependency vulnerability scan; runs immediately on every PR
- `bun-audit` — JavaScript/TypeScript dependency vulnerability scan; runs in parallel with `cargo-audit`
- `csp-gate` — Content-Security-Policy strict-mode assertion; runs in parallel with the audit jobs

**Design rationale (issue #804, #813, #835):**
Three fast, dependency-driven security gates that catch vulnerability advisories and policy violations before review, not after deployment. Each gate:
- Runs on every PR without devnet or chain cost (pure static analysis)
- Blocks merge on violations via exit status
- Uses a transparent, auditable allowlist for pre-existing sub-critical advisories with dated expiry comments

**Cargo audit (Rust dependencies):**
Scans every `Cargo.lock` in the repo — the root workspace lockfile, which covers all workspace members including `services/explorer-indexer`, `testing/doctests`, `testing/ethereum-testnet/e2e-rust`, and `testing/fork-e2e-rust` — against the RustSec advisory database. Advisory allow-list and severity policy live in `.cargo/audit.toml` (issue #813):
- Blocks on any HIGH or CRITICAL advisory (CVSS ≥ 7.0)
- Downgrades unmaintained and notice advisories to warnings
- To accept a known low-risk advisory temporarily, add its RUSTSEC id to the `ignore` list in `.cargo/audit.toml` with a reason and expiry comment

Installation method: cargo-audit is installed via `cargo install cargo-audit --locked` rather than the `rustsec/audit-check` GitHub action to avoid the action's `checks:write` permission requirement, which causes annotation errors on PRs from external contributors.

**Bun audit (JavaScript/TypeScript dependencies):**
Scans `clients/dapp/bun.lock` and `package.json` for JS advisory database (npm) hits via `bun audit --audit-level=high`. Blocks on any HIGH or CRITICAL advisory. Transitive HIGH advisories are resolved by pinning patched versions via package.json `overrides` wherever an in-line patched release exists — currently axios ^1.18.0, brace-expansion ^1.1.18, js-yaml ^4.3.1, nanoid ^3.3.18, postcss ^8.5.18 and socket.io-parser ^4.2.7 (issues #813, #1202). Only advisories with no upgrade path are added to the accept-list, which as of 2026-08-24 holds four entries (ws, vite, form-data, hono); the fourteen entries that the overrides made obsolete were pruned in #1202, because a suppression that no longer matches anything silently re-accepts the vulnerability if a dependency drifts back onto it. The `--audit-level=high` flag (bun's native severity control; the previous `--level high` was unrecognized and silently ignored) suppresses sub-HIGH advisories from both output and exit code. Implementation: `bun audit` is wrapped by `clients/dapp/scripts/audit-deps.sh` (issue #835), which runs the same allow-list logic used by suite 9 (dapp-quality), so accepted-advisory justifications live in exactly one place.

**CSP gate (Content-Security-Policy):**
Runs `clients/dapp/scripts/check-csp.sh` (shipped in issue #735). The script:
1. Installs dapp dependencies via `bun install --frozen-lockfile`
2. Builds the production bundle
3. Serves it with `vite preview` and asserts the `Content-Security-Policy` response header is present and contains `script-src` but neither `unsafe-inline` nor `unsafe-eval`
4. Checks the baked-in `<meta http-equiv="Content-Security-Policy">` tag in `index.html`

Catches CSP weakening by dependency upgrades before deployment.

**Steps — `cargo-audit` job:**
1. Checkout repository
2. Install Rust toolchain (stable)
3. Rust cache via `Swatinem/rust-cache@v2`
4. `cargo install cargo-audit --locked`
5. `cargo audit` — exits non-zero on any HIGH/CRITICAL advisory or on any unallowlisted advisory

**Steps — `bun-audit` job:**
1. Checkout repository
2. Install Bun
3. Change to `clients/dapp` and run `bash scripts/audit-deps.sh` — wraps `bun audit --audit-level=high` with allow-list logic; exits non-zero on any unallowlisted HIGH/CRITICAL advisory

**Steps — `csp-gate` job:**
1. Checkout repository
2. Install Bun
3. Change to `clients/dapp` and run `bun install --frozen-lockfile`
4. `bash scripts/check-csp.sh` — build production bundle, serve via vite, verify CSP headers; exits non-zero if CSP is too permissive

---

### 19. ERC-4626 precondition checks
**Suggested file:** `.github/workflows/suite-19-erc4626-demo-tvl-matrix.yml`
**Environment:** `anvil`
**Trigger paths:** `contracts/test/ERC4626PreconditionChecks.t.sol` and the workflow file itself
**CI_CLASS:** `feature-correctness` (declared at workflow level in issue #1371)

**Tier:** HEAVY — the `dev` merge gate. Runs on every `pull_request` targeting `dev` (no `paths:` filter) and on `push` to `dev`.

**Jobs:**
- `erc4626-precondition` — matrix-sharded forge tests (`EXIT_FEE_BPS` = 0, 30, 100)

The `demo-tvl` job and its `full_stack_demo_tvl` test were deleted in core 1488. They depended on demo depositor seeding, which the one deployment scheme removes. Vault TVL on stage comes from the real seed and the govern matrix.

**Steps — `erc4626-precondition` job (matrix over exit_fee_bps: [0, 30, 100]):**
1. Checkout repository (recursive submodules)
2. Install Foundry toolchain
3. `forge test --match-contract ERC4626PreconditionChecks --fuzz-runs 256 -vv` with `EXIT_FEE_BPS` env var set to the matrix value

---

### 21. Nightly full-suite orchestrator (nightly-full-suite)
**Suggested file:** `.github/workflows/suite-21-nightly.yml`
**Tier:** nightly
**Environment:** `none` (dispatches other suites; no direct job steps)
**Trigger:** `schedule` — `0 2 * * *` (02:00 UTC) + `workflow_dispatch`

Dispatches every registered CI suite against the `dev` HEAD via the GitHub
`workflow_dispatch` REST endpoint. Ensures every suite receives a daily green/red
signal regardless of whether that day's commits touch each suite's path filters.

**Design rationale:**
- Several suites are intentionally not triggered on feature-branch PRs (e.g. suites
  that call live external services, or heavy devnet matrices) and may go days
  without running if no commit touches their path filters. The nightly orchestrator
  guarantees at least one run per day.
- `workflow_dispatch` on each target workflow is used rather than duplicating job
  steps — each suite retains its own timeout, matrix, and concurrency settings.
- Scheduled at 02:00 UTC to avoid collision with other nightly workflows (e.g.
  suite-11b opencode-headless at 03:17 UTC).
- The default `GITHUB_TOKEN` provides the `actions: write` permission required for
  `workflow_dispatch` on private repositories.

**Jobs:**
- `dispatch-all-suites` — single job; iterates over all suite workflow files and
  calls `gh api` (workflow dispatches) against `dev`; any failed dispatch fails the job
- Self-test: `scripts/ci/check_nightly_dispatch_list.py` (run in suite 13)
  fails when a suite workflow is missing from the dispatch list.

**Steps — `dispatch-all-suites` job:**
1. Dispatch each suite workflow via `gh api` against the `dev` ref, counting failures
2. Exit 1 when any dispatch failed (suites run independently; the job fires the dispatches)

---

### 22. Contracts invariant spec tests (contracts-invariant-spec-tests)
**File:** `.github/workflows/suite-22-formal-verification.yml`
**CI class / tier:** `feature-correctness` — LIGHT
**Environment:** `none` (Foundry only)
**Trigger:** `pull_request` (any base branch — incl. PRs into `phase/*` staging
branches) scoped to `contracts/**`, `foundry.toml`,
`docs/technical/smart-contract-invariants.md`, and the workflow itself; `push` to
`dev`/`dev-phase-*`; `workflow_dispatch`.

Runs the invariant spec harness (`contracts/test/fv/`) that makes
[`docs/technical/smart-contract-invariants.md`](../technical/smart-contract-invariants.md)
executable. There is no prover: every step is plain `forge test` (unit, bounded fuzz and
invariant tests). The workflow and job were named `contracts-formal-verification` and
`forge-formal-verification` until QA plan v1 T5, which renamed them for what runs. The file
name and the `fv/` directory keep the old name. Stood up by the `contract-security-remediation-2` phase scout
(issue #964) BEFORE any remediation, so every later fix is pinned by the
invariant it restores.

**Design rationale:**
- **Coverage-map gate (1:1 spec↔test).** `contracts/test/fv/CoverageMap.t.sol`
  parses every invariant ID out of the spec markdown and asserts each maps to
  exactly one entry in `contracts/test/fv/InvariantRegistry.sol` (and vice
  versa). Adding an invariant to the spec without a corresponding FV test, or a
  stray registry entry, fails the build. The invariants-spec path is in the PR
  trigger allowlist (and `foundry.toml` already grants read on `docs/`), so a
  spec-only PR still runs this gate — which is why this code suite deliberately
  does **not** carry a `**.md` docs path-ignore.
- **Per-invariant tests.** `contracts/test/fv/FvInvariants.t.sol` drives one
  named test per ID. A red (🔴) invariant would be `vm.skip`-ped through `_skipRed`
  with a reason naming its remediation issue; none is skipped today. The tests
  named `expectedFail` assert the registry entry, which is HOLDS for each of them.
- **Dedicated harnesses.** `CustodyMultiVault` (SUP-1/CUST family-wide custody),
  `TwapManipulation` (ORA-7), and `DeployAssertions` (ACL-1/ORA-3/ORA-6) carry
  the cross-family / TWAP-manipulation / post-deploy proofs. There is no
  stale-oracle harness: `StaleOracleRedemption.t.sol` was deleted in #1505 with
  the Chronicle oracle, and SUP-5 is a registry assertion in `FvInvariants`. The
  `contracts/test/fv/` step's floor of 37 is CustodyMultiVault 4,
  TwapManipulation 2, DeployAssertions 3, CoverageMap 3 and FvInvariants 25.
  `CustodyMultiVault` executes SUP-1
  live against the RobotMoneyVault, BasketVault and RwaBasketVault families plus a
  negative case proving the shared predicate is not vacuous — it contains no
  `vm.skip` (#1213).
- LIGHT tier because the suite is forge unit + static-guard + bounded fuzz and
  finishes in well under a minute; running it on every PR (no base-branch filter)
  is what gates PRs into the phase staging branch.

**Jobs:**
- `forge-invariant-spec-tests` — `forge build`; `forge test --match-path
  'contracts/test/fv/**'`; then the anchoring proofs
  (`CustodyInvariant|CustodyInvariantGuard|AdapterDelegatecallGuard|AccessRoles`).
  Both test steps run through `.github/scripts/forge_test_require_executed.sh`
  (QA plan v1 T5): `forge test` exits 0 when its filter matches nothing. The
  floors are the step's test counts, 37 in `contracts/test/fv/` and 40 in the
  four anchoring contracts. A skipped test does not pass, so a new red invariant
  lowers the floor by one. `.github/scripts/check_executed_floors.py` (suite 14)
  fails when a floor and the count differ.

---

### 28. Core stages (core-stages)
**File:** `.github/workflows/suite-28-core-stages.yml`
**CI class / tier:** `feature-correctness` (offline job), `system-correctness` (Twin chain job)
**Environment:** `none` for the offline jobs; the Twin chain (918453), started by the job itself, for the rehearsal
**Trigger:** `pull_request` (no path filter; the rehearsal skips drafts); `push` to `dev` and `releases-*`; tags
`v*.*.*`; `workflow_dispatch`; `workflow_call` (the nightly Twin fork, suite 29, passes its one pin).

**System split (owner decision, 2026-10-19).** The vaults system and the rmpc gateway system are separate systems (`docs/architecture.md` §1). This suite deploys, verifies and governs both in one Twin run, as the deployed release does. The system split review records the differences (`docs/code-review/20261019-vaults-gateway-split/20261019-code-review-internal-claude-opus-5-5-system-split.md`).

There is one deploy driver: the publish-contracts CLI (`bun publish-contracts/src/cli.ts`). The offline job runs `bun test scripts/deploy
scripts/ci`: the stage table (libs, vault, registry, router, gateway, governance,
ic, the proto, agent and rwa basket vaults, timelock, read by the CLI from the repo root) and the manifest rules. It is red when zero tests
pass. The `publish-contracts-tests` job runs in `publish-contracts/`: `bun install --frozen-lockfile`, `bun x tsc --noEmit`, then `bun test --timeout 60000`, and it is red when the pass count is zero (the stub forge and cast, no chain). Run these tests from `publish-contracts` or pass `--timeout 60000`: `bun test` from the repository root does not read `publish-contracts/bunfig.toml`, so the harness tests hit the default 5000 ms timeout. It is listed in the deploy-gate list of `check-sha-green` and is not a branch protection rule. The rehearsal job (`core-stages-twin-chain`, core 1523)
starts its own Twin chain at the run pin (`.github/actions/twin-fork`, no external RPC URL) and runs the `twin-publish` action with verify and govern:
throwaway keystores, the committed stage sheet (`deployments/twin-918453/stage-sheet.env`), gas and USDC for the deployer (the only Twin environment steps
besides the govern time warp), `publish` (stages 0 to 11), `verify` (12), `govern` (13), `verify` again, then one Safe self-administration row on the real SafeL2
(`govern --row safe-change-threshold`: the threshold raised to the owner count, then restored to the sheet's value by every owner's signature; QA plan v1 B5, finding T5,
so the rows of issue 1645 do not run only against the fake Safe of `govern.test.ts`). Any non-zero stage exit fails the job
(`publish-contracts/tests/twin-publish-script.test.ts` runs the step script `publish-contracts/src/ci/twin-publish.ts` with a stub CLI). The job writes `counts.json`
(`counts` per stage, `deployerNonce` read from the chain), checks that the keys equal the stage table and the nonce equals the sum plus the deployer's one prove-control transaction
(`publish-contracts/src/ci/rehearsal-counts.ts`), runs `bun publish-contracts/src/counts-drift.ts` (exit 0 when no `deployments/frozen-counts/<sha>.json` exists, non-zero naming each differing stage otherwise),
rebuilds the baseline frozen counts from its own adopted counts.json (`publish-contracts/scripts/freeze-counts.ts --from-adopted-run`, checked against the build and the Twin fork, then loaded with the strict 8453 rules by `rehearsal-counts.ts check-baseline`, issue 1733), and uploads `rehearsal-counts-<sha>` (counts.json, manifests, verifier labels, govern rows, self-administration rows). It runs on every push to `dev`, on a ready pull request and in the nightly (suite 29 calls this workflow, so suite 21 does not dispatch it).
The release procedure copies `counts` from the release SHA's artifact into `deployments/frozen-counts/<sha>.json`. The router, basket vault and timelock role proofs are labels of the one verifier. No key is passed in an argument.

The upgrade rehearsal job (`core-stages-twin-upgrade-lifecycle`, issue 1811, upgradeability stage 4) runs after `core-stages-twin-chain` (`needs: [pin, core-stages-twin]`, `if: !cancelled()` with the pin-success and draft guards, issues 1846 and 1861: unlike `always()` it starts no fork after a cancelled, superseded run), so the two 60-minute forks never load the rate-limited upstream at once and it restores the exact-pin RPC cache the rehearsal saved. It starts a second Twin chain at the same pin and runs the `twin-publish` action with verify, govern, the predeployed libraries and `sheet-overlay: deployments/twin-918453/upgrade-rehearsal.env` (`UPGRADE_MODE=upgradeable`), so the same release artifacts deploy upgradeable. The overlay names no `UPGRADE_FREEZE_DEADLINE`: `twin-publish` sets it to the pin block timestamp plus 365 days (issue 1846). `publish-contracts/src/ci/twin-upgrade-lifecycle.ts` then deploys a second copy of the gateway implementation from the build with the operator verb `deploy-implementation --proxy gateway` (issue 1861: linked to the live libraries, its code read back against the build, recorded in `implementation_deploys`, a rerun reusing the entry), upgrades the gateway proxy with `govern --row upgrade-proxy` (the real Safe and timelock; the row re-records the gateway manifest's implementation pin) and runs verify, schedules the freeze of all nine core proxies in one batch bound to the reviewed `upgradeability.json` with `govern --row freeze-upgrades --no-warp --max-wait 0` (exit 15 after the schedule), queues a second gateway upgrade, upgrades a populated v0.5.0-shaped receipt proxy with `govern --row upgrade-proxy --proxy receipt --migration receipt-submitter-roles` (issue 1910: the tool builds `migrateToSubmitterRoles(RouterGovernance)`, the step asserts the roles, the history and the refused second migration, and `evidence-check --governed-upgrades --rpc` reads the scheduled data back from the chain), executes the freeze with the same row, checks the run manifest's `proxy_upgrades` and `upgrade_freezes` as `evidence-check` does (issue 1859), asks the Safe to execute the queued upgrade (the Safe tool refuses and a simulated execute reverts with `UpgradesAreFrozen`), runs verify again (core immutability claimed) and checks the record with `evidence-check --upgrade-lifecycle --rpc`. The job asserts the `evidence ok (upgrade lifecycle: ... chain read)` line and the record's fields, and uploads `upgrade-lifecycle-<sha>`. It never skips: a fork that does not start or any non-zero step fails it. It is a required entry of the deploy-gate list of `check-sha-green` (`scripts/ci/required-checks.json`) although it reads the rate-limited Base upstream: an outage is recovered by re-running the failed job (see `check-sha-green`, `filter=latest`, pinned explicitly). In a prolonged outage, point the `BASE_UPSTREAM_RPC` secret at another provider and re-run the failed job; if the re-run logs `WARN: STALE PIN`, use Re-run all jobs so the pin job picks a fresh block (runbook, Green rehearsal only).

The v0.5.0 upgrade rehearsal job (`core-stages-twin-upgrade-from-v050`, issue 1927) runs after `core-stages-twin-upgrade-lifecycle` (`needs: [pin, core-stages-twin-upgrade]`, the same `!cancelled()`, pin-success and draft guards). It rehearses the v0.6.0 governed upgrade of the live v0.5.0 deployment (runbook 4.15) from a real v0.5.0 build, which the lifecycle job cannot: that job upgrades a proxy to a second copy of the same build. It checks out `release/v0.5.0-rehearsal` beside the workspace (a `git worktree`), starts a Twin chain at the FIXED Base block 52881000, and publishes the tag with that tag's own `publish-contracts/src/ci/twin-publish.ts` and committed Twin sheet (rehearsal kind, `deployments/twin-918453/upgrade-rehearsal.env`, verify, govern and the receipt path). The pin is fixed because the live RM V4 pool the v0.5.0 rmAGENT holds was drained at block 52881518: the tag's agent stage refuses its unlowered `VAULT_AGENT_MIN_POOL_LIQUIDITY` (1000000000000000) at any later block. After `forge build` of the workspace, `publish-contracts/src/ci/twin-upgrade-from-v050.ts` runs the publish-contracts commands of runbook 4.15 exactly as it lists them (`UPGRADE_FROM_V050_COMMANDS`, which `upgrade-runbook-drift.test.ts` holds equal to the runbook): `deploy-implementation` and `govern --row upgrade-proxy` for the gateway and for the receipt (with `--migration receipt-submitter-roles`), `govern --row retire-vault` for rmAGENT under the applied receipt vector the tag's publish left (nothing clears it, issue 1988: the driver fails unless the vector is active before the retire and unchanged after it), `verify` and both `evidence-check` commands, each with `--core-dir` and `--core-sha` of the v0.5.0 checkout and `--upgrade-build` of the workspace. It refuses a sheet whose `VAULT_AGENT_MIN_POOL_LIQUIDITY` is not 1000000000000000. The `BASE_UPSTREAM_RPC` secret must serve archive state at block 52881000: the job asserts the started fork reports that pin (`steps.fork.outputs.pin-block`) before it publishes, so an upstream that stopped serving it fails there, by name, and never repins past the drain into the agent stage refusal. The job asserts its record with `jq`: two executed `proxy_upgrades` (gateway, receipt) whose `from_implementation` is the v0.5.0 implementation of the v0.5.0 `upgradeability.json`, one executed retirement, the applied vector active before and after the retire and unchanged, `routerEligibleCount()` 3, `retired()` true on rmAGENT, `RECEIPT_RELEASER_ROLE` on RouterGovernance only, `ADMIN_ROLE` on the timelock only, and a second `migrateToSubmitterRoles` reverting `InvalidInitialization`. It uploads `upgrade-from-v050-<sha>`. It never skips and has no `continue-on-error`. It is a required entry of `scripts/ci/required-checks.json` on the lifecycle job's terms.

---

### 28b. Core stack selftest, deleted-path gate and stage tooling tests
**File:** `.github/workflows/suite-28-core-stack-selftest.yml`

`scripts/stage/core-stack.ts` (Bun TypeScript, called directly; the old `core-stack.sh` shim is deleted) is the boot, health, record and parity tool. It deploys and governs by calling publish contracts (`publish-contracts/` in this repo, Bun TypeScript) with the Twin chain argument list. Jobs:
- `core-stack-selftest` — `bun test scripts/stage/tests/core-stack.test.ts` against a fake runner standing in for publish contracts: the exact argument list with the `keystore:PATH:PASSFILE` signer, a fresh keystore set per boot, exit-code passthrough, the four-manifest count, the govern row gate (tx hash and receipt status 1 on every row), the usage errors and the record contract with its schema drift guard. Executed-test floor held in the workflow. Core 1549: the file also runs `chain up`, `chain down`, `chain status` and `dapp status` against a fake `docker compose` (the stage chain, the deploy job and the dapp stack are containers, `core-stack.ts` starts no host process) and holds every status class line and exit code verbatim; the floor was raised with those cases.
- `stage-container-rules` (`feature-correctness`, runs on drafts) — `bun scripts/ci/check-stage-containers.ts .` plus `bun scripts/ci/check-stage-containers.test.ts` with its own executed-test floor. Fails on a Dockerfile `FROM` or a pulled compose image without a `@sha256` digest, on `docker.sock` in any stage compose file, Dockerfile or script, on `cargo build` without `--locked` or `bun install` without `--frozen-lockfile`, on a missing lockfile and on host process machinery in `core-stack.ts`. Every rule has a mutation case.
- `stage-chain-container` (`system-correctness`, REQUIRED) — builds the chain image, starts the `twin-chain` service of `docker-compose.stage-chain.yaml` and asserts `eth_chainId` is `0xe03b5` on 18545 with curl and jq, the head reached the pin and keeps moving, the container is healthy and holds no Docker socket. Always removes the container.
- `stage-core-stack-containers` (`system-correctness`) — the real `bun scripts/stage/core-stack.ts chain up` on the runner: chain container, deploy job (the real publish contracts ceremony with the Safe handover; every stage manifest present), dapp stack. Then `chain status`, `dapp status`, `governance preflight` (host `cast` against the container chain), proof that every `anvil`, `smoke-test` and `forge` process sits in a docker cgroup, no container mounts the Docker socket, and `chain down` leaves no stage container and no work directory.
- `deleted-stage-gate` — `bun scripts/stage/check-deleted-stage-scripts.ts .` exits 0 only when the stage ceremony shell, the stage deploy script, the old core runner (`core-stages.ts`) and its assert scripts, the devops checkout action, the devops read token, the driver-directory variable, the deploy workflow and the Rust harness deployment (forge script calls, demo seeding, faucet funding) and the `core-stack.sh` shim are absent and `core-stack.ts` holds no deploy or ceremony logic.
- `stage-tooling-tests` — `bun test scripts/stage/tests`: the govern row parser, the sheet-diff allow-list (stage versus production sheet differ only in parameter lines), the label-diff (verifier labels on stage equal the mainnet set) and the gate.

---

## Integration-test target coverage

Every Rust suite here names its cargo test binaries **by hand** — `cargo test
--lib`, `cargo test --test migrations`, `cargo test --test ${{ matrix.binary }}`.
There is no bare `cargo test` over a package and no `--test '*'` anywhere in
`.github/workflows`. That is a deliberate trade (some targets need Postgres, a
devnet, or a fixture, and running everything everywhere would be unaffordable),
but it has one consequence that was never handled: **adding a `tests/<name>.rs`
file adds zero CI coverage unless a workflow is edited in the same change, and
until issue #1282 nothing detected the omission.**

When the check below was first run it found **35 of 83** integration targets
executed by nothing at all — including both explorer-indexer reorg suites
(issue #1283 shipped through that hole), `clients/explorer-api/tests/endpoints.rs`
(1090 lines, 42 tests) and `clients/rust-payment-client/tests/cli_deposit.rs`
(687 lines, 10 tests).

### The two guards, and what each one cannot see

| Guard | Catches | Blind to |
|-------|---------|----------|
| `.github/scripts/cargo_test_require_executed.sh` | a target a job **does** invoke that collects **zero** tests (testcontainer absent, `--test` filter matched nothing) | a target no job invokes at all |
| `.github/scripts/check_cargo_test_target_coverage.py` | a target **no workflow executes** | whether the tests that do run assert anything |

They are complements. Wrap a newly wired target in the first so a silent skip is
red; the second is what stops the next target from being forgotten entirely.

### The coverage check

Run in suite 4 (`cargo-test-target-coverage` job, quick tier, pure Python — no
toolchain, seconds):

```
python3 .github/scripts/check_cargo_test_target_coverage.py --list-executed
```

It enumerates every `tests/*.rs` file across the workspace members, resolves
which `(package, target)` pairs the workflows actually execute, and exits
non-zero on any pair that is neither executed nor allowlisted.

Matching is **package-scoped, not a grep**, because a name-only match lies in
both directions:

- `endpoints` and `cli` appear as prose in workflow comments, so a grep calls
  them covered while nothing runs them.
- suite-05 runs `--test governance` from `testing/fork-e2e-rust`, so a grep also
  credits `testing/smoke-test/tests/governance.rs` — a different crate's file
  that has never executed anywhere.

The resolver therefore reads `-p`/`--package`, `--manifest-path`, or the step's
effective `working-directory`, expands `${{ matrix.* }}` (both the axis and
`include:` forms), and refuses to credit `cargo test --no-run` (compiles only)
or a `--lib`/`--bins`/`--doc` run (builds no integration target).

It expands every `$(...)` and backtick body before tokenising, and it credits
only a real `cargo test` invocation or the executed-count wrapper (QA plan T2).
Before that, suite 27's `out="$(cargo test --lib 2>&1)"` read as one token and
fell through to "bare `cargo test`". That credited every rmpc integration target
to a run that builds none of them. An `echo "::error::cargo test ..."` line did
the same in suites 14 and 27. Those false credits hid two dark targets:
`rust-payment-client::write_seam_reverted_anvil` and
`smoke-test::govern_output_parse`. Both are now wired (suite 7 `rmpc-parity`
and suite 14 `smoke-test-guards`). A step marked `bare-cargo-test-allowed:`
expects `cargo test` to fail, so it is not credited either.

That marker is narrow (QA plan T3, issue #1683). It counts only on a line that
is nothing but a comment opening with it. It covers one `cargo test` command:
the first one below it. A run block gets one such command, however many markers
it carries. `check_no_bare_cargo_test.py` (suite 14 `smoke-test-guards`) fails a
marker inside an `echo` string or after a command, and a second bare
`cargo test --test` in the same block. Its fixtures live in
`.github/scripts/tests/test_check_no_bare_cargo_test.sh`.

A wrapped run is not enough either: the guard's default floor of 1 catches a
filter that matches nothing, not a test that stopped running (QA plan v1 T5).
`check_executed_floors.py` (suite 14 `smoke-test-guards`) reads every
`cargo_test_require_executed.sh` and `forge_test_require_executed.sh` call in
suites 5, 8 and 22, counts the tests the call selects from the source (targets,
`mod` files, libtest filters and `--skip`, `#[ignore]`, `parameterized_e2e!`
legs; forge path, contract and test filters, inherited tests, `vm.skip`), and
fails when the floor is missing or differs from that count. It also fails a bare
`forge test` or `cargo test` in those suites. Its fixtures live in
`.github/scripts/tests/test_check_executed_floors.sh`, which ends on the real
suite 22 with a floor lowered by one.

Its own failure paths are driven against synthetic workspaces by
`.github/scripts/tests/test_check_cargo_test_target_coverage.sh`, which also
performs the negative self-test on the real tree: it drops a synthetic
`tests/*.rs` into a workspace member, asserts the check goes red and names it,
then removes it. A guard whose failure path never executes is a guard nobody has
checked.

### The allowlist

`.github/cargo-test-target-allowlist.txt`, one `package::target` per line. Every
entry must carry a reason — a comment block immediately above it, or an inline
`#` comment on the same line. The check fails on an entry with **no** reason, on
a **stale** entry (the target is executed now), and on an **orphan** entry (the
file no longer exists). It is a debt ledger, not a mute button.

### Tier assignment for the targets wired by issue #1282

| Target | Suite / job | Tier | Resource | Measured |
|--------|-------------|------|----------|----------|
| `rust-payment-client::cli`, `cli_deposit`, `cli_status`, `cli_self_check`, and the eleven `cli_get_*` | 7 — `rmpc-parity`, step *rmpc CLI surface* | heavy | mockito + the built `rmpc` binary; **no chain, no Docker** | 67 tests, ~22s |
| `explorer-indexer::cursor_header_reorg`, `reorg_cursor_vault_status`, `account_history`, `account_position_vote_power`, `multi_vault`, `vault_detail`, `vault_registry` | 8 — `explorer-indexer-fast`, step *Indexer reorg + read-path suites* | quick | Postgres testcontainer (Docker only; no compose stack) | 47 tests |
| `explorer-api::endpoints`, `router_introspection`, `cors`, `canonical_schema` | 8 — `explorer-api-committee-regime` (the committee and regime suites were retired in core 1891; the job name stays because it is a required check), step *explorer-api HTTP contract, CORS, router shape, schema parity* | quick | Postgres testcontainer; `router_introspection` needs none | 49 tests, ~2m40s |
| `watchdog::cursor_and_volume` | 20 — `watchdog-integration` | quick | Postgres testcontainer | 7 tests, ~25s |
| `watchdog::liveness` (issue #1378, wired at creation) | 20 — `watchdog-integration`, step *Watchdog liveness heartbeat integration test* | quick | Postgres testcontainer + the built `watchdog` / `watchdog-liveness` binaries | 8 tests, ~90s |
| `rmpc-logging::workspace_uses_shared_facade` | 4 — `lint`, step *Workspace logging facade guard* | quick | none (source-text walk) | 5 tests, ~0s |

Measured figures are wall-clock on a developer machine with a warm cargo cache;
CI is slower, and the affected jobs' `timeout-minutes` were raised to match
(suite 7 `parity` 20→25, suite 8 `fast` 25→35, suite 8 `explorer-api` 25→40,
suite 20 `pg` 20→30).

### Resolution of the five smoke-test devnet targets (issue #1311)

> **Historical.** This section records the decision of issue #1311, taken when `Fixture` booted the Geth + Lighthouse compose stack. The devnet is now the Twin chain (core 1498, 1496): a test binary shares one pinned fork through `TWIN_RPC_URL`, and `fund_usdc` asserts the Twin environment steps. The `faucet_eth` and `faucet_rm` targets wired here were deleted in core 1488 with the dapp faucet funding, and `demo_seeding` and `full_stack_demo_tvl` went with demo depositor seeding. Suite 14's devnet matrix today is `[cli_meta, fixture_meta, fund_usdc, governance, twin_fork_env]`. The `fund_usdc`, `governance` and `vault_deposit_redeem` outcomes below still stand.

`smoke-test::faucet_eth`, `faucet_rm`, `fund_usdc`, `governance` and
`vault_deposit_redeem` were allowlisted (issue #1282) rather than wired,
because each calls `smoke_test::Fixture`, which boots the full Geth +
Lighthouse compose stack, deploys with forge, and seeds — the same cost as one
row of suite 14's devnet matrix. Rust does not run `Drop` on statics at
process exit, so the stack outlives the binary and a second binary cannot
reuse it, meaning each target needs its own runner. Issue #1311 measured the
actual cost and resolved all five:

| Target | Outcome | Reason |
|--------|---------|--------|
| `fund_usdc` | wired — suite 14 devnet matrix row | real-signed-transfer + Geth-not-Anvil assertions (issue #255 step 7); no other executed target asserts the devnet backend rejects Anvil cheat RPCs |
| `governance` | wired — suite 14 devnet matrix row | RouterGovernance deploy + admin-role and weight-setter-role wiring on the **actual `forge script Deploy` output** (issue #364, issue 1698); distinct from `rmpc-fork-e2e::governance` (suite 5), which exercises a hand-deployed governance stack's `applyReceipt` call on an anvil fork and never touches the devnet's real deploy script — neither `fixture_meta` nor any other executed target reads `fx.governance()` |
| `vault_deposit_redeem` | **deleted** | both of its assertions are already made by a suite that genuinely runs today: `vault_on_chain_state` (exitFeeBps==0, activeAdapterCount>=1) duplicates `smoke-test::fixture_meta::vault_has_zero_exit_fee_and_one_active_adapter`, already a suite-14 matrix row; `vault_deposit_redeem_round_trip` (deposit 1 USDC, redeem, assert USDC returned within tolerance) duplicates `rmpc-fork-e2e::vault_deposit_redeem_smoke` (suite-05 `anvil-goldens` group — confirmed executing for real against the checked-in fork fixture, `chain_id=8453 fork_block=48896605`, no skip). `rmpc-fork-e2e::devnet_adapter_round_trip` (suite-05 `geth-light` group) does **not** count as coverage despite naming the same scenario: it unconditionally self-skips in CI (`[fork-e2e] skipping: RMPC_FORK_RPC_URL not set`, `finished in 0.00s`) because that variable is never set anywhere in suite-05 — see issue #1239, which tracks provisioning it. The deleted test's docstring framing ("wired to the three real Aave/Compound/Morpho adapters") is therefore not independently re-proven by name anywhere; only the two narrower assertions it actually made (exit fee / adapter-count-`>=1`, and a generic deposit/redeem tolerance check) are covered by what runs |

**Overlap analysis against `smoke-test::demo_seeding`** (required by issue
#1311's scope, in addition to the `rmpc-fork-e2e::vault_deposit_redeem_smoke`
and `rmpc-fork-e2e::governance` analyses above): `demo_seeding`'s assertions
(`testing/smoke-test/tests/demo_seeding.rs`) are limited to
`VaultRegistry.listVaults()` returning three Active vaults,
`PortfolioRouter.getWeights()` matching the 8500/500/500/500 split, and all
three vaults reporting non-zero `totalAssets` after `seed_demo_depositors`. It
calls none of `fund_eth_from_harness` or `fund_rm_token`,
and reads no `exitFeeBps` / `activeAdapterCount`. It does call
`self.fund_usdc(...)` indirectly, via `seed_demo_depositors` funding each
simulated depositor before their deposit -- but only as unasserted setup
plumbing: `demo_seeding` never checks `fund_usdc.rs`'s distinguishing
behavior (the exact balance delta, the `Transfer` log's
`from=HARNESS_USDC_HOLDER` shape, signature recovery, or the Geth-vs-Anvil
backend check). No overlap with any of the five targets:

- `fund_usdc` — `demo_seeding` calls the same `fund_usdc` method as setup
  plumbing but asserts none of its distinguishing behavior (see above); the
  two targets are not redundant.
- `governance` — `demo_seeding` reads router weights as static config; it
  never touches `RouterGovernance`.
- `vault_deposit_redeem` — `demo_seeding` asserts `totalAssets` rose after
  seeding, not a redeem-returns-principal-within-tolerance round trip, and
  never reads `exitFeeBps` / `activeAdapterCount`.

**Why suite 14's matrix, not a push-to-`dev`-only tier or nightly:** the four
wired targets only add a `Fixture::new()` boot plus a handful of RPC
round-trips on top — no dapp-stack build, no indexer recompile, no reseed.
This PR's own first CI run against the new matrix
([run 33938728232](https://github.com/robotmoney/robotmoney-core/actions/runs/33938728232))
measured the new rows directly (the two faucet rows, since deleted, are omitted):
`fund_usdc` 18m01s, `governance` 17m28s — all landing right next to
`fixture_meta`'s 18m19s in the same run (the closest existing analog: boot +
several RPC/eth_call assertions, no heavier work), against `cli_meta` at
25m20s, `demo_seeding` at 20m00s, and `full_stack_demo_tvl` at ~46 min.
Locally (warm cargo cache, pre-pulled images), `Fixture::new()` boot-to-ready
plus the full contract-deploy pipeline was measured at 14m27s-14m32s across
two local runs of `governance` — consistent with the ~13-17 minute CI figures
above and with `cli_meta`'s own header, which already documents ~13-minute
CI chain-container readiness (issue #988) rather than the 60-120s the boot
log message claims. Because the devnet matrix runs in parallel (one runner
per binary), adding four more rows does not change suite 14's total
wall-clock — it stayed bounded by `full_stack_demo_tvl`'s ~46 min (issue #1371
has since halved that row to a single devnet bring-up, 24m39s, making
`cli_meta` at ~25 min the new bound) — but it
does add roughly four more `fixture_meta`-sized runners (~17-18 min each) to
every PR against `dev`, since suite 14 is a HEAVY-tier gate with no path
filter (unlike suite 5, which skips drafts). That runner-minute cost is the
deliberate trade being made here: real coverage of three faucet round-trips
and one production-deploy governance-wiring gap, none of which any other
suite tests, in exchange for accepting it on every PR rather than reserving
it for a push-to-`dev`-only or nightly tier. A push-to-`dev`-only or nightly
tier was considered and rejected: these targets guard code paths (faucet
drips, governance admin wiring) that dapp/rmpc consumers exercise directly,
so a regression should fail the PR that introduces it, not surface a day
later on `dev` or in a nightly run.

Wiring `governance` into CI for the first time immediately paid for itself:
it surfaced a real bug (a hardcoded function selector in the voting-power
read matched no function on `RouterGovernance`), which had never been caught
because the target had never executed anywhere. Fixed in the same PR. The
voting-power read is gone with voting (issue 1698).

`vault_deposit_redeem` needed no cost measurement because it is deleted, not
wired — its allowlist entry is removed along with the file.

## Rust `tests/` compile coverage

> Canonical for issue #1295. Enforced by
> `.github/scripts/check_rust_test_target_compile_coverage.py`, run in suite 13
> (`doc-validators`) on every PR.

### The failure class

A `tests/*.rs` integration binary is a **separate compilation unit**. A pub
struct that those binaries construct as a literal can gain a required field and
the crate's `src/` still compiles — only the test targets break. None of these
commands notice:

| Command | Compiles `tests/` binaries? |
|---|---|
| `cargo build --workspace` | no — lib and bin targets only |
| `cargo test -p C --lib` | no — the lib test target only |
| `cargo test --test one_binary` | only that one target |
| `cargo fmt --check` | no — never type-checks |
| `#[serde(default)]` on the new field | no — covers TOML deserialization, not Rust literals |
| `cargo clippy --all-targets` | **yes** |
| `cargo test --no-run` (unfiltered) | **yes** |

This is not hypothetical: on PR #1293 a required field was added to
`watchdog::config::Config`, five `Config { … }` literals across
`services/watchdog/tests/cursor_and_volume.rs` and `threshold_breach.rs` went
short, and the break reached compliance review.

### Relationship to `rust-lint` (suite 4)

`rust-lint` runs `cargo clippy --all-targets --all-features -- -D warnings` from
the repository root. The root manifest is a **virtual manifest with no
`default-members`**, so that one command covers every workspace member, and no
crate in the repo declares a `[features]` table — `--all-features` is therefore
the same target set as the default. **Every crate's `tests/` binaries are
type-checked by `rust-lint` on every PR, drafts included.** Coverage is complete.

So why did it not fail *before* review on #1293? Ordering, not coverage. On the
broken head `3a4280dc`:

| Job | Verdict | Wall clock from push |
|---|---|---|
| `robotmoney-swarm-plugin-checks` | success | 0:58 |
| `secrets-scan` | success | 1:37 |
| `dapp-lint-typecheck-vitest-build` | success | 7:37 |
| **`rust-fmt-clippy-doc-coverage` (`rust-lint`)** | **failure** | **8:56** |
| `watchdog-rate-monitor` (`watchdog-unit`) | cancelled — never reported | — |

The failure text was
`error[E0063]: missing field 'consensus_receipts' in initializer of 'watchdog::config::Config'`
at `services/watchdog/tests/cursor_and_volume.rs:170`.

Two things made that survivable long enough to reach a reviewer. First,
`rust-lint` is the **slowest** Rust job and the only one with `--all-targets`
coverage, so it reports last. Second — and this is the part worth fixing — the
job *named after the affected crate*, `watchdog-unit`, ran
`cargo clippy -p watchdog` (no `--all-targets`) and `cargo test -p watchdog
--lib`. Both are green against a fully broken `tests/` directory. A reader
checking "is the watchdog crate OK?" got a green answer from the wrong job.

### The two invariants

**(A) Reachability.** Every workspace member with a `tests/*.rs` file has its
test targets compiled by at least one *unconditional* PR-stage job — one whose
workflow triggers on `pull_request` with no `paths`/`paths-ignore` filter and
whose `if:` does not skip drafts. Today `rust-lint` satisfies this for all nine
crates. The guard exists so that dropping `--all-targets` from suite 4, or
adding a crate outside the workspace members list, fails red immediately.

**(B) Crate-local truthfulness.** Any job that runs `cargo test … --lib` for
crate C must compile C's `tests/` targets **in the same job**. A job that
presents itself as crate C's unit gate must not report green while C's test
binaries do not compile.

### Enumeration: every `cargo test … --lib` job

| Job (workflow) | `--lib` command | Crate | Has `tests/`? | Compiles them in-job |
|---|---|---|---|---|
| `rmpc-unit` (suite 6) | `cargo test --lib` in `clients/rust-payment-client` | `rust-payment-client` | yes (23 files) | **added #1295** — `cargo clippy -p rust-payment-client --all-targets` |
| `explorer-indexer-fast` (suite 8) | `cargo test --lib -- abi::tests::abi_drift_gate` | `explorer-indexer` | yes (13 files) | already — `cargo test --no-run` in `services/explorer-indexer` |
| `smoke-test-guards` (suite 14) | `cargo test -p smoke-test --lib`, `… --lib tests::` | `smoke-test` | yes (9 files) | **added #1295** — `cargo clippy -p smoke-test --all-targets` |
| `watchdog-unit` (suite 20) | `cargo test -p watchdog --lib` | `watchdog` | yes (3 files) | **added #1295** — `cargo clippy -p watchdog --all-targets` (was `cargo clippy -p watchdog`) |

### Enumeration: every crate with a `tests/` directory

| Crate | Path | `tests/*.rs` | Unconditional PR-stage compiler | Crate-local compiler |
|---|---|---|---|---|
| `rust-payment-client` | `clients/rust-payment-client` | 23 | `rust-lint` (suite 4) | `rmpc-unit` (suite 6) |
| `explorer-api` | `clients/explorer-api` | 8 | `rust-lint` (suite 4) | none — see exclusion note |
| `rmpc-logging` | `crates/rmpc-logging` | 1 | `rust-lint` (suite 4) | none — see exclusion note |
| `explorer-indexer` | `services/explorer-indexer` | 13 | `rust-lint` (suite 4) | `explorer-indexer-fast` (suite 8, skips drafts) |
| `watchdog` | `services/watchdog` | 3 | `rust-lint` (suite 4) | `watchdog-unit` (suite 20) |
| `doctests` | `testing/doctests` | 4 | `rust-lint` (suite 4) | `opencode-plugin-validate` (suite 11a, `paths:`-filtered) |
| `rmpc-e2e` | `testing/ethereum-testnet/e2e-rust` | 4 | `rust-lint` (suite 4) | suite 7 (`paths-ignore`, per-binary `--test`) |
| `rmpc-fork-e2e` | `testing/fork-e2e-rust` | 18 | `rust-lint` (suite 4) | suite 5 `cargo test --no-run --release` (`paths-ignore`) |
| `smoke-test` | `testing/smoke-test` | 9 | `rust-lint` (suite 4) | `smoke-test-guards` (suite 14) |

`testing/test-utils` has no `tests/` directory and is out of scope.

**Exclusion note (`explorer-api`, `rmpc-logging`).** Neither crate has a job
that runs its `--lib` tests, so invariant (B) does not apply to them and no
crate-local compile step is added. Their test targets are type-checked on every
PR by `rust-lint`, which satisfies invariant (A). `explorer-api`'s endpoint
tests are *executed* by suite 8's `pg` job; `rmpc-logging`'s
`workspace_uses_shared_facade.rs` is compiled by `rust-lint` but executed by no
named job — that execution gap is a separate concern from this compile gate and
is not addressed here.

---

## CI velocity tiers

CI is split into two tiers so a routine PR gets fast, cheap feedback while the
expensive devnet integration battery gates the `dev` merge boundary, where
cross-feature interactions actually land.

- **LIGHT (quick) tier** — runs on `pull_request`s to **any branch** and on
  `push` to `dev`/`dev-phase-*`. Forge unit + invariant tests, solidity
  fmt/natspec/slither, dapp lint/typecheck/vitest/build, rust fmt/clippy/doc-coverage,
  rmpc unit, abi-drift, doc/manifest guards, and the security gates. This is the
  feedback a routine feature PR blocks on.
- **HEAVY tier** — the `dev` merge gate. Runs on every `pull_request` targeting
  `dev` (no `paths:` filter, so the gate always reports for any branch merging
  into `dev`) and on `push` to `dev` for merged-commit coverage. The devnet e2e
  matrices (`rust-client-devnet-integration`, `smoke-test-devnet-boot-teardown`),
  the fork-adapter integration matrix (`fork-protocol-adapter-integration`,
  5 Twin chain slots, 20-25 min), the full-stack `dapp-e2e` Playwright suite,
  the `erc4626-demo-tvl-matrix`, and the `forge-coverage-gate` job all live here.
  Every branch that opens a PR into `dev` runs the full heavy battery before it
  can land.

Branch protection is not used (a won't-fix owner decision), so no check blocks a merge by GitHub setting.
The deploy gate is `check-sha-green` (below): it reads a deploy sha's check-runs before any approval.

Structural conventions (kept by convention; a prior static tier-guard workflow
that enforced them was removed as overkill):

- Every PR-triggered workflow declares `concurrency.cancel-in-progress` (enabled
  for `pull_request` events) with a `${{ github.ref }}`-keyed group, so re-pushing
  a PR cancels superseded runs while `push:dev` runs keep a distinct,
  non-cancelling lane and merged-commit coverage always completes.
- `rust-client-devnet-integration` (suite-07) and `smoke-test-devnet-boot-teardown`
  (suite-14) express their devnet binaries as a `fail-fast: false` job matrix —
  one runner per binary, each starting its own Twin fork at the run's one pin
  (a `pin` job outputs it, `.github/actions/twin-fork` consumes it). No devnet binary
  runs as a sequential step in a shared job, so the port-8545 contention that forced
  serial execution is gone.
- No Rust-building workflow uses a hand-rolled `actions/cache` for cargo
  target/registry; each uses `Swatinem/rust-cache@v2`.

### Tier mapping

Every workflow's `name:` and its tier.

| Workflow `name:` | Tier | Notes |
|------------------|------|-------|
| `forge-unit-invariant-coverage` | quick | `unit`/`invariant` are light (PRs to any branch); the `forge-coverage-gate` job is heavy and `if:`-gated to push-to-`dev` / PR-into-`dev` |
| `solidity-fmt-natspec-slither` | quick | |
| `rust-fmt-clippy-doc-coverage` | quick | includes `audit` job (cargo audit) and `test-target-coverage` (issue #1282 integration-test target inventory) |
| `fork-protocol-adapter-integration` | heavy | 5 Twin chain slots (20-25 min); gates PRs into `dev`; one pin per run, no saved fixture, optional secret `BASE_UPSTREAM_RPC` |
| `rust-client-unit-tests` | quick | |
| `rust-client-devnet-integration` | heavy | devnet e2e matrix (`smoke`, `scenarios`, `window_cap`, `withdraw`) |
| `explorer-indexer-migrations-reorg` | quick | |
| `dapp-lint-typecheck-vitest-build` | quick | includes bun audit --audit-level=high step (scripts/audit-deps.sh) |
| `dapp-e2e` | heavy | full-devnet Playwright suite |
| `opencode-plugin-validate-walkthrough-offline` | quick | |
| `openclaw-safety-walkthrough` | quick | |
| `doc-adr-runbook-migration-checks` | quick | |
| `smoke-test-devnet-boot-teardown` | heavy | devnet matrix (`cli_meta`, `fixture_meta`, `fund_usdc`, `governance`) |
| `robotmoney-analyst-plugin-checks` | quick | |
| `abi-drift-gate` | quick | |
| `natspec-coverage` | quick | |
| `secrets-scan` | quick | gitleaks secrets scan on every PR (security-model.md §13); pinned binary + `.gitleaks.toml` |
| `security-gates` | quick | cargo-audit (Rust), bun-audit (JS/TS), CSP strict-mode gate; allow-list for pre-existing sub-critical advisories with dated expiry (issues #804, #813, #835) |
| `erc4626-demo-tvl-matrix` | heavy | ERC-4626 precondition matrix (anvil, shard by exit-fee tier); gates PRs into `dev` (issue #814). Its `demo-tvl` devnet job and the `full_stack_demo_tvl` test were removed in core 1488 |
| `watchdog-rate-monitor` | quick | mint/burn rate watchdog unit + integration tests (issue #658, security-model.md §9); `watchdog-integration` also runs `cursor_and_volume` — the cursor-staleness and deposit-volume-anomaly suite, dark until issue #1282. Issue #1378 added `watchdog-integration`'s `liveness` target (the `watchdog_cursor.updated_at` heartbeat, driven through the real daemon and checker binaries) and `watchdog-unit`'s `scripts/stage/test-fusion-watchdog-supervisor.sh` step (the stage supervisor pages a crash-looping, hung, or startup-failed watchdog). **CI taxonomy (issue #1384):** `watchdog-unit` is `feature-correctness` and runs on draft PRs; `watchdog-integration` is `system-correctness` and is `if:`-gated to `draft == false`, so it first reports at `ready_for_review` (the `pull_request` trigger carries `ready_for_review`). Both jobs carry `paths-ignore: ['**.md','**.txt']`, so a docs-only PR gets neither check |
| `opencode-headless-deposit-read` | nightly | `deposit`/`read` replay coverage (issue #1210 option C, closes #1233): a scripted replay of the fixed rmpc command sequence runs against a live devnet in place of a live model; keyless `asserter-tests` runs on PRs too and validates the asserter/guard/replay code |
| `nightly-full-suite` | nightly | schedule-only (02:00 UTC) + workflow_dispatch; dispatches all suites against dev HEAD |
| `release-dapp` | release | tag/dispatch-only; not PR-triggered. Owns the `v*.*.*` tag namespace (issue #1243) |
| `release-rmpc` | release | tag/dispatch-only; not PR-triggered. Owns the `rmpc-v*.*.*` tag namespace and opens the post-release manifest-bump PR (issue #1243). Runbook: `docs/development/releasing.md` |

### Known limitations: release-rmpc selftest macOS non-vacuity guard

The guard exists to prove the macOS no-sha256sum packaging simulation is not
vacuous, but the independent security review on PR #1304 (issue #1292) found
two placements that still fool it:

- The matrix walker (`scripts/release/install-rmpc-selftest.sh:755-758`)
  matches `runner:` at ANY depth inside a matrix entry — a nested
  `something: {runner: macos-latest}` under a ubuntu entry counts 1 macOS
  build on a workflow that builds on zero macOS targets; GitHub ignores the
  nested key for runner selection, so the workflow stays valid and green.
- It never reads the job-level `runs-on` that actually selects the runner
  (`.github/workflows/release-rmpc.yml:358`); a static `runs-on: ubuntu-latest`
  still reports 2 macOS runners.

Both make the guard vacuous while the harness stays green — a CI-honesty gap,
not a containment breach (the allow-list fix is unaffected). The "two-edit
rule" comment (`release-rmpc.yml:484-487`) is actually three edits: the
PKG_ENV_NAMES pin (`install-rmpc-selftest.sh:1402-1409`) needs updating too.

---

## Summary

| # | Suggested workflow file | Jobs | Environment |
|---|------------------------|------|-------------|
| 1–2 | `forge-tests.yml` | `unit` \| `invariant` → `coverage` | `anvil` |
| 3 | `solidity-quality.yml` | `lint` → `slither` | `none` |
| 4 | `rust-quality.yml` | `lint` → `doc-coverage` \| `audit` \| `test-target-coverage` | `none` |
| 5 | `fork-integration.yml` | `pin` → `fork-integration` (5 slots) \| `base-testnet-adapters` | `devnet` / `fork` |
| 6 | `rmpc-unit.yml` | `unit` | `none` |
| 7 | `rmpc-integration.yml` | `pin` → `devnet-e2e` (matrix) \| `parity` \| `nonce-race-stress` | `devnet` |
| 8 | `explorer-indexer.yml` | `fast` \| `explorer-api` \| `pin` → `devnet` | `devnet` / `postgres-testcontainer` |
| 9 | `dapp-quality.yml` | `lint-build` | `none` |
| 10 | `dapp-e2e.yml` | needs suite 9 → `e2e` \| `e2e-history-pane` \| `devnet-e2e` \| `fork-roundtrip` | `devnet` |
| 11 | `opencode-smoke.yml` + `opencode-headless.yml` | smoke: `plugin-validate` \| `walkthrough-offline` → `walkthrough-fork`; headless: `asserter-tests` (offline, PR + nightly) \| `refusal` (offline, nightly/dispatch) \| explicit unavailable-live-coverage failure (nightly/dispatch) | `none` / `devnet` |
| 12 | `openclaw.yml` | `safety` → `walkthrough` | `devnet` |
| 13 | `doc-checks.yml` | `doc-validators` \| `schema-validators` | `none` |
| 14 | `smoke-test.yml` | `smoke-test-guards` \| `pin` → `devnet` (matrix), `twin_publish` | `devnet` |
| 18 | `suite-18-secrets-scan.yml` | `secrets-scan` (gitleaks) | `none` |
| 18b | `suite-18-security-gates.yml` | `cargo-audit` \| `bun-audit` \| `csp-gate` \| `audit-ledger` \| `seam-map-drift` \| `seam-map-validator` \| `release-workflow-authority-audit` | `none` |
| 19 | `suite-19-erc4626-demo-tvl-matrix.yml` | `erc4626-precondition` (matrix) | `anvil` |
| 20 | `suite-20-watchdog.yml` | `watchdog-unit` \| `watchdog-integration` | `none` / `postgres-testcontainer` |
| 21 | `suite-21-nightly.yml` | `dispatch-all-suites` | `none` |
| 22 | `suite-22-formal-verification.yml` | `forge-invariant-spec-tests` | `none` |
| 23 | `suite-23-skill-url-reachability.yml` (live, sweep-only) + `suite-23-skill-url-monitor-selftest.yml` (`reachability-selftest`, every PR) | asserts every published raw `SKILL.md` URL returns 200, including the deprecated compat stubs; the selftest proves the monitor fails red (#1199) | `none` (live network) |
| 25 | `suite-25-fusion-harness-selftests.yml` | `fusion-harness-selftests` | `none` |
| 26 | `suite-26-fusion-devnet-acceptance.yml` | `fusion-devnet-acceptance` (dispatch/nightly, never a merge gate) | the shared stage Twin fork `918453` (the `twin-chain` container of the stage host, not started per run) |
| 27 | `suite-27-rmpc-unit-releases.yml` | `rmpc-unit-releases` (suite 6's job on `releases-*` and `v*.*.*`) | `none` |
| 28 | `suite-28-core-stages.yml` | `core-stages-offline`, `publish-contracts-tests`, `core-stages-twin-chain`, `core-stages-twin-upgrade-lifecycle` and `core-stages-twin-upgrade-from-v050` (rehearsals: push to dev, ready PR, nightly) | `none` / Twin `918453` |
| 28 | `suite-28-core-stack-selftest.yml` | `core-stack-selftest`, `deleted-stage-gate`, `stage-tooling-tests`, `stage-container-rules`, `stage-chain-container`, `stage-core-stack-containers` | `none` / Twin `918453` in a container (the last two) |
| 29 | `suite-29-nightly-twin-fork.yml` | `pin` (uploads `twin-pin`) → suites 5, 7, 8, 10, 11b, 14, 28 (called with `pin_block`) → `record-results` | Twin chain `918453`, one shared pin |

### 29. Nightly Twin fork (nightly-twin-fork)

**File:** `.github/workflows/suite-29-nightly-twin-fork.yml` (issue 1496, nightly job (b); replaces the nightly fresh snapshot, `suite-29-nightly-fresh-snapshot.yml`).
**Tier / triggers:** nightly (05:30 UTC) and `workflow_dispatch`. Never a merge gate.

Every Twin chain run already pins the upstream head minus 2, so there is no snapshot to take, no genesis to build and no overlay to apply. This nightly runs every chain suite in ONE workflow run with ONE shared pin: a `pin` job chooses the block (`.github/actions/twin-pin`) and each suite (5, 7, 8, 10, 11b, 14) is called with `workflow_call` and `pin_block: ${{ needs.pin.outputs.block }}` and `secrets: inherit`. Each suite's own pin job hands that block through unchanged, then its chain jobs start their own Twin fork at it. Anvil's RPC cache is persisted per pin block. `secrets: inherit` hands the suites what they already use alone: the optional `BASE_UPSTREAM_RPC` (a paid upstream, never printed) and the `BASE_TESTNET_*` secrets of suite 5; the workflow itself references none, and no secret is required (`BASE_UPSTREAM_RPC` is optional). The `pin` job uploads `twin-pin` (the pin file: block, run id and time, never the upstream URL). The `results` job fails when the pin job or any suite did not succeed (failure, cancelled and skipped all count as not passing) and uploads `suite-results` (one JSON per suite, with the pin block).

Suite 26 is not in this run: it targets the shared stage Twin fork (a service on the stage host) and needs `secrets.FUSION_RMPC_CONFIG`; it starts no fork per run.

**Permissions.** A called workflow can keep or lower the caller's `GITHUB_TOKEN` permissions, never raise them. When a called job asks for a scope its caller job does not grant, GitHub refuses the whole run as `startup_failure` before any job starts. That kept this nightly from running at all from 2026-10-07 to 2026-10-13 (7 of 7 runs): the workflow granted `contents: read` only, and suite 7's `parity` job asks for `pull-requests: read` to read its changed-path list. The workflow default stays `contents: read`; the `suite-07` caller job grants `contents: read` and `pull-requests: read`. `scripts/ci/check_reusable_workflow_permissions.py` (suite 13 `doc-validators`, self-test first) fails when any caller grants less than a job it calls asks for (QA plan v1 T1).


## Nightly and release-record checks (cores 1495, 1496, 1497, 1498)

The `nightly-and-release-checks` job in `suite-13-doc-checks.yml` runs on every pull request. It runs, offline:

- `scripts/ci/check-nightly-dispatch-selftest.ts` (core 1495, Bun): the nightly dispatch list covers every suite workflow, a removed suite is detected, the retired fork-pin age job and scripts are gone, suite 29 is the Twin fork nightly, and the deleted drift job, script and alarm text are gone. The list check itself is `scripts/ci/check_nightly_dispatch_list.py`; config-check, suite 28 core-stages and suite 30 are in the SUITES list, and the release workflows, the nightly itself, the third-party drift workflow and suite 29 are on the exclusion list with reasons.
- `scripts/devnet/check-twin-chain-ci-selftest.ts` (cores 1496, 1498, Bun, run in suite 13, needs `yq`): the nightly calls suites 5, 7, 8, 10, 11b and 14 with `pin_block` from its own pin job and `secrets: inherit`; each of those suites declares the `pin_block` input, has a `pin` job using `.github/actions/twin-pin`, and every `twin-fork` step takes `pin-block` from that job and sits in a job that needs it; the nightly uploads `suite-results` and `twin-pin`; the nightly stays schedule and dispatch only; suite 1-2's `fork-regressions` starts the Twin fork at the pin and runs through the Bun runner; nothing in `.github`, `scripts`, `testing`, the dapp e2e tests or `services` still names the retired geth devnet, the genesis alloc, the fresh-snapshot overlay or the saved fork-state snapshot machinery; the retired files are gone.
- The nightly third-party drift workflow check, the dependency manifest self-test and the manifest address check (core 1497). The self-test records a manifest from a Twin fork (real Base code and storage) and checks it, so the address check covers something before the first release commits a manifest. It skips with a named reason when no chain is given.

Suite 14's `smoke-test-guards` job runs the smoke-test lib unit tests with a floor on the `cargo test -p smoke-test --lib` test count. The fork-block manifest guards, the snapshot contents check and the fixture lockstep gate are retired with the saved snapshot (core 1498). Suite 14's `twin_publish` job (its own job, not a matrix row) runs the real Twin chain publish through the one deploy driver (`bun publish-contracts/src/cli.ts`), the one verifier (its labels hold the router, basket and timelock role proofs), the stage 13 govern matrix and, after the post-govern verify, the `safe-change-threshold` pair on the real SafeL2 (raised to the owner count, restored to the sheet's value; QA plan v1 B5). While the chain is up it runs `scripts/stage/twin-run-report.ts` (stages, tx counts, vault set, labels), then `parity.ts` (label-diff and sheet-diff against the production fixtures when the input `production_fixtures_dir` names them, else against the fixtures committed in `publish-contracts/tests/fixtures`). It uploads the manifests, labels and report. Its own job `twin_pause_all` (core 1619, a fresh Twin chain, because a second deployment on the same fork finds the libraries already deployed and sends nothing) forces a real stage 12 failure on a fresh deployment, then asserts `depositsPaused` on all four vaults, the `rollout-report-<chain>.json` entries and a redeem on every paused vault that holds shares. On `pull_request` it runs only when `contracts/script/`, `scripts/deploy/`, `scripts/stage/`, `publish-contracts/`, `deployments/twin-918453/`, `config/` or `testing/smoke-test/` changed (a `changes` job reads the git diff); push, `workflow_dispatch` and the nightly `workflow_call` always run it. A non-zero test count floor applies through `cargo_test_require_executed.sh` (`CARGO_TEST_MIN_EXECUTED=1`) plus the `--lib` floor in the guards job. The job needs no Docker and runs only in CI.

## check-sha-green (core 1502)

`scripts/ci/check-sha-green.ts` is the deploy gate on CI state. The devops publish plan job (devops 58) runs it with `DEPLOY_SHA` before any approval.

```
bun scripts/ci/check-sha-green.ts <sha> [--repo owner/name] [--config path] [--api-url url]
```

- Reads every check-run of the commit through `GET /repos/{repo}/commits/{sha}/check-runs?filter=latest&per_page=100` and follows `rel="next"` Link headers until none remain. `filter=latest` returns only the latest attempt of each job, so re-running a failed job (for example after a Base upstream outage) supersedes the failed attempt. It is the GitHub API default, pinned explicitly (issue 1846 pinned it; it did not change the behavior).
- Token: `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`. The token stays in memory.
- Reads the deploy-gate list `scripts/ci/required-checks.json` (`version`, `required`, `optional`, `exempt`; the keys keep their names, the list gates a deploy sha and nothing else). An entry has either `name` (exact) or `prefix`. `exempt` entries are never read by the gate.
- Exit 0: every required name has at least one check-run and every run of it completed with `success`.
- Exit 1: a required name failed, is missing, or is pending (`queued`, `in_progress`). The output names each one under `FAILING`, `MISSING` or `PENDING`. A name with both a failed and a successful run in the latest attempts (two workflows that report the same job name) fails.
- Exit 2: bad arguments, bad config or an API error.
- Optional entries that are not green are printed as `optional (does not gate)` and never change the exit code.
- An entry may carry `"class": "required-on-deploy-paths"` and a `paths` list. `smoke-test-twin-publish` (suite 14 `twin_publish`, the Twin chain publish) and `smoke-test-twin-pause-all` (suite 14 `twin_pause_all`) are that class: they run on every push to `dev`, so a deploy sha always carries them, and on a pull request only when a path in the list changed. The list repeats the `changes` job filter of `suite-14-smoke-test.yml`; a unit test asserts the two are equal.
- The required list equals the jobs that run on every push to `dev` or to a `releases-*` branch, minus the `optional` and `exempt` entries, each with a `reason` (QA plan v1 T4). A deploy sha is the squash commit on `releases-A.B.x` (the rc tag's commit), and its push to that branch carries the release-ref push runs, so the plan job finds both sets. A QA branch commit (`qa/A.B.x-<YYYY-MM-DD>`) is never a deploy sha. Without the push runs of the release branch (or a dispatch of those workflows on the rc tag) the release-ref jobs (`rmpc-unit-releases`, suite 28 `core-stack-selftest` jobs, suites 25 and 27, `cross-repo-fixture-drift`) report `MISSING`. A draft skip or a pull request path filter does not take a job out. A push path filter does, except the docs-only `paths-ignore` (`**.md`, `**.txt`): a docs-only sha is never green, so tag a code commit. A matrix job is a `prefix` entry. `scripts/ci/deploy-gate-jobs.ts` derives the set from `.github/workflows`; a new job condition must be classified in its `KNOWN_CONDITIONS` table. `bun scripts/ci/deploy-gate-jobs.ts` prints the derived set and every gap with the list. Optional: `forge-fork-vault-regressions`, `fork-integration-*`, `base-testnet-adapters`, `solidity-slither`, `skill-url-reachability`, `opencode-headless-deposit-replay`. Exempt: `twin-pin`, `smoke-test-changes` (they test nothing; a failed pin skips the required Twin chain jobs, and a skipped job fails the gate).
- Tests: `bun test scripts/ci/check-sha-green.test.ts`, run by the `check-sha-green-tests` job (suite 30), which fails when zero tests were collected. The same file asserts `dapp-lint-build` and `bun-audit` carry no skip condition and no `continue-on-error`. `required list equals the push-dev unconditional job set` derives the set from the workflow tree and fails on any gap: a job in no list, a stale entry, a wrong source or class, a required job with `continue-on-error`, an exception with no reason, or a prefix that also matches another job.

### Release and QA branches

The release policy (`docs/operations/contract-release-runbooks.md` sections 2 and 3) names two branch families. `releases-A.B.x` takes a scope pull request, the squash of a passed QA branch and the frozen-counts record. `qa/A.B.x-<YYYY-MM-DD>` takes every patch of one QA session and is never rewritten. Every CI workflow that runs on a push to `dev` runs on a push to `releases-*` and to `qa/**`, so the commit QA runs and the squash commit each carry their own green CI. The storage-layout gate (`scripts/ci/check-core-storage-layout.sh`) extends the layout of the commit the live implementation was built from, append-only, at every QA commit.

### Branch protection (won't fix)

Branch protection is a won't-fix owner decision: no check is a GitHub status check that blocks a merge. `smoke-test-twin-publish` is path-gated on pull requests and runs on every push to `dev`, so a deploy sha always carries it. `scripts/ci/required-checks.json` lists it with class `required-on-deploy-paths` for `check-sha-green`, which enforces it at deploy time only. The `smoke-test-changes` job and the job itself keep their names, because `check-sha-green` matches the check-run name.
