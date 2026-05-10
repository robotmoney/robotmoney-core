# Robot Money Skills

> **Experimental** — pre-v1.0. APIs, command syntax, and contract interfaces may change without notice. Review every transaction before signing.

This repository hosts the in-development pieces that let agents transact against the Robot Money vault safely:

- **`contracts/gateway/`** — `RobotMoneyGateway.sol` (deposit + per-agent policy + pause), `AccessRoles.sol`, mocks, and the deploy script. On-chain enforcement of per-agent caps, windowed limits, role separation, and idempotent payment IDs.
- **`clients/rust-payment-client/`** — `rmpc`, the Rust signing client. One-shot CLI with `deposit`, `self-check`, and `status` subcommands. Encrypted-keystore software signer, structured + audit logging, preflight checks pinned to a deployed gateway code-hash.
- **`testing/ethereum-testnet/`** — Geth + Lighthouse devnet harness, deploy overlay, and an end-to-end Rust test crate (`e2e-rust/`) that drives `rmpc` against a live devnet.
- **`docs/`** — architecture proposal, MVP implementation plan, project roadmap, and on-chain reference docs.

## Bootstrap prompts for agent vendors

Paste the paragraph for your agent runtime into a new session. The agent will download the `rmpc` binary, load the Robot Money skill, write an operator config, and tell you when it needs you to open the dapp to authorize the signing key.

### OpenCode

> Download the latest `rmpc` release binary for this platform from `https://github.com/lucky-tensor/robotmoney-skills/releases/latest` and place it on `PATH`. Then load the Robot Money skill package by running `opencode --plugin /path/to/robotmoney-skills/plugins/robotmoney-cli`. Once the plugin is loaded, write a fork-default operator config at `./rmpc-fork.toml` using the template in `docs/walkthroughs/opencode-readonly-fork.md` §Step 3, substituting the real gateway and vault addresses if you have them. Run `rmpc self-check --config ./rmpc-fork.toml --pretty` to confirm the signer backend is reachable. Finally, open the Robot Money dapp, paste the agent's public address into the "Authorize agent" panel, set the deposit caps, and submit the `grantAgentRole` transaction — come back here once the dapp confirms the on-chain state change.

### OpenClaw

> Download the latest `rmpc` release binary for this platform from `https://github.com/lucky-tensor/robotmoney-skills/releases/latest` and install it at the path referenced by `RMPC_BIN` (or place it system-wide so the default harness path resolves). Write an operator config at `/etc/openclaw/rmpc.toml` using the template in `docs/walkthroughs/openclaw-config.md` §2, then export `RMPC_CONFIG=/etc/openclaw/rmpc.toml` and `RMPC_NETWORK=fork`. Start the bounded monitor with `bash testing/openclaw-config/openclaw_harness.sh` and confirm it exits 0 after the configured iterations. Once the monitor is green, open the Robot Money dapp, paste the agent's public address into the "Authorize agent" panel, set the deposit caps, and submit the `grantAgentRole` transaction — the harness will pick up the new policy on its next poll cycle.

### Claude Code

> Download the latest `rmpc` release binary for this platform from `https://github.com/lucky-tensor/robotmoney-skills/releases/latest` and place it on `PATH`. From your checkout of this repo, register the skill package with Claude Code by adding `plugins/robotmoney-cli` as a plugin (the skill files are already present at that path — no separate clone needed). Write a fork-default operator config at `./rmpc-fork.toml` using the template in `docs/walkthroughs/opencode-readonly-fork.md` §Step 3. Run `rmpc self-check --config ./rmpc-fork.toml --pretty` and confirm the signer backend reports ready. When you are satisfied the reads are working, open the Robot Money dapp, paste the agent's public address into the "Authorize agent" panel, set the deposit caps, and submit the `grantAgentRole` transaction — return here once the dapp confirms the authorization is on-chain.

## Starting a local devnet

**Prerequisites (Ubuntu):** Docker and [Foundry](https://getfoundry.sh).

```bash
# Keep a devnet alive for interactive use — prints RPC URL and contract addresses:
cargo run --bin smoke-test

# Or boot a devnet inside a single integration test:
# let fixture = smoke_test::Fixture::new()?;
# Drop tears the stack down automatically.
```

`smoke-test` starts the Geth + Lighthouse compose stack from `testing/ethereum-testnet/`, deploys contracts, and funds test EOAs. See `docs/testing/smoke-test-design.md` for details.

## Status

The MVP is merged on `dev`. See `docs/implementation-plan.md` for the build plan and PRs #22–#41 for the delivery history.

The pre-pivot TypeScript CLI (`@robotmoney/cli`) and its surrounding pnpm workspace lived on this repo's `main` branch and on `origin/main`; an archival copy together with its security review is preserved at `archive/ts-cli-security-review` (locked from deletion and force-push).

## Quick links

- [Architecture proposal](docs/architecture.md)
- [MVP implementation plan](docs/implementation-plan.md)
- [Project roadmap](docs/project-roadmap.md)
- [Smart-contract reference](docs/technical/smart-contracts.md)
- [Testing strategy](docs/testing-strategy-ethereum.md)
- Vault on BaseScan: https://basescan.org/address/0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd

## License

Apache-2.0. See [LICENSE](LICENSE).
