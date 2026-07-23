# ADR-0011: Fork tests run against checked-in golden fixtures on every merge; live drift is a non-blocking nightly

- **Status:** Accepted
- **Date:** 2026-07-20
- **Deciders:** Product owner
- **Supersedes (in part):** `docs/technical/fork-e2e-decisions.md` —
  specifically **§3.1** (CI consumes a vault-stored archive RPC endpoint),
  **§3.2** (monthly manual "refresh fork pin" cadence), and **§3.4** (a
  PR-time *live* fork subset gated on a CI secret). The rest of that ADR —
  Base as the fork target (§3.1's chain choice), the Rust harness driver
  (§3.3), the per-test isolation model (§3.5), and the Anvil-as-fork-backend
  recommendation (§3.6) — stands unchanged.
- **Related:**
  - `docs/technical/fork-e2e-decisions.md` (the partially-superseded ADR)
  - `docs/development/ci-suites.md` §5 (Fork integration tests) and §21
    (nightly full-suite orchestrator)
  - `docs/development/environments.md` §2 (Fork e2e) and its "Refreshing the
    fork-state fixture" section
  - `testing/fixtures/fork-state/` — the checked-in golden fixtures
    (`CURRENT.anvil-state`, `genesis-alloc.json`, pinned
    `base-<block>.anvil-state`)
  - `scripts/devnet/snapshot-fork.sh` — the developer-run fixture generator
  - `testing/fork-e2e-rust/` — the Rust fork-e2e crate that provides the
    `anvil --load-state` fixture-loading mechanism
  - `contracts/test/VaultForkRegressions.t.sol`,
    `contracts/test/DeploySeedDeposit.t.sol`,
    `contracts/test/SafeIntegration.t.sol` — the Solidity fork tests being
    converted from live-RPC to golden-fixture
  - `Plan tracking issue #109` §8 — Forked Smart-Contract E2E (the phase this
    decision operationalizes)
  - Blocker issue #1138 (parked the unified-vault tail) and PR #1136 (the PR
    whose loud-skip fork test surfaced the inconsistency)

## Context

The fork-testing story in the repository is **internally inconsistent today**,
and that inconsistency — not a genuine test failure — is what parked the
unified-vault tail behind blocker issue #1138.

**The Rust layer already has the fixture *mechanism* — but not yet the offline
coverage.** `testing/fork-e2e-rust/` can load a **checked-in golden fixture**
with `anvil --load-state` from `testing/fixtures/fork-state/`
(`CURRENT.anvil-state`, `genesis-alloc.json`, and pinned
`base-<block>.anvil-state` snapshots) — deterministic, offline, no secret. That
mechanism exists, but it is **not yet the coverage path**: the checked-in
fixture carries contract bytecode without the full Base-contract storage, so the
flagship Rust scenarios (`vault_deposit_redeem_smoke`, `dex_route_smoke`,
`abi_address_sanity`) still fork a **live** `RMPC_FORK_RPC_URL` and silent-skip
without it (`testing/fork-e2e-rust/src/lib.rs:150-164`). Offline goldens is the
desired end-state this ADR authorizes; reaching it still requires enriching the
fixture with the storage those scenarios read.

**The Solidity forge fork tests are the outlier.**
`contracts/test/VaultForkRegressions.t.sol`, `DeploySeedDeposit.t.sol`,
`SafeIntegration.t.sol`, and issue #1118's new Uniswap V3 adapter fork test all
call `vm.createSelectFork(rpc)` against a **live** archive RPC at **latest**
block, reading `RMPC_FORK_RPC_URL` / `FORK_RPC_URL`, or otherwise skip. That
secret was **never provisioned in CI**. The consequence: for the whole life of
those tests they have **silently skip-cleaned to green** in CI, exercising zero
fork assertions — a textbook false green that violates the repo's loud-skip
test-coverage policy (`skills/_shared/test-coverage-policy.md`, invariants 1–2:
loud-skip-never-silent-skip, and exit-0-is-not-tested).

Issue #1118's new adapter fork test is the one that behaves **correctly**: its
`setUp` **reverts** when the RPC is absent (a loud skip), which turned the
long-standing false green **red**. That is why PR #1136 fails, and why blocker
issue #1138 parked the entire unified-vault tail (#1118 / #1124 / #1125 /
#1126 / #1127 / #1129 / #1130 / #1131). The red is real in the sense that the
coverage was always missing; it is *not* a real product regression.

**The secret is not actually needed.** The stale ADR
`docs/technical/fork-e2e-decisions.md` prescribes a live archive RPC in CI
(§3.1), a monthly manual pin-refresh (§3.2), and a PR-time live fork subset
(§3.4). All three assume an external RPC endpoint provisioned as a CI secret.
No such secret was ever added, and provisioning one would reintroduce an
**external-authority dependency** (a repo-admin must hold and rotate an Alchemy/
Infura key) — exactly the kind of out-of-loop human gate that stalls the
auto-loop. The golden-fixture approach makes that secret unnecessary on the
merge path: the fixture **is** real Base mainnet state, captured once and
committed. (The Rust crate already loads it via `anvil --load-state`; what
remains is enriching the fixture with the full contract storage the flagship
scenarios read, so they stop needing a live RPC.) The only thing a live RPC
buys over the fixture is
**freshness** — catching upstream drift (pool migrations, ABI changes, oracle
heartbeat changes) that a pinned snapshot cannot see. Freshness is valuable,
but it does not need to gate every merge, and it does not need a secret.

## Decision

Move every merge-gating fork test — Solidity and Rust — onto the checked-in
golden fixture, and move live-realism to a separate, non-blocking lane.

### 1. Every `dev` CI fork test runs against the checked-in golden fixture — required, offline, no secret

All fork tests that gate merges — both feature-PR and `dev`-merge runs — execute
against the **committed golden fixture**, deterministically and offline. No CI
secret, no live RPC.

- The Rust layer already has the loading mechanism (`anvil --load-state` of
  `testing/fixtures/fork-state/CURRENT.anvil-state`); reaching offline coverage
  still requires enriching that fixture with full contract storage so the
  flagship scenarios (`vault_deposit_redeem_smoke`, `dex_route_smoke`,
  `abi_address_sanity`) stop needing a live `RMPC_FORK_RPC_URL`.
- For the Solidity layer, the tests change from `vm.createSelectFork(rpc)` at
  latest to **forking the committed `CURRENT.anvil-state` at a pinned block**
  (`RMPC_FORK_BLOCK`), matching the Rust layer's `--load-state` fixture
  mechanism. The live-RPC read at latest is removed from the CI path.

This is the **required gate**. Coverage MUST be **loud**, per the repo's
test-coverage / loud-skip policy (`skills/_shared/test-coverage-policy.md`): if
the golden fixture is missing, or if **zero** fork tests execute, CI **fails** —
it never silent-skips. A missing fixture or an empty fork run is red, not
green. This is the direct fix for the pre-existing legacy silent-skip.

### 2. Live-drift detection is a non-blocking nightly alarm on a free public RPC

A **schedule-only, non-blocking** nightly job forks **Base mainnet at latest**
via a **free public RPC** and re-runs the fork suite as a **drift alarm**.

- Forking at latest needs only a **full node, not an archive node** — you only
  read current state, not deep history. A free public endpoint is therefore
  sufficient: e.g. `https://mainnet.base.org`, PublicNode
  (`https://base-rpc.publicnode.com`), or LlamaRPC. A single nightly run will
  not be rate-limited by these.
- The endpoint URL is read from a **var with a public default** — **no CI
  secret**. (`scripts/devnet/snapshot-fork.sh` already defaults
  `RMPC_FORK_RPC_URL` to `https://base-rpc.publicnode.com`, so the same public
  default applies.)
- On failure the nightly **opens or updates a tracking issue** rather than
  blocking any merge. It is the lane that catches **real upstream drift** —
  pool migrations, ABI changes, oracle heartbeat changes — that a pinned
  snapshot structurally cannot.

The existing nightly full-suite orchestrator (`docs/development/ci-suites.md`
§21, `suite-21-nightly.yml`) is the natural host/dispatcher for this run; the
live-fork drift alarm is registered there rather than as a second scheduler.

### 3. Fixture refresh is developer-owned on change — no scheduled cadence

There is **no monthly (or any scheduled) refresh cadence**. The fixture is
refreshed by **whoever changes what it must cover**:

- Adding an adapter, wiring a new pool, or changing an integration → the
  **same PR** regenerates the fixture (`scripts/devnet/snapshot-fork.sh`, or
  the `scripts/devnet/refresh-fork-fixture.sh` wrapper) and commits it.
- A nightly drift alarm (Decision §2) firing → a developer refreshes the
  fixture in response, as a normal change.

The "monthly cadence" language in `fork-e2e-decisions.md` §3.2 is **removed**
and replaced by this developer-owned-on-change rule.

### 4. No CI secret is required anywhere

`RMPC_FORK_RPC_URL` is retained **only** for two developer/local uses:

- **(a)** optional **local** live-fork runs (a developer pointing at any Base
  endpoint, including a paid personal one); and
- **(b)** **fixture regeneration**, where a developer needs **archive depth**
  to snapshot a pinned historical block.

It is never a CI secret and never gates a merge. The nightly (§2) uses a
public-default var, not a secret.

## Consequences

**Positive.**

- **Unblocks #1118 and PR #1136**, and with them the parked unified-vault tail
  (#1124 / #1125 / #1126 / #1127 / #1129 / #1130 / #1131) and the venue
  adapters that depend on fork coverage.
- **Fixes the pre-existing legacy silent-skip.** The Solidity fork tests move
  from an always-skipped false green to a real, executed, loud gate — bringing
  them into compliance with the loud-skip test-coverage policy.
- **Removes the external-secret / repo-admin authority dependency** that
  stalled the auto-loop. No human must hold, provision, or rotate an archive
  RPC key for CI to be green.
- **Live-drift detection is preserved**, not lost — it moves to the nightly
  alarm, which is where an upstream change (pool migration, ABI change, oracle
  heartbeat change) actually needs to surface, and it opens a tracking issue
  instead of blocking an unrelated PR.
- **One consistent model across languages.** Rust and Solidity fork tests will
  load the same committed Base-mainnet state the same way.

**Negative / accepted trade-off.**

- **Per-merge realism is against a pinned snapshot, not live state.** A merge
  gate can no longer catch an upstream change that landed *after* the last
  fixture refresh; that detection is deferred to the non-blocking nightly (and
  to the developer who refreshes the fixture when they touch an integration).
  This is the deliberate trade: **determinism and no-secret on the merge path,
  live realism on the nightly.**
- A stale fixture can mask drift for up to a day (until the nightly runs) or
  until the next integration-touching PR — accepted, because the nightly bounds
  the staleness window and drift is not a correctness regression in *our*
  bytecode, only in the *assumptions* our tests make about upstream.

**Reconciliation with the binding "no fast-feedback optimization" constraint.**

`fork-e2e-decisions.md` §2/§3 cites a binding user-memory constraint: **the
project does not trade realism for CI iteration speed.** This decision does
**not** violate it, and the ADR states so explicitly so it does not read as a
silent reversal:

- The golden fixtures are chosen for **determinism** and for **no-secret /
  no-external-authority**, *not* to make CI faster. (In wall-clock terms
  `anvil --load-state` and a live fork are comparable; speed is not the
  motivation.)
- **Realism is preserved**: the golden fixture **is** real Base mainnet state
  (real deployed bytecode, real pools, real USDC), captured by
  `snapshot-fork.sh`. Testing against it is testing against reality — a pinned
  instant of it, not a synthetic chain.
- **Drift is still caught** — by the nightly live-fork alarm (§2). The realism
  the live-RPC path provided (freshness against upstream) is retained on the
  nightly lane; only the *secret-bearing, merge-blocking* form of it is
  removed.

The change is therefore along the **authority / determinism** axis (remove the
external secret, make every run reproducible), not the speed-vs-realism axis the
constraint governs.

## Addendum (issue #1152): sha256 integrity binding for the checked-in blob

The 2.8 MB single-line `.anvil-state` blobs this ADR moved every merge-gating
fork suite onto are the sole state source for those suites, and they are not
meaningfully reviewable in a PR diff — a hand-edited blob (malicious PR or
misbehaving automation) could alter balances or bytecode the regression tests
assert against while CI stayed green. This addendum closes that gap without
adding a new dependency or changing the decision above.

- Every `.anvil-state` blob under `testing/fixtures/fork-state/` has its
  sha256 recorded as `state_sha256` in its manifest (`CURRENT.json` and every
  committed `base-<block>.json`).
- `scripts/devnet/fork-state-digest.sh write <state_file> <manifest_json>`
  computes the digest and writes/overwrites `state_sha256` in place;
  `scripts/devnet/snapshot-fork.sh` calls it for both the dated
  `base-<block>.json` fixture and the `CURRENT.json` pointer at capture time,
  so `refresh-fork-fixture.sh` (which execs into `snapshot-fork.sh`) inherits
  it automatically.
- `scripts/devnet/fork-state-digest.sh verify <state_file> <manifest_json>`
  recomputes the digest and compares it to the recorded one. Per this ADR's
  loud-fail semantics, a missing field or a mismatch exits non-zero — never a
  warn-and-continue.
- `scripts/devnet/check-fork-manifest.sh` runs `verify` against
  `CURRENT.anvil-state` / `CURRENT.json` before anything downstream consumes
  the fixture; `run-golden-forge-forks.sh` already calls it ahead of
  `anvil --load-state`, so every suite-01-02 forge fork target is covered.
  The suite-05 `anvil-goldens` and `anvil-governance` matrix groups load
  `CURRENT.anvil-state` directly via `ForkFixture` and so bypass
  `check-fork-manifest.sh`; the workflow runs `fork-state-digest.sh verify`
  directly for those two groups before `cargo test`.
- Regeneration workflow is unchanged from Decision §3 (developer-owned on
  change): `snapshot-fork.sh` / `refresh-fork-fixture.sh` writes the new
  digest alongside the new blob, so a legitimate refresh shows up in review
  as an intentional manifest+digest diff — the reviewable proxy for the
  unreviewable blob — while a silent blob edit with no matching digest change
  becomes a red CI failure.
- Scope: sha256 of the raw file bytes only. No signing, no provenance chain,
  no change to `genesis-alloc.json` / `usdc-storage-seed.json` integrity
  (separate surfaces), no GitHub branch-protection changes. The nightly
  live-drift job (§2) does not consume the fixture and is out of scope.

## Out of scope of this decision

- The Base fork target, the Rust harness driver, per-test isolation, and the
  Anvil-as-fork-backend choice — the durable harness design, recorded in
  `docs/development/testing-strategy-ethereum.md` § Forked Base mainnet harness
  (migrated there from the now-historical `docs/technical/fork-e2e-decisions.md`
  scout), unchanged by this decision.
- The precise workflow YAML wiring (job filters, schedule cron, tracking-issue
  automation) — an implementation detail carried by the CI workflow files and
  catalogued in `docs/development/ci-suites.md` §5 / §21.
- Fixture format and manifest validation — governed by `snapshot-fork.sh`,
  `refresh-fork-fixture.sh`, and `check-fork-manifest.sh`.
