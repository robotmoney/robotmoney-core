# ADR — Forked Smart-Contract E2E: target chain, block pinning, harness driver

> **Historical.** Phase-2 fork-e2e dev-scout decision record (issue #47; it also
> resolved issue #37, "drop the Anvil flavor"). Retained for traceability only —
> its durable content has been re-homed (see §2 below).

## 1. Status

Accepted 2026-05-06 (Phase-2 forked-smart-contract-E2E scout against
`Plan tracking issue #109` §8) — now **historical**.

> **Superseded in part by [ADR-0011](../adr/ADR-0011-fork-test-golden-fixtures-and-nightly-drift.md) (2026-07-20).** ADR-0011 replaces **§3.1** (live archive RPC consumed in CI), **§3.2** (monthly manual pin-refresh cadence), and **§3.4** (PR-time *live* fork subset). The surviving decisions — chain target, Rust harness driver, per-test isolation, anvil-as-fork-backend, and the block-pin mechanism — were migrated to the harness-design home below; nothing in the original §3 body remains authoritative in this file.

## 2. Where this content now lives

The original scout body (context, the six §3 decisions with their
"constraint cited / rejected alternatives" prose, the Plan-§8 impact note, and
open follow-ups) has been removed as duplicative. Its still-valid substance now
lives in three homes:

- **Goldens-vs-live CI model + nightly drift alarm** →
  [ADR-0011](../adr/ADR-0011-fork-test-golden-fixtures-and-nightly-drift.md).
- **Harness design** — chain (Base mainnet, 8453), the Rust crate driver
  (`testing/fork-e2e-rust/`), the anvil fork backend, fork-restart-per-test
  isolation, and the `RMPC_FORK_BLOCK` pin mechanism →
  [testing-strategy-ethereum.md § Forked Base mainnet harness](../development/testing-strategy-ethereum.md#forked-base-mainnet-harness-fork-e2e).
- **Run / refresh operations** (commands, env vars, fixture refresh) →
  [environments.md § 2 (Fork e2e)](../development/environments.md).

## 3. References

- Issue #47 — this scout (fork target / block pinning / harness driver).
- Issue #37 — drop the Anvil flavor; consolidate the Phase-1 devnet on
  Geth+Lighthouse (resolved here).
- `Plan tracking issue #109` §8 — Phase-2 Forked Smart-Contract E2E.
