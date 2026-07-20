# Explorer indexer integration tests

Canonical: Plan tracking issue #109 (formerly `Plan tracking issue #109` §11) + `docs/technical/explorer-schema-decisions.md` (issue #56).
Implements: issue #57 / PR #76.

The explorer-indexer crate lives at `services/explorer-indexer/`. Its
integration tests boot a Postgres testcontainer and (for the fork
scenario) a forked-Base fork-anvil via the Phase 2 `rmpc-fork-e2e`
harness. Run them from the crate directory:

```sh
cd services/explorer-indexer
cargo test --test migrations    # schema sanity (Docker)
cargo test --test idempotency   # ON CONFLICT DO NOTHING (Docker)
cargo test --test rpc_failure   # indexer_runs error path (Docker)
cargo test --test fork_indexer  # full flow (Docker + RMPC_FORK_RPC_URL)
```

Each test prints a skip line and exits 0 when its **local** prerequisites are
missing — Docker-less laptops skip the Docker tests, and `fork_indexer` skips
when `RMPC_FORK_RPC_URL` is unset. This local silent-skip is a contributor
convenience, not the CI coverage model: the underlying fork harness is moving
to an offline checked-in fixture with no secret (see
[ADR-0011](../../docs/adr/ADR-0011-fork-test-golden-fixtures-and-nightly-drift.md)).

A wrapper script lives at `test_index_fork.sh` for the §11 acceptance
flow ("scripted indexer run against a fork-anvil range exits 0 and
populates all 9 tables"); it is a thin convenience over the cargo
invocations above.
