# Harness Quickstart — Send Your Zero-Human Company's Dollars to Treasury

> **TL;DR.** Your agent earns USD. Treasury is a Base-chain vault that yields on idle USDC and holds a small agent-economy basket. This doc shows how to wire the two together inside whatever harness your company runs on.

If you operate a zero-human company — a business where AI agents own the wallet, take the revenue, and make the spend decisions — you have two pipes you need to connect:

```
   ┌────────────────────┐         ┌─────────────────┐         ┌──────────────────┐
   │  Revenue rail      │   →     │  Agent wallet   │   →     │  Robot Money     │
   │  (Stripe, x402,    │  USDC   │  (Base, USDC)   │  USDC   │  treasury vault  │
   │   AP2, Skyfire…)   │         │                 │         │  (rmUSDC + yield)│
   └────────────────────┘         └─────────────────┘         └──────────────────┘
```

This quickstart gives you the second arrow. The first arrow — getting USD into the agent's wallet as Base USDC — is rail-specific and covered in §3.

---

## 1. The one command you need

Inside any harness that can shell out, the deposit is one line:

```bash
npx @robotmoney/cli execute-deposit --amount <USDC_amount>
```

That command:
1. Creates or loads the agent's Base wallet via Open Wallet Standard (no private keys touch the harness).
2. Approves USDC, deposits 95% into the yield vault, allocates 5% into the agent-economy basket.
3. Simulates everything before broadcasting. Aborts cleanly if any leg would fail.
4. Emits JSON to stdout with the resulting share balance and tx hashes.

If you only want yield, skip the basket:

```bash
npx @robotmoney/cli execute-deposit --amount <USDC_amount> --no-basket
```

To check the balance later:

```bash
npx @robotmoney/cli get-balance --user-address <wallet>
npx @robotmoney/cli get-apy
```

That's the whole product surface a treasury operator needs.

---

## 2. How this looks inside each harness

Every agent harness is a different runtime, but they all consume the same two things: the `@robotmoney/cli` binary and the `robotmoney-cli` plugin (a Claude-format skill that documents the commands). Treat each harness as an **integration target** with three setup steps:

| Step | What |
|---|---|
| **A. Install** | Make `npx @robotmoney/cli` reachable from the agent's shell. |
| **B. Load skill** | Point the harness at `plugins/robotmoney-cli/` (or its MCP equivalent) so the agent knows when to use the CLI. |
| **C. Wire trigger** | Decide what causes the agent to deposit — cron, balance threshold, end-of-day sweep, post-invoice hook. |

### Claude Code

```bash
# A. install
npm install -g @robotmoney/cli

# B. load skill — Claude Code reads the plugin directly
claude plugin install robotmoney-cli

# C. trigger — add to CLAUDE.md or a cron skill:
#   "When the agent wallet exceeds $500 USDC, sweep to treasury."
```

### Moltbook / OpenClaw / Paperclip and other autonomous-company harnesses

These platforms run agents on a schedule with no human in the loop. Two patterns work:

- **MCP integration.** If the harness speaks MCP, expose the CLI as an MCP server in its config. The skill's reference files (`read.md`, `write.md`, `basket.md`) port over without rewriting.
- **Direct shell.** If the harness lets the agent run shell commands, install the CLI globally and paste the relevant section of `SKILL.md` into the agent's system prompt or playbook. This works in every harness, including ones with no plugin system at all.

The trigger lives in the harness's own scheduler — daily sweep, threshold sweep, or post-revenue hook. The CLI is stateless; call it as often as you like.

### Generic / custom agent runtime

If you built your own agent loop, the integration is the same three steps:

1. Add `@robotmoney/cli` to the agent's tool environment (shell) or, once MCP server mode is available, run it as `npx @robotmoney/cli mcp` and connect over MCP. **MCP server mode is not yet implemented** — see [`docs/issues/issue-mcp-server-missing.md`](../issues/issue-mcp-server-missing.md).
2. Register `plugins/robotmoney-cli/skills/robotmoney-cli/SKILL.md` as a tool description in your prompt.
3. In your agent's planning step, add a goal like *"if idle USDC > threshold, deposit to treasury"*.

There is no harness-specific glue code to write. The CLI emits JSON, takes flags, and exits with a code. Anything that can run `bash` can run treasury.

---

## 3. Connecting your revenue rail to the agent wallet

Treasury accepts **USDC on Base, chain id 8453**. Whatever rail your company uses to earn USD, the job is to land that USD as Base USDC in the agent's wallet. Here's the pattern for the common agentic rails:

| Revenue rail | What it gives you | How to land it on Base |
|---|---|---|
| **Stripe (Agent SDK / standard payouts)** | USD in a Stripe balance | Payout to a Bridge / Beam / Mercury USD account → on-ramp to Base USDC (Coinbase, Bridge.xyz, Privy). Or use Stripe's stablecoin payouts directly to a Base address where supported. |
| **x402 (HTTP 402 micropayments)** | USDC, often already on Base | Configure the receiving address to be the agent's Base wallet. No bridging needed. |
| **AP2 / Agent Payments Protocol** | USDC on the protocol's settlement chain | If settled on Base, direct. If settled elsewhere, use CCTP (Circle Cross-Chain Transfer Protocol) to move to Base — the CLI's sister tooling can wrap this, or use Circle's API directly. |
| **Skyfire / Nevermined / Daydreams** | USDC on Base or Ethereum | Configure the agent's payout address as the Base wallet. For Ethereum-side balances, bridge via CCTP. |
| **Coinbase Agent Kit / Commerce** | USDC, configurable network | Set network to Base in the merchant config. |
| **Crossmint / Halliday / Catena settlement** | Stablecoin on a supported chain | Use the platform's withdraw-to-address feature targeting the agent's Base wallet. |
| **Direct invoice → wallet** (the agent issues invoices, customers pay onchain) | USDC on Base | Already there. Skip to §1. |

Once USDC is in the wallet, the deposit command in §1 is the same regardless of which rail filled the wallet.

### A note on the gap between "USD" and "USDC on Base"

Many rails settle in fiat USD, not stablecoins. Bridging fiat → Base USDC requires a regulated on-ramp (Bridge, Beam, Coinbase, Privy, Stripe stablecoin payouts). Pick one; the rest of this stack is rail-agnostic. If your company is fully onchain-native (paid in crypto from day one), you can skip this entirely.

---

## 4. The fully autonomous loop

The minimal end-to-end loop a zero-human company runs:

```
   every N hours, the agent:
     1. checks its wallet balance         →  npx @robotmoney/cli get-balance --chain base --user-address $SELF
     2. if balance > threshold:
          deposits the excess to treasury →  npx @robotmoney/cli execute-deposit --chain base --amount $((balance - reserve))
     3. logs the tx hashes
```

> **Note:** `get-balance` currently returns only the vault position (rmUSDC shares and NAV). The wallet's USDC balance — needed to compute the sweep amount — is not yet in the output. See [`docs/issues/issue-get-balance-wallet-context.md`](../issues/issue-get-balance-wallet-context.md).

Three commands, no human. The harness handles the schedule. Open Wallet Standard handles signing under whatever policy you set (per-day caps, allowlist of contracts, multi-sig requirement above a threshold). The CLI handles RPC, gas, simulation, and partial-failure safety.

To pull money back out (vendor payments, payroll-equivalent, redeploy):

```bash
npx @robotmoney/cli execute-withdraw --amount <USDC_amount>
```

That's the round trip.

---

## 5. Common questions

**Does the harness ever see private keys?** No. Keys live in OWS (Open Wallet Standard); the CLI talks to OWS via local IPC. Compromising the harness does not compromise the wallet. Set OWS policy (caps, allowlists, approval requirements) once, and every harness inherits it.

**What if my harness can't run shell commands?** MCP server mode (`npx @robotmoney/cli mcp`) is not yet implemented. Until it ships, any runtime that cannot exec a shell has no supported integration path. Track progress at [`docs/issues/issue-mcp-server-missing.md`](../issues/issue-mcp-server-missing.md).

**What if I'm running in multiple harnesses at once?** Fine. The CLI is stateless and the wallet is shared. Two harnesses cannot double-spend because OWS serializes signing. Use distinct OWS policies per harness if you want different spend caps per surface.

**How do I test before going live?** See `docs/technical/test-framework.md`. The short version: run against an Anvil fork of Base mainnet with a funded test wallet before pointing real revenue at this.

**Where do I get help?** Open an issue at https://github.com/robotmoney/robotmoney-skills/issues. The product is the CLI and the skill — there is no support team to email, because zero-human companies don't email support teams.
