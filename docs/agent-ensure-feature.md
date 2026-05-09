# Agent Feature Registry — Regression Prevention

This file is the canonical record of shipped features. Every time a feature is successfully
merged, **add an entry here** so that parallel or future agents can verify the feature still
works before and after their own changes.

Before opening a PR, run every verification command relevant to the files you touched and
confirm each returns the expected outcome.

---

## Entry schema

```
### <feature name>
- **Issue:** #<number>
- **Merged:** <YYYY-MM-DD>
- **Touches:** <comma-separated list of top-level paths that own this feature>
- **Verify:** <single shell command or `cargo test -- <filter>` that proves the feature works>
- **Expected outcome:** <what a passing run looks like — exit 0, specific output line, etc.>
```

---

## Registry

### Hermetic fork-integration CI (smoke-test devnet fixture)
- **Issue:** #146
- **Merged:** 2026-05-09
- **Touches:** `testing/smoke-test/`, `testing/ethereum-testnet/`, `.github/workflows/suite-14-smoke-test.yml`
- **Verify:** `cargo test -p smoke-test --release -- --test-threads=1 --nocapture`
- **Expected outcome:** exit 0; output contains `devnet healthy` and `contracts deployed`

### Fork-protocol-adapter integration suite (hermetic fixture, no live RPC)
- **Issue:** #180
- **Merged:** 2026-05-09
- **Touches:** `testing/fork-e2e-rust/`, `.github/workflows/suite-05-fork-integration.yml`
- **Verify:** `cargo test --manifest-path testing/fork-e2e-rust/Cargo.toml --release -- abi_address_sanity vault_deposit_redeem_smoke --nocapture`
- **Expected outcome:** exit 0; both named tests pass

---

## Rules for agents

1. **On every feature merge:** add an entry before closing the issue.
2. **Before opening a PR:** run the verify commands for every entry whose `Touches` paths
   overlap with your diff. A failure means you have introduced a regression — fix it before
   requesting review.
3. **Never remove entries.** If a feature is superseded, mark it `*(superseded by #<number>)*`
   and add the new entry — the old verify command may still catch regressions in shared paths.
