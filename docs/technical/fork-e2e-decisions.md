# ADR — Forked Smart-Contract E2E: target chain, block pinning, harness driver

> Scope: dev-scout decision record for Phase 2 (Forked Smart-Contract E2E) of `docs/implementation-plan.md` §8. Resolves the unresolved choices that gated test code: which public chain fork to target, how fork blocks are pinned for CI vs local, whether the harness driver is a Rust integration crate or reuses the existing TypeScript fork-test logic, the CI vs manual-trigger split, the per-test isolation approach, and the recommendation on issue #37 (drop Anvil flavor).
>
> Closes the open question gate in `docs/implementation-plan.md` §8 ("Fork target", "Harness", "Outputs"). No test code is produced by this scout.

---

## 1. Status

Accepted. Authored 2026-05-06 against `docs/implementation-plan.md` (commit on branch `feat/47-dev-scout-fork-target-block-pinning-harness-driv`). No prior ADR exists for this phase.

## 2. Context

`docs/implementation-plan.md` §8 prescribes a forked smart-contract E2E suite for Phase 2 but leaves six choices unresolved. Each choice has cross-cutting implications for CI runtime budget, fixture management, and whether `rmpc` owns the command surface for fork tests:

1. **Fork target.** Plan §8 names "a recent Base mainnet fork" as the default, but does not commit to it.
2. **Block pinning.** Plan §8 says CI must be pinned and local may be "latest recent", but does not specify how a pin is captured, recorded, or refreshed.
3. **Harness driver.** Plan §8 says "prefer Rust integration tests once `rmpc` owns the command surface" but allows TS fork tests as reference, leaving the decision deferred.
4. **CI vs manual-trigger split.** Plan §8 lists both a CI smoke job and a "release-gated or manually-triggered" fuller job, but does not say which scenarios live in which.
5. **Per-test isolation.** Plan §8 says "every test uses an isolated ephemeral key and snapshot/revert", but does not specify which fork backend supports that (Anvil's `evm_snapshot`/`evm_revert` vs Geth's lack of one).
6. **Issue #37 — drop Anvil flavor.** The Phase 1 e2e harness (PRs #34/#35/#36) ships both Anvil and Geth+Lighthouse layers. Issue #37 proposes deleting the Anvil flavor entirely. The Phase 2 harness inherits whatever Phase 1 ends with, so the answer to #37 cascades into Phase 2.

A binding constraint already lives in user memory and applies across the project: **no fast-feedback optimization**. The project explicitly trades CI iteration speed for realism and fewer moving parts. Every decision below is anchored to that constraint plus the §8 acceptance criteria (CI catches drift; one documented local command; actionable error surface).

## 3. Decisions

### 3.1 Fork target — **Base mainnet (chain id 8453), Alchemy/Infura/public RPC archive endpoint**

- **Driver:** `docs/technical/smart-contracts.md` §2 lists every Robot Money production contract as a Base-mainnet deployment (`RobotMoneyVault` `0x4f83…b49dd`, three adapters, the admin Safe). The basket leg (`references/basket.md`) is also Base-only Uniswap routing. Testing the actual deployed bytecode against actual Base state is the only way to satisfy §8's "does the deployed-style Robot Money flow still work against current on-chain reality?" framing.
- **RPC pattern:** consume the fork RPC URL from a single env var (`RMPC_FORK_RPC_URL`). CI uses a vault-stored archive endpoint (Alchemy or Infura — either qualifies, picked per CI secret availability, see §3.2). Local devs may point at any Base archive node, including a paid personal endpoint. No hard-coded RPC strings in test code.
- **Constraint cited:** plan §8 explicitly calls Base the default. Smart-contract reference confirms zero non-Base deployments today. No second chain has been promoted to a deployment plan.
- **Rejected alternatives:**
  - *Ethereum mainnet fork.* Robot Money has no L1 deployment; testing against L1 USDC/Aave/Morpho/Compound state would test contracts that are not the contracts we ship. Rejected.
  - *Multi-chain fork matrix.* Out of scope for Phase 2; reopen if/when a non-Base deployment is planned.

### 3.2 Block pinning — **CI pins via `RMPC_FORK_BLOCK` env var captured per refresh; local defaults to "latest minus N"**

- **CI pin:** the harness reads `RMPC_FORK_BLOCK` (decimal block number) and `RMPC_FORK_RPC_URL` from the workflow env. CI sets both via a checked-in workflow file. The pinned block number lives in `.github/workflows/fork-e2e-ci.yml` (or whatever the eventual workflow filename is) so any change to the pin is reviewable in PR diff. Refresh cadence is manual: a monthly "refresh fork pin" PR bumps the block to a recent finalized block (Base finality is fast, ~1s slot, ~2s finality on the Sequencer's view; pick blocks at least 100 blocks behind tip to stay clear of reorg risk).
- **Local "latest recent" mode:** if `RMPC_FORK_BLOCK` is unset, the harness asks the RPC for `eth_blockNumber - LOCAL_LAG` (default lag = 50 blocks) and uses that. This satisfies plan §8's "local runs may opt into latest-recent fork mode for smoke testing" without needing any branching code path beyond a single env-var check.
- **Recording in test output:** every test logs `(chain_id, fork_block, rpc_label, address_set_hash)` in its first line of output. `rpc_label` is a sanitized hostname (no API key). `address_set_hash` is a sha256 of the sorted contract address list, so a drift in expected addresses fails loudly even if a single test address is wrong.
- **Constraint cited:** plan §8 acceptance criterion "CI catches ABI/address drift against the pinned fork" plus the project's no-fast-feedback constraint (we accept the cost of an archive RPC call to refresh the pin rather than caching state locally).
- **Rejected alternatives:**
  - *Pin stored in a JSON file.* Marginally cleaner diffs but adds a fixture-load path. The workflow env-var form is the smallest moving part.
  - *Auto-refresh the pin in CI on a schedule.* Removes review of pin changes. A monthly manual refresh PR is the smallest auditable unit.

### 3.3 Harness driver — **Rust integration test crate (`testing/fork-e2e-rust/`), no TypeScript reuse**

- **Driver:** Phase 2 ships as a Rust integration test crate parallel to the existing Phase 1 `testing/ethereum-testnet/e2e-rust/` crate. The new crate's `Cargo.toml` lives at `testing/fork-e2e-rust/Cargo.toml` and depends on `alloy-provider`, `alloy-signer-local`, `alloy-sol-types`, and the same `rmpc` workspace crate the Phase 1 e2e uses.
- **`rmpc` ownership:** the test surface invokes `rmpc` subcommands through the same `Fixture` pattern Phase 1 already uses (`Fixture::new()` after issue #37 lands). No bypassing of `rmpc` for read or write paths — fork tests must drive the same CLI surface that ships to users.
- **TypeScript fork-test logic:** treated as a *reference for fixture data* only — addresses, USDC funding amounts, expected slippage envelopes — and not migrated into the harness. Once Phase 2 lands, the legacy TS fork tests are deleted in a follow-up issue (track separately; not in scope of this scout).
- **Constraint cited:** plan §8 says "Prefer Rust integration tests once `rmpc` owns the command surface". `rmpc` already owns the Phase 1 command surface (per `docs/implementation-plan.md` §4 and §5), so the precondition is satisfied. Picking Rust now also matches the Phase 1 e2e crate, so contributors learn one harness shape, not two.
- **Rejected alternatives:**
  - *Reuse the TypeScript fork tests as the long-term driver.* Forces two harness shapes, two CI runners, two sets of fixture-loading code. Rejected.
  - *Reuse the Phase 1 `testing/ethereum-testnet/e2e-rust/` crate.* Phase 1 tests against a local Geth+Lighthouse devnet with deploy-then-test semantics. Phase 2 tests against a forked archive node with no deploy step. Mixing them in one crate would require runtime branching on backend type for every fixture. Two crates is the smaller change.

### 3.4 CI vs manual-trigger split — **`vault_deposit_redeem_smoke` + `abi_address_sanity` on every PR; the rest on `workflow_dispatch` and on `main` post-merge**

- **PR-time CI subset (mandatory, blocking):**
  - `abi_address_sanity` (§8 scenario 4) — fast, no on-chain writes, catches the most common drift class.
  - `vault_deposit_redeem_smoke` (§8 scenario 1) — exercises the full deposit→redeem path against the actual deployed vault. This is the load-bearing scenario; without it, ABI/address checks alone would not catch silent revert behavior changes.
- **Manual / post-merge subset:**
  - `dex_route_smoke` (§8 scenario 2) — DEX state is volatile; pinning is per-block, but a route that worked at block N may not at block N+monthly-refresh. Run on dispatch and post-merge so a failure does not block unrelated PRs.
  - `gas_estimate_reality_check` (§8 scenario 3) — gas budgets shift with EIP changes and L1 base fee. Run post-merge.
  - `failure_surface_smoke` (§8 scenario 5) — needs more orchestration (paused / cap / allowance / balance permutations). Run on dispatch and post-merge.
- **Trigger surface:** the same workflow file declares both jobs; only the job filter differs by trigger. PR-time ~3 min budget; full suite up to ~15 min.
- **Constraint cited:** plan §8 outputs section ("a CI job that runs a pinned fork smoke subset" + "a release-gated or manually-triggered job that runs the fuller fork suite") plus the no-fast-feedback constraint (we accept ~3 min added PR latency in exchange for catching deployed-bytecode drift).

### 3.5 Per-test isolation — **fork-restart per test (not snapshot/revert), ephemeral signer per test via `alloy-signer-local`**

- **Isolation primitive:** each `#[tokio::test]` boots its own forked backend and tears it down at end of test. No shared backend across tests, no `evm_snapshot`/`evm_revert` orchestration. This is slower than snapshot/revert, but matches the no-fast-feedback constraint and removes an entire class of test pollution bugs (snapshot-id leaks, revert-after-error gaps, parallel-test races on a shared backend).
- **Ephemeral signer:** each test calls `alloy_signer_local::PrivateKeySigner::random()` and funds the resulting address by impersonating a known whale (USDC top holder on Base) via the fork backend's impersonation RPC. Funding is per-test, not shared. The fork backend choice (§3.6) supports impersonation natively.
- **Constraint cited:** plan §8 says "every test uses an isolated ephemeral key and snapshot/revert". The "snapshot/revert" language is preserved as a *fallback option* for tests that are too slow under fork-restart; for the Phase 2 acceptance scenarios listed in §8, fork-restart is fast enough (Base archive RPC plus a fresh fork instance is ~1–3s per test) and removes failure modes.
- **Rejected alternatives:**
  - *Single shared backend with snapshot/revert across tests.* Faster but introduces ordering dependencies and snapshot-id state. The no-fast-feedback constraint says we should not optimize for this.
  - *Forge `--fork-url` with cheatcodes.* Foundry-driven; would split the harness across two languages and two binaries. Rejected by §3.3.

### 3.6 Issue #37 — **Accept (drop Anvil flavor in Phase 1; use Anvil only as the fork backend in Phase 2)**

- **Recommendation:** accept #37 as written. Drop the Anvil *flavor* from the Phase 1 e2e harness so Phase 1 runs only on Geth+Lighthouse. This reduces parallel maintenance burden without changing what Phase 1 actually proves.
- **Phase 2 nuance — Anvil reappears as a *fork backend*, not as a flavor:** Phase 2 forks Base mainnet. The standard tool for forking an EVM RPC into a local backend is `anvil --fork-url`. That use of Anvil is *not* what #37 is removing — #37 is removing Anvil-as-a-Phase-1-devnet-substitute. Anvil-as-a-fork-process is the right tool for §3.5's per-test backend, because:
  - It supports `eth_impersonate` (needed for §3.5 funding).
  - It supports `--fork-block-number` (needed for §3.2 pinning).
  - It is a single binary shipped by Foundry; no consensus layer needed because there is no block production beyond test transactions.
- **Constraint cited:** the "no fast-feedback optimization" memo plus #37's own justification (duplicate coverage, parallel maintenance burden). Phase 2 picks Anvil-as-fork-backend specifically because it is the *only* tool that simultaneously supports impersonation, fork-block pinning, and per-test restart in <3 s. Geth has no `eth_impersonate` and cannot start from a fork URL, so it is not a candidate for Phase 2 backend.
- **Cross-issue handoff:** when #37 lands, `Fixture::geth()` becomes `Fixture::new()` (per #37 scope). Phase 2's new `testing/fork-e2e-rust/` crate introduces its own `ForkFixture` constructor; the two `Fixture` types do not need to share a trait. Document this split in the Phase 2 README when the harness is built.
- **Status:** accept. No deferral, no rejection. Phase 2 work assumes Phase 1 has already dropped Anvil per #37.

## 4. Impact on `docs/implementation-plan.md` §8

The decisions above are consistent with §8 as written. **No §8 acceptance criterion changes.** The §8 prose can be left unchanged; this ADR provides the missing operational detail (RPC env vars, pin-refresh cadence, per-test backend, scenario→trigger mapping) that §8 deliberately left out.

If a future PR wants a single-line cross-link, the right place is at the end of §8 ("Acceptance criteria") — add `See docs/technical/fork-e2e-decisions.md for the operational decision record (issue #47).` That edit is *not required* to satisfy this scout's acceptance criteria; the implementation-plan acceptance criterion only fires "if the record changes any §8 acceptance criterion". Since none change, only an optional convenience link applies.

## 5. Open follow-ups (not in scope of this scout)

- **#37 must land before Phase 2 implementation begins** so `Fixture::new()` (Geth) is the only Phase 1 fixture and contributors are not learning a 3-fixture model (Phase 1 Geth, Phase 1 Anvil, Phase 2 fork).
- **Pin-refresh runbook.** Once the workflow file exists, document the exact `cast block-number --rpc-url …` → bump-pin-PR flow in a one-paragraph runbook in the Phase 2 README. Out of scope here.
- **Whale funding map.** §3.5 funding requires a known USDC whale address on Base. Capture this in the Phase 2 fixture module when it is built; do not hard-code in this ADR.
- **Legacy TS fork-test deletion.** Track as a separate issue once Phase 2 is green.

## 6. References

- `docs/implementation-plan.md` §8 — Phase 2 — Forked Smart-Contract E2E (constraints this ADR resolves).
- `docs/implementation-plan.md` §5 — Phase 1 e2e plan (precedent for the Rust integration-test pattern).
- `docs/technical/smart-contracts.md` §2 — Base-mainnet deployed addresses (justifies §3.1 chain choice).
- `docs/development/testing-strategy-ethereum.md` — Geth+Lighthouse devnet doc (Phase 1 stack; Phase 2 does not use it).
- Issue #37 — drop Anvil flavor, consolidate on Geth+Lighthouse (accepted, see §3.6).
- Issue #47 — this scout.
- User memory: "No fast-feedback optimization in test harness" (binding constraint cited throughout).
