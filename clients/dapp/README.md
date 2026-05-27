# `clients/dapp` — Human admin dapp (issue #60)

Implements [`docs/implementation-plan.md`](../../docs/implementation-plan.md) §12 against the credential / custody / preview / export decisions in [`docs/technical/dapp-credential-decisions.md`](../../docs/technical/dapp-credential-decisions.md).

## Package manager

**[bun](https://bun.sh)** is the canonical package manager for this workspace.
`package.json` declares `"packageManager": "bun@1.3.5"` and all CI steps use `bun install --frozen-lockfile`.
Do not commit `pnpm-lock.yaml`, `package-lock.json`, or `yarn.lock`.

## Stack

- Vite + React + TypeScript
- viem + wagmi (mock connector for tests, EIP-1193 for production)
- Vitest (unit + snapshot tests)
- Playwright (E2E, fork-anvil sidecar in CI)

## Scope of this PR

MVP end-to-end:
- Connect wallet (mock for tests, EIP-1193 for production builds)
- Authorize agent flow with structured tx preview
- Revoke agent flow with structured tx preview
- TOML config export for hardware / KMS / encrypted-keystore signers
- First-run onboarding wizard that hands the operator a paste-ready agent bootstrap prompt before the on-chain `authorizeAgent` step
- Browser-side keypair generation is **not** supported: the dapp never sees or generates a private key (ADR §3.1)

Deferred to follow-ups:
- Pause / unpause UI (encoder + preview already in `src/lib/preview.ts`; UI surface to be added)
- Role grant / revoke for ADMIN/PAUSER roles
- Full fork-anvil-driven Playwright authorize/revoke + `rmpc self-check` integration (see test plan)
- TOML round-trip Rust integration test inside `clients/rust-payment-client/tests/`

## Running

```sh
bun install
bun run dev                           # http://127.0.0.1:5173
bun run test                          # Vitest unit tests
# Playwright E2E boots a real Geth+Lighthouse devnet via globalSetup —
# requires Docker + Foundry on PATH. See docs/development/smoke-test-design.md.
bunx playwright install --with-deps chromium && bun run test:e2e
```

## Env

| Var | Default | Purpose |
| --- | --- | --- |
| `VITE_GATEWAY_ADDRESS` | `0x000…0` | Gateway contract address |
| `VITE_VAULT_ADDRESS` | `0x000…0` | Vault contract address |
| `VITE_FORK_RPC_URL` | `http://127.0.0.1:8545` | RPC endpoint |
| `VITE_GATEWAY_EXPECTED_CODE_HASH` | unset | Keccak-256 of the gateway runtime bytecode. Admin writes refused until this matches on-chain. |
| `VITE_GATEWAY_CODE_HASH_VERIFIED` | `true` | Set `false` to test refusal path |
| `VITE_ENV_CLASS` | `fork` | One of `fork` / `devnet` / `testnet` / `mainnet` |
| `VITE_HISTORY_PANE` | unset (false) | Opt-in to the explorer-API-backed history pane |
