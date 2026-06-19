# CI Suite Inventory

Each section is one GitHub Actions workflow file. Steps are listed in
execution order as they appear (or should appear) in the job.

The CI job has no special devnet setup step — the test suite itself starts
and tears down the Docker Compose stack whenever it needs a clean slate.

## Environment key

| Symbol | Meaning |
|--------|---------|
| `devnet` | Geth + Lighthouse Docker Compose stack (`testing/ethereum-testnet/config/`). Lifecycle owned by the test code. |
| `anvil` | In-process Anvil EVM. No Docker. |
| `fork` | Anvil forked from a pinned mainnet block via `RMPC_FORK_RPC_URL`. Skips loudly when the secret is absent. |
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
7. `forge test` (four-vault real-TVL pyramid, issue #592) — a dedicated, named
   step guards the real four-vault end state so it cannot silently regress:
   `DeployDemoExtraVaults.t.sol` asserts **all four** PRD §11 vaults are
   registered Active, three are router-eligible while the deSPXA RWA vault is
   direct-seed-only (ADR-0006 §1), and every vault reports non-zero
   `totalAssets` after a routed + direct deposit; `RwaVault.t.sol` covers the
   deSPXA deposit/redeem round-trip and stale-oracle halt; the
   `BasketVault`/`AgentTokenVault` suites pin per-vault basket composition.

**Steps — `invariant` job:**
1. Checkout repository
2. Install Foundry toolchain
3. Cache Foundry build artifacts (`cache/`, `out/`)
4. `forge build`
5. `forge test` with fuzzer enabled — invariant tests: share accounting, per-agent cap sequences, deposit monotonicity, reentrancy under malicious stub, pause invariant

**Steps — `coverage` job:**
1. Checkout repository
2. Install Foundry toolchain + Python
3. Cache Foundry build artifacts (`cache/`, `out/`)
4. `forge coverage` with `check_gateway_coverage.py` — enforces branch-coverage gate on `RobotMoneyGateway`

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
- `lint` — fmt and clippy across all crates; runs immediately
- `audit` — dependency vulnerability scan; runs in parallel with `lint` (independent of build cache)
- `doc-coverage` — build and rustdoc threshold check; **needs `lint`** (avoids running a full build on code that fails style checks)

**Steps — `lint` job:**
1. Checkout repository
2. Install Rust toolchain + clippy
3. Cargo cache
4. `cargo fmt --check` — formatting across all crates
5. `cargo clippy --all-targets --all-features -- -D warnings` — zero warnings enforced

**Steps — `audit` job:**
1. Checkout repository
2. Install Rust toolchain
3. `cargo install cargo-audit --locked` — install the advisory scanner
4. `cargo audit` — runs over **every** `Cargo.lock` in the repo (root workspace plus the standalone `services/explorer-indexer`, `testing/doctests`, `testing/ethereum-testnet/e2e-rust`, and `testing/fork-e2e-rust` lockfiles) against the rustsec/advisory-db; exits non-zero on any vulnerability advisory. Ignore configuration is read from `.cargo/audit.toml`, which suppresses pre-existing sub-high advisories with dated justifications so the gate has a green baseline and blocks merges on any new advisory. To accept a known low-risk advisory temporarily, add its RUSTSEC id to the `ignore` list in that file with a reason and expiry comment.

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
**Tier / triggers:** HEAVY — 4 Geth/Anvil devnet slots, 20-25 min wall-clock. Gates every `pull_request` into `dev` (no path filter) and runs on `push` to `dev`. Feature PRs into phase branches skip this suite; `suite-06` (rmpc-unit) provides fast feedback on those.

**Why Anvil here, and why this is not redundant with the Geth+Lighthouse devnet harness:**
This suite forks **Base mainnet** state (real deployed contracts, real DEX pools, real USDC) and runs the Rust client (`rmpc`) against it. The goal is to catch ABI encoding drift, address-constant mistakes, and real-world RPC error shapes — bugs that only show up against actually-deployed mainnet contracts. The smoke-test devnet (Geth+Lighthouse, see suite 14) cannot do this: it deploys fresh contracts on an empty chain, so it cannot tell you "the calldata `rmpc` generates still matches what is deployed at the real gateway address on Base."

Anvil is used specifically because `anvil --fork-url` is the only ergonomic way to mount mainnet state at a pinned block and let tests mutate it locally (cheat codes like `anvil_setBalance` to fund test accounts on forked USDC). One anvil child per test gives cheap fork-restart-per-test isolation (per the ADR), with no snapshot/revert orchestration. Geth+Lighthouse cannot fork mainnet state this way; that stack is purpose-built for the empty-devnet "boot a real chain locally" scenario.

| Concern | Suite 5 (Anvil fork) | Devnet harness (suite 14, smoke-test `--full-stack`) |
|---|---|---|
| Chain | Anvil forking Base mainnet | Real Geth+Lighthouse, empty genesis |
| Contracts | Already-deployed mainnet ones | Freshly deployed by Fixture |
| Catches | ABI/address/RPC-shape drift vs prod | Full-stack flow (dapp→indexer→explorer), real block times |
| Speed | Seconds per test (instant mining) | ~12s blocks, minutes |

The two suites are complements, not duplicates. The retired Anvil "OpenClaw demo" suite (#242/#244) used Anvil to demo the whole product — that role was correctly taken over by the Geth+Lighthouse smoke-test. Suite 5's Anvil usage targets a job Geth+Lighthouse cannot do.

A per-test audit of suite-05's coverage against the alternative suites is recorded in [suite-05-audit.md](./suite-05-audit.md) (issue #248). The audit's recommendation is **keep**, with a follow-up slim of two tests that duplicate suite-6 coverage.

**Jobs:**
- `pr-smoke` — fast subset; runs on every PR trigger
- `full-suite` — all scenarios; runs on push to `main` and `workflow_dispatch`; no dependency on `pr-smoke` (different trigger context, not sequential)

**Steps (both jobs):**
1. Checkout repository
2. Install Rust toolchain + clippy
3. Install Foundry toolchain
4. Cargo cache
5. `cargo fmt --check` + `cargo clippy`
6. `cargo test --no-run` — build test binaries
7. _(pr-smoke only)_ `abi_address_sanity` + `vault_deposit_redeem_smoke` — fast subset
8. _(full-suite only)_ All scenarios: `abi_address_sanity`, `vault_deposit_redeem_smoke`, `dex_route_smoke`, `failure_surface_smoke`, `gas_estimate_reality_check`, plus the remaining `rmpc_get_*` fork tests: `rmpc_get_vault_fork_base_mainnet`, `rmpc_get_balance_fork`, `rmpc_get_allowance_fork`, `rmpc_get_tx_fork`

---

### 6. Rust client unit tests
**Suggested file:** `.github/workflows/rmpc-unit.yml`
**Environment:** `none`
**Trigger paths:** `clients/rust-payment-client/**`

**Jobs:**
- `unit` — single job, no dependencies

**Steps:**
1. Checkout repository
2. Install Rust toolchain + clippy
3. Cargo cache
4. `cargo fmt --check`
5. `cargo clippy --all-targets -- -D warnings`
6. `cargo test --lib` — calldata builder output, preflight rejection cases, nonce management logic, fee policy guard, JSON output schema conformance, config parsing

---

### 7. Rust client integration tests
**Suggested file:** `.github/workflows/rmpc-integration.yml`
**Environment:** `devnet` (Geth + Lighthouse)
**Tier / triggers:** HEAVY — gates every `pull_request` into `dev` (no path filter) and runs on `push` to `dev`.

**Jobs:**
- `geth-tests` — devnet-backed scenarios; runs immediately; should not run if suite 6 (`rmpc-unit`) is failing on the same commit (enforce via `workflow_run` dependency or branch protection)
- `nonce-race-stress` — in-process stress test, no chain; runs in parallel with `geth-tests`

**Steps — `geth-tests` job:**
1. Checkout repository
2. Verify Docker is available
3. Install Rust toolchain + clippy
4. Install Foundry toolchain
5. Cargo cache
6. `cargo fmt --check` + `cargo clippy` on both `rmpc` and `e2e-rust` crates
7. Pre-pull Docker images
8. `cargo build --release` — produce `rmpc` binary
9. `cargo test --test skill_docs_parity` — skill-package parity (no Docker)
10. `cargo test --test dapp_toml_roundtrip` — dApp TOML round-trip (no Docker)
11. `cargo test --release --test smoke --test-threads=1` — devnet boots inside test
12. `docker compose down -v` — explicit teardown between binaries
13. `cargo test --release --test scenarios --test-threads=1` — all policy/failure scenarios
14. `docker compose down -v`
15. `cargo test --release --test window_cap --test-threads=1`
16. `docker compose down -v` (always, on failure)

**Steps — `nonce-race-stress` job:**
1. Checkout repository
2. Install Rust toolchain
3. Cargo cache
4. `bash .github/scripts/stress_nonce_race.sh` — runs the race test 100× in-process; no chain

---

### 8. Explorer indexer tests
**Suggested file:** `.github/workflows/explorer-indexer.yml`
**Environment:** `devnet`
**Trigger paths:** `services/explorer-indexer/**`, `testing/explorer-indexer/**`

**Jobs:**
- `fast` — migration idempotency, block ingestion, RPC failure recovery; uses Postgres testcontainer + Anvil; runs immediately
- `devnet` — reorg handling and finality-gated indexing against real Geth+Lighthouse; runs in parallel with `fast` (independent environments)

**Steps — `fast` job:**
1. Checkout repository
2. Install Rust toolchain + clippy
3. Cargo cache
4. `cargo fmt --check` + `cargo clippy`
5. `cargo test --no-run`
6. `cargo test --test migrations` — migration idempotency (Postgres testcontainer started by the test)
7. `cargo test --test idempotency` — block ingestion against known deposit events; double-count guard
8. `cargo test --test rpc_failure` — RPC failure recovery; reconnect and resume from last confirmed block

**Steps — `devnet` job:**
1. Checkout repository
2. Verify Docker is available
3. Install Rust toolchain
4. Cargo cache
5. `cargo test --test fork_indexer` — reorg handling (orphaned-block row removal) and finality-gated indexing against devnet (requires real Geth + Lighthouse fork choice)

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
7. `bun run test` — Vitest: component rendering, browser-side key generation, credential boundary (no key material in DOM), form validation
8. `bun run build` — verify production build succeeds
9. `bash scripts/check-csp.sh` — Enforce strict CSP: builds the production bundle, serves it with `vite preview`, then asserts the `Content-Security-Policy` response header is present and contains `script-src` but neither `unsafe-inline` nor `unsafe-eval`; also checks the baked-in `<meta http-equiv="Content-Security-Policy">` tag in `index.html` (issue #665)
10. `bash scripts/audit-deps.sh` — dependency vulnerability scan wrapping `bun audit --audit-level=high`; exits non-zero on any high or critical advisory (CVSS ≥ 7.0). Uses `bun audit` (not `npm audit`) because the lockfile is `bun.lock`; `npm audit` fails with `ENOLOCK` without a `package-lock.json`. The script carries a dated allowlist of pre-existing high/critical advisories (axios via the wallet-connector SDK, the dev-only vitest UI advisory, and the esbuild Deno-install-path advisory — build-time only, not reachable via bun installs) so the gate has a green baseline and blocks merges on any new advisory. To accept a known advisory temporarily, add its GHSA id to the allowlist in `clients/dapp/scripts/audit-deps.sh` with a reason and expiry. Do not lower `--audit-level`.

---

### 10. dApp E2E tests
**File:** `.github/workflows/suite-10-dapp-e2e.yml`
**Environment:** `devnet` (smoke-test full stack)
**Tier / triggers:** HEAVY — gates every `pull_request` into `dev` (no path filter) and runs on `push` to `dev`.

Single job runs every Playwright spec against a real Geth+Lighthouse
devnet booted by Playwright's `globalSetup` (`devnet-global-setup.ts`),
which spawns `cargo run -p smoke-test -- --full-stack`. The dapp
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
**Trigger:** `opencode-smoke.yml` on every PR; `opencode-headless.yml` nightly + `workflow_dispatch`

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
4. `cargo test --test read_only_walkthrough` — rmpc envelope contract against devnet (skip-cleans without `RMPC_FORK_RPC_URL`)

**Jobs — `opencode-headless.yml`:**
- `refusal` — offline safety assertions, no chain, no model key; runs first
- `deposit` — **needs `refusal`**; full headless deposit run against devnet
- `read` — **needs `refusal`**; runs in parallel with `deposit`

**Steps — `refusal` job:**
1. Checkout repository
2. Install Rust + Foundry toolchain
3. Cargo cache
4. Run refusal transcript assertions (prompt injection, mainnet gate, out-of-policy amount) — no model key required

**Steps — `deposit` job:**
1. Checkout repository
2. Install OpenCode at pinned version + Rust + Foundry
3. Deploy `MockUSDC` + `MockVault` + `RobotMoneyGateway` via `Deploy.s.sol` on devnet
4. Generate fresh agent EOA; write keystore via `rmpc-keystore-import`
5. Fund agent ETH balance via `anvil_setBalance`; set USDC approval via impersonation
6. `opencode run <deposit-prompt> --format json` against devnet
7. `assert_headless_deposit_transcript.py` — asserts tool-call order (get-vault → get-agent → get-balance → get-allowance → self-check → deposit), `final-report.json` outcome, tx_hash non-null hex

**Steps — `read` job:**
1. Checkout repository
2. Install OpenCode at pinned version + Rust + Foundry
3. Deploy contracts + fund agent on devnet
4. **Safety step**: read-only isolation assertions — agent in read-only config cannot invoke state-changing tools
5. `opencode run <read-prompt> --format json` against devnet
6. `assert_headless_read_transcript.py` — asserts vault state, balance, and allowance queries match JSON schema

---

### 12. OpenClaw integration tests
**Suggested file:** `.github/workflows/openclaw.yml`
**Environment:** `devnet`
**Trigger paths:** `testing/openclaw-config/**`, `plugins/robotmoney-user/**`, `docs/development/openclaw-config.md`

**Jobs:**
- `safety` — shellcheck, mainnet gate, secret handling; runs immediately; no chain required
- `walkthrough` — **needs `safety`**; long-running deposit walkthrough against devnet (skip-cleans without `RMPC_FORK_RPC_URL`)

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
**Environment:** `devnet` (Geth + Lighthouse)
**Tier / triggers:** HEAVY — gates every `pull_request` into `dev` (no path filter) and runs on `push` to `dev`.

Validates the `smoke-test` crate — the canonical devnet fixture library — in
isolation, independent of any client (rmpc, dapp, explorer).

**Steps:**
1. Checkout repository
2. Verify Docker is available
3. Install Rust toolchain + clippy
4. Install Foundry toolchain
5. Cargo cache
6. `cargo fmt --check -p smoke-test`
7. `cargo clippy -p smoke-test --all-targets -- -D warnings`
8. `cargo build -p smoke-test` — includes the `smoke-test` CLI binary
9. `cargo test -p smoke-test --release --test cli_meta -- --nocapture` — boots `smoke-test --full-stack`, checks the structured endpoint summary, verifies `--dapp-port` / Ctrl-C teardown, and writes `smoke-test-cli_meta.log`
10. `cargo test -p smoke-test --release --test fixture_meta -- --test-threads=1 --nocapture` — boots devnet, deploys contracts, asserts healthy RPC + block production, then tears down; verifies `Drop` runs compose-down cleanly and writes `smoke-test-fixture_meta.log`
11. `cargo test -p smoke-test --release --test demo_seeding -- --test-threads=1 --nocapture` (four-vault real-TVL, issue #592) — boots the devnet fixture, seeds the simulated depositors, and asserts the four-vault real-TVL end state: `VaultRegistry.listVaults()` returns **exactly four Active** vaults (PRD §11.1–§11.4); `PortfolioRouter.getWeights()` covers the three router-eligible vaults summing to 10000 bps while the deSPXA RWA vault is never weighted (direct-seed-only, ADR-0006 §1); and **all four** vaults report non-zero on-chain `totalAssets` after seeding. Writes `smoke-test-demo_seeding.log`. **This gate runs exactly once per suite run — on the `demo_seeding` matrix binary only** (see de-dup note below).
12. Upload smoke-test logs from `$RUNNER_TEMP/robotmoney-smoke-test/` as a CI artifact, then run `docker compose down -v --remove-orphans || true` for the safety-net teardown

> **Note:** Step 10 exercises `Fixture::new()` end-to-end — the same code
> path that all devnet-backed suites (7, 8, 10, 11, 12) depend on. A
> failure here blocks those suites before they pay their own boot costs.
>
> **Four-vault coverage (issue #592):** Step 11 is the integration-layer half
> of the four-vault real-TVL test pyramid; the forge layer (suite 1–2 step 7)
> is the contract half. The companion full-stack assertion
> `full_stack_demo_tvl::explorer_api_shows_four_active_nonzero_vaults_after_boot`
> (`GET /v1/vaults` returns exactly four Active entries, each non-zero
> `total_assets`) boots the heavier `DappStack` and is run locally / via the
> dapp suites rather than this fixture-only suite.
>
> **Parallel matrix + four-vault de-dup (issues #600, #915):** the
> devnet-booting binaries run as a parallel matrix
> `[cli_meta, fixture_meta, demo_seeding, full_stack_demo_tvl]` (`fail-fast:
> false`), one runner per binary, each booting and tearing down its own
> Geth+Lighthouse stack. The four-vault real-TVL gate (step 11) **is** the
> `demo_seeding` matrix binary, so it runs exactly once per suite run. It is
> *not* re-appended as an unconditional final step on every binary: doing so
> previously booted a second devnet + reseed on
> `cli_meta`/`fixture_meta`/`full_stack_demo_tvl` (~25 min of redundant
> boot+seed on the slowest binary) with zero net coverage, since the
> assertions already run as the `demo_seeding` binary.

---

### 13. Cross-cutting doc checks
**Suggested file:** `.github/workflows/doc-checks.yml`
**Environment:** `none`
**Trigger:** All PRs (no `paths:` filter — these catch drift introduced anywhere)

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

**Steps — `schema-validators` job:**
1. Checkout repository
2. Install Python
3. `check_explorer_migrations.py` — single-canonical-home invariant: migration files exist only in `services/explorer-indexer/migrations/`, no duplicates elsewhere

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
Scans `Cargo.lock` and all workspace `Cargo.lock` files (root workspace, `services/explorer-indexer`, `testing/doctests`, `testing/ethereum-testnet/e2e-rust`, `testing/fork-e2e-rust`) against the RustSec advisory database. Advisory allow-list and severity policy live in `.cargo/audit.toml` (issue #813):
- Blocks on any HIGH or CRITICAL advisory (CVSS ≥ 7.0)
- Downgrades unmaintained and notice advisories to warnings
- To accept a known low-risk advisory temporarily, add its RUSTSEC id to the `ignore` list in `.cargo/audit.toml` with a reason and expiry comment

Installation method: cargo-audit is installed via `cargo install cargo-audit --locked` rather than the `rustsec/audit-check` GitHub action to avoid the action's `checks:write` permission requirement, which causes annotation errors on PRs from external contributors.

**Bun audit (JavaScript/TypeScript dependencies):**
Scans `clients/dapp/bun.lock` and `package.json` for JS advisory database (npm) hits via `bun audit --audit-level=high`. Blocks on any HIGH or CRITICAL advisory. The transitive CRITICAL (vitest <3.2.6) and HIGH (axios) advisories were previously resolved by pinning vitest/@vitest/browser to ^3.2.6 and axios to ^1.17.0 via package.json `overrides` (issue #813). The `--audit-level=high` flag (bun's native severity control; the previous `--level high` was unrecognized and silently ignored) suppresses sub-HIGH advisories from both output and exit code, allowing moderate transitive advisories (vite, esbuild, ws, uuid, hono, brace-expansion) to remain without blocking the gate. Implementation: `bun audit` is wrapped by `clients/dapp/scripts/audit-deps.sh` (issue #835), which runs the same allow-list logic used by suite 9 (dapp-quality), so accepted-advisory justifications live in exactly one place.

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

### 19. ERC-4626 precondition checks and full-stack demo-TVL matrix
**Suggested file:** `.github/workflows/suite-19-erc4626-demo-tvl-matrix.yml`
**Environment:** `anvil` (precondition) / `devnet` (demo-tvl)
**Trigger paths:** `contracts/test/ERC4626PreconditionChecks.t.sol`, `testing/smoke-test/tests/full_stack_demo_tvl.rs`, and the workflow file itself

**Tier:** HEAVY — the `dev` merge gate. Runs on every `pull_request` targeting `dev` (no `paths:` filter) and on `push` to `dev`. Not triggered on PRs to other branches, keeping routine feature-PR cycles fast.

**Jobs:**
- `erc4626-precondition` — matrix-sharded forge tests; runs immediately
- `demo-tvl` — full-stack demo-TVL integration test against Geth+Lighthouse devnet; runs in parallel with precondition

**Design rationale (issue #814, #804):**
Two complementary test-matrix expansions that live in one suite to keep the total workflow count manageable and share HEAVY-tier trigger logic.

**ERC-4626 precondition tests (issue #814):**
`contracts/test/ERC4626PreconditionChecks.t.sol` asserts invariants across the adapter and exit-fee matrix. The precondition suite validates:
- `asset()` and `decimals()` correctness for each adapter (passthrough, aave, compound, morpho)
- Empty-vault share-price invariants (no rounding drift when vault has zero assets)
- Adapter pairing consistency

The matrix shards by exit-fee tier (`EXIT_FEE_BPS` = 0, 30, 100) so each tier's Foundry fuzz run (256 runs per tier) stays isolated and fast. Uses an `exit_fee_bps` matrix variable to parameterize the test.

**Full-stack demo-TVL test (issue #804):**
`testing/smoke-test/tests/full_stack_demo_tvl.rs` is a heavy INTEGRATION test that boots the full DappStack (Geth+Lighthouse devnet, contracts deployed by Fixture, dapp bundled with keccak-256 hash verification) and seeds the demo depositors, then asserts the four-vault real-TVL end state:
- `VaultRegistry.listVaults()` returns exactly four Active vaults (PRD §11.1–§11.4)
- `PortfolioRouter.getWeights()` covers the three router-eligible vaults summing to 10000 bps, while the deSPXA RWA vault is never weighted (direct-seed-only, ADR-0006 §1)
- All four vaults report non-zero `totalAssets` after seeding

This is the HEAVY-tier integration-layer half of the four-vault real-TVL test pyramid (the contract-layer half is suite 1–2, step 7). It is not run on routine feature PRs because DappStack boot + seeding takes 25–35 minutes; instead, it runs as part of the `dev` merge gate (PRs into `dev` and push to `dev`).

**Activation history:**
- `erc4626-precondition`: activated in issue #814 — ERC4626PreconditionChecks.t.sol created and `if: false` removed
- `demo-tvl`: activated in issue #804 — full_stack_demo_tvl.rs exists; bun runner dependency resolved via `oven-sh/setup-bun@v2`

**Steps — `erc4626-precondition` job (matrix over exit_fee_bps: [0, 30, 100]):**
1. Checkout repository (recursive submodules)
2. Install Foundry toolchain (stable)
3. `forge test --match-contract ERC4626PreconditionChecks --fuzz-runs 256 -vv` with `EXIT_FEE_BPS` env var set to the matrix value
4. Repeat for each exit-fee tier in parallel

**Steps — `demo-tvl` job:**
1. Checkout repository (recursive submodules)
2. Verify Docker is available
3. Install Rust toolchain (stable)
4. Install Foundry toolchain (stable)
5. Install Bun (needed by DappStack dapp-build step)
6. Rust cache via `Swatinem/rust-cache@v2` pointing to `testing/smoke-test -> target`
7. `cargo build -p smoke-test` (smoke-test crate)
8. `cargo test -p smoke-test --release --test full_stack_demo_tvl -- --test-threads=1 --nocapture` — boots devnet, deploys contracts, seeds demo depositors, asserts four-vault end state, then tears down
9. Safety-net teardown: `docker compose down -v --remove-orphans || true` (always runs, even on failure)

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
  calls `gh workflow run <file> --ref dev`

**Steps:**
1. Dispatch each suite workflow via `gh workflow run` against the `dev` ref
2. (Suites run independently; this job only fires the dispatches and exits)

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
  4 Geth/Anvil slots, 20-25 min), the full-devnet `dapp-e2e` Playwright suite,
  the `erc4626-demo-tvl-matrix`, and the `forge-coverage-gate` job all live here.
  Every branch that opens a PR into `dev` runs the full heavy battery before it
  can land.

To make a heavy suite actually *block* a merge, add its check to the required
status checks on `dev`'s branch-protection rule (a GitHub setting, not repo YAML).

Structural conventions (kept by convention; a prior static tier-guard workflow
that enforced them was removed as overkill):

- Every PR-triggered workflow declares `concurrency.cancel-in-progress` (enabled
  for `pull_request` events) with a `${{ github.ref }}`-keyed group, so re-pushing
  a PR cancels superseded runs while `push:dev` runs keep a distinct,
  non-cancelling lane and merged-commit coverage always completes.
- `rust-client-devnet-integration` (suite-07) and `smoke-test-devnet-boot-teardown`
  (suite-14) express their devnet binaries as a `fail-fast: false` job matrix —
  one runner per binary, each booting and tearing down its own stack with an
  `if: always()` `docker compose down` step. No devnet binary runs as a sequential
  step in a shared job, so the port-8545 contention that forced serial execution
  is gone.
- No Rust-building workflow uses a hand-rolled `actions/cache` for cargo
  target/registry; each uses `Swatinem/rust-cache@v2`.

### Tier mapping

Every workflow's `name:` and its tier.

| Workflow `name:` | Tier | Notes |
|------------------|------|-------|
| `forge-unit-invariant-coverage` | quick | `unit`/`invariant` are light (PRs to any branch); the `forge-coverage-gate` job is heavy and `if:`-gated to push-to-`dev` / PR-into-`dev` |
| `solidity-fmt-natspec-slither` | quick | |
| `rust-fmt-clippy-doc-coverage` | quick | includes `audit` job (cargo audit) |
| `fork-protocol-adapter-integration` | heavy | 4 Geth/Anvil devnet slots (20-25 min); gates PRs into `dev` |
| `rust-client-unit-tests` | quick | |
| `rust-client-devnet-integration` | heavy | devnet e2e matrix (`smoke`, `scenarios`, `window_cap`, `withdraw`) |
| `explorer-indexer-migrations-reorg` | quick | |
| `dapp-lint-typecheck-vitest-build` | quick | includes bun audit --audit-level=high step (scripts/audit-deps.sh) |
| `dapp-e2e` | heavy | full-devnet Playwright suite |
| `opencode-plugin-validate-walkthrough-offline` | quick | |
| `openclaw-safety-walkthrough` | quick | |
| `doc-adr-runbook-migration-checks` | quick | |
| `smoke-test-devnet-boot-teardown` | heavy | devnet matrix (`cli_meta`, `fixture_meta`, `demo_seeding`/four-vault) |
| `robotmoney-analyst-plugin-checks` | quick | |
| `abi-drift-gate` | quick | |
| `natspec-coverage` | quick | |
| `secrets-scan` | quick | gitleaks secrets scan on every PR (security-model.md §13); pinned binary + `.gitleaks.toml` |
| `security-gates` | quick | cargo-audit (Rust), bun-audit (JS/TS), CSP strict-mode gate; allow-list for pre-existing sub-critical advisories with dated expiry (issues #804, #813, #835) |
| `erc4626-demo-tvl-matrix` | heavy | ERC-4626 precondition matrix (anvil, shard by exit-fee tier) + full-stack demo-TVL test (devnet, 25–35 min); gates PRs into `dev` (issue #804/#814) |
| `watchdog-rate-monitor` | quick | mint/burn rate watchdog unit + integration tests (issue #658, security-model.md §9) |
| `opencode-headless-deposit-read` | nightly | schedule-only; not PR-triggered |
| `nightly-full-suite` | nightly | schedule-only (02:00 UTC) + workflow_dispatch; dispatches all suites against dev HEAD |
| `release-dapp` | release | tag/dispatch-only; not PR-triggered |
| `release-rmpc` | release | tag/dispatch-only; not PR-triggered |
| `deploy-contracts` | release | dispatch-only; deploys protocol contracts and asserts BaseScan source verification within one hour (security-model.md §8 / §13) |

---

## Summary

| # | Suggested workflow file | Jobs | Environment |
|---|------------------------|------|-------------|
| 1–2 | `forge-tests.yml` | `unit` \| `invariant` → `coverage` | `anvil` |
| 3 | `solidity-quality.yml` | `lint` → `slither` | `none` |
| 4 | `rust-quality.yml` | `lint` → `doc-coverage` | `none` |
| 5 | `fork-integration.yml` | `pr-smoke` / `full-suite` (trigger-gated) | `fork` |
| 6 | `rmpc-unit.yml` | `unit` | `none` |
| 7 | `rmpc-integration.yml` | `geth-tests` \| `nonce-race-stress` | `devnet` |
| 8 | `explorer-indexer.yml` | `fast` \| `devnet` | `devnet` |
| 9 | `dapp-quality.yml` | `lint-build` | `none` |
| 10 | `dapp-e2e.yml` | needs suite 9 → `e2e` \| `e2e-history-pane` \| `devnet-e2e` \| `fork-roundtrip` | `devnet` |
| 11 | `opencode-smoke.yml` + `opencode-headless.yml` | smoke: `plugin-validate` \| `walkthrough-offline` → `walkthrough-fork`; headless: `refusal` → `deposit` \| `read` | `none` / `devnet` |
| 12 | `openclaw.yml` | `safety` → `walkthrough` | `devnet` |
| 13 | `doc-checks.yml` | `doc-validators` \| `schema-validators` | `none` |
| 14 | `smoke-test.yml` | `smoke-test` | `devnet` |
| 18 | `suite-18-secrets-scan.yml` | `secrets-scan` (gitleaks) | `none` |
| 18b | `suite-18-security-gates.yml` | `cargo-audit` \| `bun-audit` \| `csp-gate` | `none` |
| 19 | `suite-19-erc4626-demo-tvl-matrix.yml` | `erc4626-precondition` (matrix) \| `demo-tvl` | `anvil` / `devnet` |
| 20 | `suite-20-watchdog.yml` | `watchdog-unit` \| `watchdog-integration` | `none` / `postgres-testcontainer` |
| 21 | `suite-21-nightly.yml` | `dispatch-all-suites` | `none` |
