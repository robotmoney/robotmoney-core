# Base Testnet E2E Tests — Status Review

**Date:** 2026-06-15
**Reviewer:** code-review (automated)
**Scope:** Status of the Base testnet (Base Sepolia) end-to-end adapter test suite — GitHub issues/PRs, CI wiring, and local source.

---

## TL;DR

The Base testnet e2e suite is **fully implemented, merged, and green in CI — but it has never been exercised against a live chain.** Every relevant issue and PR is closed/merged. The `base-testnet-adapters` CI job runs on every `push`/`pull_request` to `main`/`dev` and passes. However, it passes **in graceful-skip mode**: none of the `BASE_TESTNET_*` / `RM_TESTNET_*` secrets are provisioned, so both the live funding assertion and the live Uniswap/Aave/vault adapter calls skip without executing. The code compiles and the skip logic is verified; the live integration it was built to protect is **not** currently verified by CI.

Two prerequisites remain open and — importantly — are **not tracked by any open issue**:

1. Deploy Robot Money contracts to Base Sepolia and set `RM_TESTNET_*`.
2. Provision the `BASE_TESTNET_RPC_URL` / `BASE_TESTNET_FUNDER_KEY` / `BASE_TESTNET_FUNDER_ADDR` CI secrets.

Until both are done, this suite is **load-bearing only on paper**.

---

## 1. Delivery status (issues & PRs)

All work is merged. Nothing is open.

| Issue | Type | Title | PR | Merged |
|-------|------|-------|----|--------|
| **#842** | dev-scout | Establish Base testnet e2e foundation (seams: `Network`, funding config stubs, RPC config, parameterized template) | **#847** | 2026-06-14 23:51 |
| **#839** | feature | e2e test adapters against Base testnet live services (full impl) | **#849** | 2026-06-15 00:49 |
| **#850** | docs | Reconcile `base-testnet-guide.md` CI section with the shipped `suite-05` job (removed stale "Suite 19 / #843" reference) | **#852** | 2026-06-15 01:19 |
| **#854** | docs | Fix broken relative links in `base-testnet-guide.md` + two opencode docs | **#855** | 2026-06-15 02:19 |

All four issues' acceptance criteria are ticked. #842 shipped the integration *seams* (stubs + config types + the parameterized-template scaffolding); #839 delivered the live address registry, the real funding/assertion logic, the parameterized adapter test, and the CI job.

No open issue tracks the remaining deploy + secret-provisioning prerequisites (searched: "base sepolia deploy", "BASE_TESTNET secret provision" → no matches). This is the single biggest process gap (see §6).

---

## 2. What was built (local source)

### Test harness (`testing/fork-e2e-rust`)
- **`src/base_testnet.rs`** — `Network` enum (`RobotMoneyDevnet` = Base 8453 (forked), `BaseTestnet` = 84532) with per-network accessors (`rpc_url`, `chain_id`, `usdc`, `weth9`, `uniswap_v3_swap_router`, `aave_v3_pool`) and `Network::ALL` for parameterized iteration. Empty env var is treated as unset (GitHub injects an absent `${{ secrets.X }}` as `""`).
- **`src/base_testnet_addresses.rs`** — pinned Base Sepolia addresses for the **live third-party services** (USDC `0x036C…cF7e`, WETH9 `0x4200…0006`, Uniswap V3 SwapRouter02, Aave V3 Pool) + a stable `address_set_hash()`. Robot Money's own contracts are read from `RM_TESTNET_*` env vars and return `Option<Address>` — `None` until a deploy populates them.
- **`src/lib.rs`** — `ForkFixture::for_network` (chain-id-guarded connect), `new_live`/`new_testnet` (standard JSON-RPC, no anvil admin RPCs), `ephemeral_testnet` + `fund_from_external_funder` (seeds ephemeral accounts via signed transfers from `BASE_TESTNET_FUNDER_KEY`), and the `parameterized_e2e!` macro (runs one body once per network, skips networks whose RPC is unset).
- **`tests/multi_network_adapters.rs`** — the actual e2e. Three real adapter exercises with real assertions:
  - **Uniswap** V3 `exactInputSingle` USDC→WETH; asserts logs emitted + WETH balance rises.
  - **Aave** V3 `supply`; discovers the aToken from live `getReserveData`, asserts aToken balance delta > 0.
  - **Compound/Morpho/Curve** via `RobotMoneyVault.deposit`; asserts `activeAdapterCount > 0` and shares minted. Skips when no vault address is configured.

### Funding assertion (`testing/smoke-test`)
- **`src/base_testnet.rs`** — `BaseTestnetAccount` with real `eth_getBalance` + ERC-20 `balanceOf` RPC and `assert_funded()` against `AccountFundingAssertion` thresholds (0.1 ETH / 10 USDC default). `FundingError::Skip` when the RPC env var is unset.
- **`tests/base_testnet_fixture.rs`** — 10 tests: config/assertion/enum sanity (always run) + `base_testnet_account_funding_assertion` (live `eth_getBalance` gate; skips without secrets).

### CI (`.github/workflows/suite-05-fork-integration.yml`)
The `base-testnet-adapters` job (added in PR #849) needs no Docker devnet and no anvil — it talks directly to the Base Sepolia RPC named by `BASE_TESTNET_RPC_URL`. Two steps:
```
cargo test -p smoke-test --release --test base_testnet_fixture -- --nocapture
cargo test --release --test multi_network_adapters -- --test-threads=1 --nocapture   # (working-dir testing/fork-e2e-rust)
```

### Docs
- **`docs/scout/base-testnet-guide.md`** — env-var matrix, divergences-from-Base, CI section, and an implementation-status checklist marking the deploy + secret provisioning as outstanding.

---

## 3. CI verification — current behavior

**Latest run (workflow_dispatch, 2026-06-15 07:24, run `27530645545`): all 5 jobs `success`**, including `base-testnet-adapters`.

Confirmed from the live job log, the suite runs but skips every live leg:

```
[base_testnet_fixture] BASE_TESTNET_RPC_URL set but BASE_TESTNET_FUNDER_ADDR unset;
                       skipping balance assertion (set the funder address in CI).
test result: ok. 10 passed; 0 failed ...                         # base_testnet_fixture

[adapters_against_live_services] skipping Robot Money Devnet: RPC endpoint not configured
[adapters_against_live_services] skipping Base testnet: RPC endpoint not configured
[adapters_against_live_services] no network RPC configured ...
test result: ok. 1 passed; 0 failed ...                          # multi_network_adapters
```

`gh secret list` confirms **no `BASE_TESTNET_*` or `RM_TESTNET_*` secrets exist** on the repo. The job env injects them as empty strings, which `Network::rpc_url()` correctly maps to "unset → skip."

**Local unit tests (this review): green.**
- `fork-e2e-rust` lib: 12 passed (Network/address-hash/empty-env-skip).
- `smoke-test` lib: 8 passed (funding config/assertion/skip classification).

### Recent `suite-05` history on `dev`
Eight recent runs: 7 `success`, 1 `failure` (`27521731864`, 03:12). The failure was **`fork-integration-geth-withdrawal-registry`** — unrelated to Base testnet; `base-testnet-adapters` was `success` in that same run, and the runs immediately before and after it passed the withdrawal-registry slot. Treat as a flake in an unrelated slot, not a Base-testnet signal.

---

## 4. The graceful-skip contract (by design)

The suite is intentionally green both before and after the testnet environment is provisioned. Provisioning the secrets flips it from "skipped" to "live-exercised" **with no code change**. This is a deliberate, well-documented decision (workflow header comment + guide), and the empty-string-as-unset handling has its own regression test (`rpc_url_empty_env_resolves_to_none`).

The benefit: the suite can merge ahead of the deploy without blocking CI. The cost: see §5.

---

## 5. Risks & observations

### 5.1 The live path is unverified — risk of false confidence (HIGH)
The workflow's own header states this suite is *"the line of defence between a refactor breaking a live integration and that breakage reaching users."* Right now that defence is **inert**. A green `base-testnet-adapters` check proves the code compiles and the skip logic fires — it does **not** prove any adapter works against live Base Sepolia. A refactor that breaks Uniswap calldata encoding or the Aave aToken read would pass CI today. Anyone reading "✓ base-testnet-adapters" on a PR could reasonably over-trust it.
**Mitigation:** provision secrets (below), or have the job emit a visible "SKIPPED — not live-exercised" annotation/step-summary so the green check is not mistaken for live coverage.

### 5.2 Prerequisites are untracked (HIGH — process)
The two outstanding prerequisites live only in code comments and the guide's checklist. There is **no open backlog issue**. They can silently never happen. File issues for (a) Base Sepolia deploy + `RM_TESTNET_*`, and (b) CI secret provisioning, and link them from the guide.

### 5.3 The Robot Money Devnet leg also skips in this job (MEDIUM)
`ForkFixture::for_network(RobotMoneyDevnet)` forks a Base block via a live upstream (`RMPC_FORK_RPC_URL` or `RMPC_TESTNET_RPC_URL`) and explicitly **skips the checked-in fixture** ("external-pool storage is not in the fixture, so a swap reverts"). The `base-testnet-adapters` job sets neither, so `multi_network_adapters` skips *both* networks — it is presently a 100% no-op in CI. Note this is a different stance than the four-vault-demo memory ("archive RPC NOT a blocker; hermetic fixtures"): for live-pool adapter swaps the fixture genuinely cannot stand in, so an archive/live RPC *is* required to exercise this particular test. Worth deciding whether the Robot Money Devnet leg should run here (set `RMPC_FORK_RPC_URL`) so at least one network is live-exercised independent of the testnet deploy.

### 5.4 Live-chain flakiness, once enabled (MEDIUM — future)
When secrets land, the suite sends real transactions on a public testnet:
- **Funder dependency:** `ephemeral_testnet` seeds each account from one `BASE_TESTNET_FUNDER_KEY` EOA. Faucet exhaustion, nonce drift, or reorgs will surface as test failures. `--test-threads=1` mitigates intra-job nonce races but not balance depletion across runs.
- **Thin Sepolia liquidity:** swap/supply sizes are deliberately tiny (5 USDC), but a drained or re-deployed pool would revert. Hardcoded `fee: 500` tier assumes that pool exists.
- **Address drift:** the live third-party addresses are pinned constants with a stability hash, but nothing detects a Base Sepolia redeploy of Aave/Uniswap until a test reverts.
Plan for retries/quarantine semantics before making this a required check.

### 5.5 Funding assertion is a double no-op today (LOW)
In CI, `BASE_TESTNET_RPC_URL` is empty *and* `BASE_TESTNET_FUNDER_ADDR` is unset, so `base_testnet_account_funding_assertion` skips the `eth_getBalance` gate entirely. Even partial provisioning (RPC but not funder addr) leaves the gate skipped — see the log line in §3. Ensure all three are set together.

---

## 6. Recommended next actions

1. **File two tracking issues** (currently missing): Base Sepolia contract deploy + `RM_TESTNET_*`; and CI secret provisioning (`BASE_TESTNET_RPC_URL`, `_FUNDER_KEY`, `_FUNDER_ADDR`). Link both from `docs/scout/base-testnet-guide.md`.
2. **Make the skip visible.** Add a step-summary / annotation when the job runs in skip mode so a green check isn't read as live coverage (§5.1).
3. **Decide on the Robot Money Devnet leg** in this job (§5.3): set `RMPC_FORK_RPC_URL` so `multi_network_adapters` exercises at least the forked Base chain live, decoupled from the testnet deploy.
4. **Before making the live path required**, define retry/quarantine handling for funder-balance and liquidity flakiness (§5.4).

---

## 7. Verification commands

```bash
# Unit tests (always green, no secrets)
cargo test -p rmpc-fork-e2e --release --lib base_testnet
cargo test -p smoke-test --release --lib base_testnet
cargo test -p smoke-test --release --test base_testnet_fixture -- --nocapture

# Live e2e (requires provisioned secrets; skips gracefully without them)
BASE_TESTNET_RPC_URL=... BASE_TESTNET_FUNDER_KEY=... BASE_TESTNET_FUNDER_ADDR=... \
  cargo test -p rmpc-fork-e2e --release --test multi_network_adapters -- --test-threads=1 --nocapture

# CI state
gh run list --repo lucky-tensor/robotmoney-monorepo --workflow suite-05-fork-integration.yml --branch dev
gh secret list --repo lucky-tensor/robotmoney-monorepo | grep -i 'BASE_TESTNET\|RM_TESTNET'   # currently: none
```

---

## Appendix — source map

| File | Role |
|------|------|
| `.github/workflows/suite-05-fork-integration.yml` | `base-testnet-adapters` job (+ 4 fork-integration matrix slots) |
| `testing/fork-e2e-rust/src/base_testnet.rs` | `Network` enum + per-network params |
| `testing/fork-e2e-rust/src/base_testnet_addresses.rs` | Base Sepolia live-service addresses + `RM_TESTNET_*` overrides |
| `testing/fork-e2e-rust/src/lib.rs` | `for_network`, `new_live`, `ephemeral_testnet`, `parameterized_e2e!` |
| `testing/fork-e2e-rust/tests/multi_network_adapters.rs` | Uniswap / Aave / vault-stack live e2e |
| `testing/smoke-test/src/base_testnet.rs` | `BaseTestnetAccount` `eth_getBalance`/`balanceOf` + `assert_funded` |
| `testing/smoke-test/tests/base_testnet_fixture.rs` | Funding assertion + config sanity (10 tests) |
| `docs/scout/base-testnet-guide.md` | Environment guide + implementation-status checklist |
