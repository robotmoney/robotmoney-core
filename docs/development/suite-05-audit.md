# Suite-05 (Anvil mainnet-fork) coverage audit

> Canonical: `docs/development/ci-suites.md` §5, `docs/technical/fork-e2e-decisions.md`,
> `docs/implementation-plan.md` §8 and §9.

This audit answers a single question: does suite-05 catch regression
classes that no other CI suite catches, or is its coverage reproducible
more cheaply elsewhere? It is audit-only — no workflows, tests, or
suites are changed by the PR that lands this document. Any follow-on
slimming or retirement is a separate issue.

The audit was opened because, after the smoke-test `--full-stack`
devnet harness (#229), the Playwright devnet E2E (#231), and the
retirement of the Anvil OpenClaw demo suite (#244) landed, the role of
suite-05 was no longer self-evident. The §5 rationale in `ci-suites.md`
(added by PR #241) defends Anvil-fork in principle; this document
checks the principle against every test the suite actually runs today.

---

## Suites referenced

- **Suite 1–2** — Solidity unit and invariant tests (`forge`). Run
  against locally-deployed contracts; no mainnet bytecode involved.
- **Suite 5** — this suite. Anvil forks Base mainnet at a pinned block,
  exercises the production `RobotMoneyVault` and Base USDC, and drives
  the `rmpc` CLI binaries against the fork.
- **Suite 6** — `rmpc` Rust unit tests (`cargo test --lib`). Calldata
  builders, preflight rejection, JSON envelope, config parsing.
  No chain.
- **Suite 7** — `rmpc` integration tests against devnet (Geth+Lighthouse
  with freshly-deployed fixture contracts). Exercises end-to-end
  deposit/policy/window-cap behaviour but against contracts deployed
  by the test fixture, not the production Base deployment.
- **Suite 14** — smoke-test `--full-stack` devnet harness boot.
  Same chain as suite 7; different driver.

The relevant distinction is suite 5 vs the rest: suite 5 is the only
suite whose contract _bytecode_ is the production Base deployment.
All other Rust/Solidity suites exercise freshly-deployed contracts.

---

## Test-by-test coverage map

| Test | Regression class caught | Caught by another suite? | Unique-to-fork? |
|---|---|---|---|
| `abi_address_sanity` | Drift between `rmpc`'s typed Alloy bindings and the Base-deployed `RobotMoneyVault` / Base USDC bytecode: missing selectors, address-constant typos, decode failures against the live ABI. | Suite 6 verifies calldata _encoding_ against the bindings rmpc was compiled with — it does **not** verify those bindings still match production bytecode. No other suite touches mainnet bytecode. | **Yes.** This is the canonical "production-bytecode drift detector" and the cheapest fork scenario per ADR §3.4. |
| `vault_deposit_redeem_smoke` | End-to-end deposit→share-balance→redeem round-trip against the deployed vault, asserting the net USDC delta stays inside the configured `exitFeeBps`. Catches silent revert / fee-policy / strategy-rebalance behaviour changes in the production vault bytecode that would not appear in freshly-deployed fixtures. | Suite 7's `deposit_happy_path` exercises a deposit round-trip but against a fixture-deployed gateway+vault — it cannot catch behaviour drift in the _Base-deployed_ vault (e.g. a strategy adapter swap, an `exitFeeBps` change applied by upgrade). | **Yes.** ADR §3.4 marks this and `abi_address_sanity` as the load-bearing PR-time pair. |
| `dex_route_smoke` | Uniswap V3 `SwapRouter02` `exactInputSingle` USDC→WETH route still resolves against the pinned pool state. Catches a deployed-router selector change or a pool that has been drained / migrated. | None. Suite 7 deploys no DEX router. Suites 1–2 do not depend on DEX state. | **Yes.** Only Anvil-fork mounts live DEX pool state. |
| `gas_estimate_reality_check` | Production-bytecode gas cost for approve / deposit / redeem stays inside conservative ceilings (catches a ~2× regression after an EIP repricing or a strategy rewrite). | No. Suite 7 measures gas against fixture contracts, which intentionally take shortcuts the production strategies do not. | **Yes.** Only fork bytecode has the realistic gas profile. |
| `failure_surface_smoke` | Documented refusal surfaces of the deployed vault (insufficient balance, missing allowance, paused / tvlCap permutations where reproducible on a fork) revert cleanly and leave no partial state. | Partly. Suites 1–2 cover `paused`, `tvlCap`, and balance/allowance reverts at the Solidity level against newly-deployed contracts. The fork variant catches the _interaction_ between the production strategy adapters and these guards, which fixture contracts do not exercise. | **Partial.** Most cases are also covered by forge unit/invariant tests; the strategy-interaction case is fork-unique. Candidate for slimming, not retirement. |
| `rmpc_get_balance_against_fork` | `rmpc get-balance` round-trips on-chain USDC balance through the JSON envelope against the live Base USDC contract (currently `#[ignore]` pending #249). | Suite 6 covers envelope shape and parsing. No other suite reads from real Base USDC. | **Yes** for the production-USDC bytecode dimension; **no** for envelope shape (suite 6). |
| `rmpc_get_allowance_against_fork` | `rmpc get-allowance` reads `allowance(owner, spender)` from live Base USDC after an on-chain `approve` (currently `#[ignore]` pending #249). | Suite 6 covers calldata/envelope. No other suite touches real USDC `approve`. | **Yes** for the production-USDC dimension. |
| `rmpc_get_tx_against_fork` | `rmpc get-tx` parses a real receipt and reports `status: success`, gas, and effective gas price; unknown-tx-hash exits 4. | Suite 6 covers envelope shape. Receipts in suite 7 come from a devnet that uses simpler EIP-1559 dynamics than mainnet. | **Partial.** Envelope and exit-code paths are suite-6 territory; the real-1559 receipt shape is fork-unique. |
| `rmpc_get_vault_fork_base_mainnet` | `rmpc get-vault` against the deployed vault asserts asset == USDC, symbol == "rmUSDC", decimals == 6 (currently `#[ignore]` pending #249). | None — no other suite reads from the production vault. | **Yes.** |
| `rmpc_get_vault_rejects_malformed_address` | `rmpc get-vault` exits 2 on a malformed address. Runs against the checked-in fork state on every PR (no live RPC). | Suite 6 covers exit codes / argument parsing. This test duplicates that envelope check; it lives in suite 5 only because it shares the fork-test harness. | **No.** Suite 6 already catches this class. |
| `rmpc_get_deposit_unknown_id_against_fork` | `rmpc get-deposit` against an EOA gateway address surfaces `ErrDepositNotFound` (exit 4) — the documented "no gateway deployed yet" degradation path. | Suite 7 will catch the happy path once a real gateway lands; suite 6 covers exit-code mapping. The not-found path against a no-bytecode address is a degradation behaviour that does not require production bytecode. | **No.** Suite 6 plus a fixture-deployed-EOA case in suite 7 would cover this. |

---

## Anvil alternatives considered

The audit also evaluated whether the unique-to-fork subset could be
moved off Anvil to avoid the Foundry toolchain install. Three
alternatives were considered:

1. **Typed ABI bindings re-generated from a pinned mainnet artifact.**
   This would catch _selector_ drift against a snapshotted ABI but
   would not exercise the deployed _bytecode_ — a strategy-adapter
   behaviour change, a fee-policy upgrade, or a `paused` toggle on
   Base would not appear. Strictly weaker than the current setup for
   the load-bearing tests (`vault_deposit_redeem_smoke`,
   `gas_estimate_reality_check`).

2. **Geth+Lighthouse with a state import.** No tested workflow exists
   for importing a Base-mainnet state snapshot into Geth+Lighthouse
   in CI. Even if it worked, fork-restart-per-test isolation (ADR §3.5)
   would require minute-scale boot per test instead of seconds — a
   non-trivial regression in suite latency.

3. **Contracts-as-fixtures (re-deploy a strategy stand-in into the
   devnet).** This is what suite 7 already does. It does not catch
   production-bytecode drift, by construction.

None of these dominates `anvil --fork-url` for the load-bearing tests.
The Foundry install is the price of the only known way to mount Base
mainnet state with cheat-code mutability.

---

## Recommendation

**Keep suite-05, with a follow-up slim.**

Justification: Six of the eleven tests (`abi_address_sanity`,
`vault_deposit_redeem_smoke`, `dex_route_smoke`,
`gas_estimate_reality_check`, `rmpc_get_balance_against_fork`,
`rmpc_get_allowance_against_fork`, `rmpc_get_vault_fork_base_mainnet`)
catch regression classes that no other suite covers — drift between
`rmpc`'s typed bindings and the production Base bytecode, deployed-vault
behaviour changes, real DEX pool state, real gas costs, and real Base
USDC reads. These are the regression classes the ADR (§3.4) was
designed to catch and they remain genuinely fork-unique. Two more
(`failure_surface_smoke`, `rmpc_get_tx_against_fork`) have a
fork-unique sub-case worth keeping. Two (`rmpc_get_vault_rejects_malformed_address`,
`rmpc_get_deposit_unknown_id_against_fork`) duplicate coverage already
present in suite 6 and could be migrated there to shrink the suite's
post-merge run-time; that migration is the natural follow-up but does
not justify retiring the suite.

The Anvil dependency itself is load-bearing: no evaluated alternative
catches production-bytecode drift, and the Foundry toolchain install
is a documented cost (~20 s in CI cache) that is dwarfed by the
~20 min the rest of the suite uses productively.

---

## Follow-up issues

- **#275** — slim duplicates: migrate
  `rmpc_get_vault_rejects_malformed_address` and
  `rmpc_get_deposit_unknown_id_against_fork` into suite 6, deleting
  them from suite 5.
- **#249** — unblock the four `#[ignore]`d `rmpc_get_*_fork` tests by
  fixing the USDC transparent-proxy admin collision in the fork
  fixture. Already on the Plan.

No retirement issue is filed: the recommendation is keep, not retire.
