# Agent Warnings — Deprecated Patterns and Known Pitfalls

Before writing or modifying any code, verify your plan does **not** use any pattern in this table.
If your issue or plan references a deprecated item, replace it with the current approach before proceeding.

---

## Deprecated patterns

| Deprecated | Replacement | Notes |
|---|---|---|
| `RMPC_FORK_RPC_URL` env var | `smoke-test` crate / `FullStackFixture` | Live archive RPC approach dropped; hermetic Geth+Lighthouse devnet via `testing/smoke-test/` is now canonical. No external RPC secret needed. |

---

## How to add an entry

When a pattern is retired, add a row here in the same PR that removes it from the codebase.
Keep entries permanent — do not delete rows when a deprecated item is fully purged, so future agents scanning git history or stale docs can still find the redirect.
