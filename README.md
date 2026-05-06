# Robot Money Skills

> **Experimental** — pre-v1.0. APIs, command syntax, and contract interfaces may change without notice. Review every transaction before signing.

This repository hosts the in-development pieces that let agents transact against the Robot Money vault safely:

- **`contracts/gateway/`** — `RobotMoneyGateway.sol` (deposit + per-agent policy + pause), `AccessRoles.sol`, mocks, and the deploy script. On-chain enforcement of per-agent caps, windowed limits, role separation, and idempotent payment IDs.
- **`clients/rust-payment-client/`** — `rmpc`, the Rust signing client. One-shot CLI with `deposit`, `self-check`, and `status` subcommands. Encrypted-keystore software signer, structured + audit logging, preflight checks pinned to a deployed gateway code-hash.
- **`testing/ethereum-testnet/`** — Geth + Lighthouse devnet harness, deploy overlay, and an end-to-end Rust test crate (`e2e-rust/`) that drives `rmpc` against a live devnet.
- **`docs/`** — architecture proposal, MVP implementation plan, project roadmap, and on-chain reference docs.

## Status

The MVP is merged on `dev`. See `docs/implementation-plan-mvp.md` for the build plan and PRs #22–#41 for the delivery history.

The pre-pivot TypeScript CLI (`@robotmoney/cli`) and its surrounding pnpm workspace lived on this repo's `main` branch and on `origin/main`; an archival copy together with its security review is preserved at `archive/ts-cli-security-review` (locked from deletion and force-push).

## Quick links

- [Architecture proposal](docs/architecture-proposal-v0.md)
- [MVP implementation plan](docs/implementation-plan-mvp.md)
- [Project roadmap](docs/project-roadmap.md)
- [Smart-contract reference](docs/technical/smart-contracts.md)
- [Testing strategy](docs/testing-strategy-ethereum.md)
- Vault on BaseScan: https://basescan.org/address/0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd

## License

Apache-2.0. See [LICENSE](LICENSE).
