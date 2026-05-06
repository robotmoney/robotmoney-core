# @robotmoney/cli

> **DEPRECATED — kept for reference only.** This TypeScript CLI is no
> longer the supported autonomous-agent client. The replacement
> security architecture lives in `docs/architecture-proposal-v0.md`
> and the build slice in `docs/implementation-plan-mvp.md` (Rust
> daemon + on-chain policy gateway). Sources here are preserved for
> historical reference and may not receive further updates.

> **Experimental** — pre-v1.0. Command syntax and response schemas may change. Always review transactions before signing.

CLI for the [Robot Money](https://robotmoney.net) stablecoin yield vault on Base. Built for AI agents and autonomous machines — every command emits JSON to stdout.

Every deposit auto-splits **95% to the vault + 5% across a fixed 6-token agent basket** (VIRTUAL, ROBOT, BNKR, JUNO, ZFI, GIZA) atomically via Uniswap UniversalRouter — basket tokens land directly in the receiver's wallet. Use `--no-basket` for vault-only mode.

## Install

```bash
# One-off use
npx @robotmoney/cli <command> --chain base

# Or as a project dependency
npm install @robotmoney/cli
```

## Quickstart

### End-to-end via OWS (no external wallet needed)

```bash
# 1. Bootstrap a wallet
npx @robotmoney/cli create-wallet --label my-agent

# 2. Fund the printed address with USDC + a small amount of ETH for gas on Base

# 3. Execute the deposit (signs + broadcasts via OWS, returns tx hashes)
npx @robotmoney/cli execute-deposit --chain base --wallet my-agent --amount 100
```

### Prepare-only (you sign with your own wallet)

```bash
npx @robotmoney/cli prepare-deposit \
  --chain base \
  --user-address 0xYourAddress \
  --amount 100 \
  --receiver 0xYourAddress
```

## Commands

| Command | Description |
|---|---|
| `create-wallet` | Bootstrap a new Open Wallet Standard wallet |
| `health-check` | Check RPC connectivity and vault reachability |
| `get-vault` | Full vault state (caps, fees, share price); `--verbose` adds per-adapter breakdown |
| `get-balance` | A user's rmUSDC balance and USDC-equivalent value |
| `get-apy` | Blended APY across Morpho, Aave, and Compound |
| `get-basket-holdings` | All 6 basket-token balances + per-token USDC valuation |
| `prepare-deposit` | Unsigned deposit txs (95% vault + 5% basket); `--no-basket` for vault-only, `--basket-only` to skip vault, `--slippage-bps` for basket slippage |
| `prepare-redeem` | Unsigned redeem; supports basket sells via `--sell-all`, `--sell-percent`, `--sell-tokens`, `--sell-amounts`. `--shares 0` to skip vault leg |
| `prepare-withdraw` | Unsigned withdrawal by target net USDC; same basket-sell flags as `prepare-redeem`. `--amount 0` to skip vault leg |
| `execute-deposit` | Sign + broadcast a deposit (vault + basket) end-to-end via an OWS wallet |
| `execute-redeem` | Sign + broadcast a redeem + optional basket sells end-to-end |
| `execute-withdraw` | Sign + broadcast a withdraw + optional basket sells end-to-end |

## RPC configuration

The CLI uses a built-in fallback pool of 5 free Base mainnet endpoints by default, with automatic retry across endpoints when any one rate-limits. Override with:

```bash
# Flag (highest priority)
npx @robotmoney/cli get-vault --chain base --rpc-url https://base-mainnet.g.alchemy.com/v2/<key>

# Environment variable
RPC_URL=https://base-mainnet.g.alchemy.com/v2/<key> npx @robotmoney/cli get-vault --chain base
```

## OWS wallet + passphrase

`execute-*` commands use [Open Wallet Standard](https://openwallet.sh/) to sign.

- `--wallet <name>` — explicit wallet name. If omitted and only one wallet exists in `~/.ows/wallets/`, it's auto-picked.
- `--passphrase <string>` — passphrase flag (shell history hazard)
- `OWS_PASSPHRASE` env var — clean passphrase path for agents
- Otherwise, the CLI prompts interactively on a TTY

## Full docs

- Skill definition + LLM-facing docs: [`SKILL.md`](https://github.com/robotmoney/robotmoney-skills/blob/main/plugins/robotmoney-cli/skills/robotmoney-cli/SKILL.md)
- Read schemas: [`references/read.md`](https://github.com/robotmoney/robotmoney-skills/blob/main/plugins/robotmoney-cli/skills/robotmoney-cli/references/read.md)
- Write schemas: [`references/write.md`](https://github.com/robotmoney/robotmoney-skills/blob/main/plugins/robotmoney-cli/skills/robotmoney-cli/references/write.md)
- Basket leg (token list, flags, response shapes): [`references/basket.md`](https://github.com/robotmoney/robotmoney-skills/blob/main/plugins/robotmoney-cli/skills/robotmoney-cli/references/basket.md)
- Repo: https://github.com/robotmoney/robotmoney-skills

## License

MIT
