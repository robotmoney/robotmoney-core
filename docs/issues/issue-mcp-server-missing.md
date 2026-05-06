# Issue — No MCP server mode; OpenClaw edge-device story and all MCP-only runtimes are blocked

> Summary: PRD story §4.2 (OpenClaw on Raspberry Pi-class edge device) and PRD §5.5 both require `npx @robotmoney/cli mcp` to run the CLI as a long-lived MCP server. No `mcp` command is registered. `docs/support/harness-quickstart.md` also documents `npx @robotmoney/cli mcp` as the integration path for any runtime that "can't run shell commands." Any MCP-only agent harness — OpenClaw, Moltbook's MCP mode, or any third-party MCP client — has no working path to Robot Money today. The documentation tells operators to use a command that does not exist.

## 1. Severity

**High.** Story §4.2 depends on MCP mode entirely — the OpenClaw runtime on edge compute "never has to shell out" and connects exclusively via MCP. With no MCP server, that story is blocked from first line. The harness-quickstart also points three integration patterns at MCP mode; all three dead-end.

## 2. Background

PRD §5.5:
> "The CLI is also runnable as an MCP server for agent runtimes that prefer MCP over shell."

`docs/support/harness-quickstart.md` §2 (Generic/custom agent runtime):
> "run it as an MCP server: `npx @robotmoney/cli mcp`"

`docs/support/harness-quickstart.md` §5 (Common questions — "What if my harness can't run shell commands?"):
> "Run `@robotmoney/cli` as a long-lived MCP server (`npx @robotmoney/cli mcp`) and connect over MCP."

Story §4.2 explicitly:
> "OpenClaw connects to Robot Money via MCP — `npx @robotmoney/cli mcp` runs as a long-lived server on the device."

In all cases the operator expectation is: start the CLI once, keep it running, and have the agent harness call tools over the MCP protocol rather than spawning a new process per command. This is the standard pattern for constrained runtimes (edge devices, MCP-native platforms, runtimes without a shell or with high process-spawn overhead).

## 3. Evidence

`packages/cli/src/index.ts`: 12 commands registered (`health-check`, `get-vault`, `get-balance`, `get-apy`, `get-basket-holdings`, `prepare-deposit`, `prepare-redeem`, `prepare-withdraw`, `execute-deposit`, `execute-redeem`, `execute-withdraw`, `create-wallet`). No `mcp` command. No import of any MCP server library (`@modelcontextprotocol/sdk` or equivalent).

Running `npx @robotmoney/cli mcp` today outputs:
```
error: unknown command 'mcp'
```

## 4. User impact

| Context | Impact |
|---|---|
| §4.2 OpenClaw on edge device | Story completely blocked; no shell-out path exists in OpenClaw. |
| Any MCP-native runtime (Moltbook MCP mode, third-party) | No integration path; must fall back to shell, which may not be available. |
| Operators following `harness-quickstart.md` | Dead documentation; `mcp` command error on first attempt. |
| Claude Code + MCP (future) | Would benefit from MCP server mode for tighter tool integration without shell overhead. |

## 5. Proposed resolution

Add an `mcp` subcommand to `packages/cli/src/index.ts` that starts a long-lived MCP server. The server is a transport adapter over the existing command functions — no new business logic required.

**Architecture:**

```
npx @robotmoney/cli mcp [--transport stdio|http] [--port 3000]
  │
  ▼
MCP server (stdio default, HTTP optional)
  │  exposes each CLI command as one MCP tool
  ├─ tool: health_check     → healthCheck()
  ├─ tool: get_vault        → getVault()
  ├─ tool: get_balance      → getBalance()
  ├─ tool: get_apy          → getApy()
  ├─ tool: get_basket_holdings → getBasketHoldings()
  ├─ tool: get_allocation   → getAllocation()   (when implemented)
  ├─ tool: get_governance   → getGovernance()   (when implemented)
  ├─ tool: prepare_deposit  → prepareDeposit()
  ├─ tool: prepare_redeem   → prepareRedeem()
  ├─ tool: prepare_withdraw → prepareWithdraw()
  ├─ tool: execute_deposit  → executeDeposit()
  ├─ tool: execute_redeem   → executeRedeem()
  └─ tool: execute_withdraw → executeWithdraw()
```

Each tool's input schema is derived from the command's existing flag definitions in `index.ts`. Each tool's output is the same JSON the command already emits. The MCP tool `description` fields should be sourced from the reference files (`read.md`, `write.md`, `basket.md`) which already describe each command's purpose and schema in natural language.

**Recommended library:** `@modelcontextprotocol/sdk` (the official MCP TypeScript SDK). It handles stdio/HTTP transports, schema validation, and the MCP handshake.

**Skill update:** `SKILL.md` should document both integration modes (shell and MCP server) and note that in MCP mode the `--chain` flag becomes a server-start argument rather than a per-call argument.

## 6. Acceptance criteria

- `npx @robotmoney/cli mcp` starts without error and advertises all tools via the MCP `tools/list` response.
- Every existing command is accessible as an MCP tool with an input schema matching its flag surface.
- `stdio` transport works out of the box (default); `--transport http --port <n>` is optional.
- Story §4.2 can be reproduced end-to-end: OpenClaw (or any MCP client) connects, calls `execute_deposit`, receives the same JSON as the shell command.
- `harness-quickstart.md` MCP instructions remain accurate after the change.
- Unit test: start the MCP server in-process, call `health_check` via the MCP protocol, assert a valid response.
- No regressions to existing shell-based command tests.

## 7. Open questions

- **`create-wallet` via MCP.** The wallet-creation flow may involve interactive passphrase prompts that don't translate cleanly to MCP's request/response model. Should `create-wallet` be excluded from the MCP tool list initially, or should it accept passphrase as a required tool input?
- **`--chain` scope.** Currently `--chain` is a per-command flag. In MCP server mode it's more natural as a server-level config (set once at startup). Should MCP tools still accept `--chain` per-call for flexibility, or treat the server's chain as fixed?
- **Auth.** MCP over HTTP exposes the server to the local network. Should the HTTP transport require a bearer token or restrict to localhost only?
- **Process lifecycle.** On edge devices the MCP server should restart on crash. Is that the harness's responsibility (systemd, OpenClaw process supervisor), or should the CLI implement a watchdog?

## 8. References

- PRD requirement: [`../prd.md`](../prd.md) §5.5
- Harness quickstart (dead docs): [`../support/harness-quickstart.md`](../support/harness-quickstart.md) §2, §5
- CLI entry point: [`../../packages/cli/src/index.ts`](../../packages/cli/src/index.ts)
- Story: [`../prd.md`](../prd.md) §4.2
