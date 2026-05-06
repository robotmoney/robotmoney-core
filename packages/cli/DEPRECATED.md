# DEPRECATED — `@robotmoney/cli` (TypeScript)

This package is **deprecated and kept only for reference**. As of
2026-05-06, the autonomous-agent access path to the Robot Money vault
is being rebuilt as:

- a Rust signing daemon (`rmpc`), and
- an on-chain policy gateway that wraps `vault.deposit()` with
  per-agent caps.

See:

- `docs/architecture-proposal-v0.md` — security architecture.
- `docs/implementation-plan-mvp.md` — buildable slice.

Files in `packages/cli/src/` are preserved as historical reference for
patterns (RPC fallback, error decoding, gas estimation, basket
encoding, simulation with state overrides) that may inform the Rust
implementation but should not be treated as the supported product
surface.

Do not extend this package. New work goes into the Rust client.
