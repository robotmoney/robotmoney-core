# Issue — Passphrase resolution falls through to interactive TTY prompt; headless deployments hang indefinitely

> Summary: `lib/wallet.ts` `resolvePassphrase()` has a three-step resolution ladder: `--passphrase` flag → `OWS_PASSPHRASE` env var → interactive TTY prompt. In non-interactive environments — CI pipelines, cron jobs, headless harnesses (Moltbook, OpenClaw, any autonomous deployment) — the TTY prompt hangs indefinitely with no timeout, no error, and no output. The process must be killed externally. There is no warning in the CLI, SKILL.md, or harness-quickstart that the third rung of the ladder is silent-hang behaviour in non-interactive contexts.

## 1. Severity

**High for autonomous deployments.** This is a silent availability failure: the harness appears to hang at `execute-deposit` with no JSON output, no stderr error, no exit code. Monitoring systems see a stuck process rather than a failed command. For story §4.2 (OpenClaw on an edge device) this could wedge the agent loop permanently until the device is rebooted.

## 2. Background

Story §4.1 (Moltbook) mentions `OWS_PASSPHRASE` env var as the resolution path and implies operators will set it. Story §4.2 (OpenClaw) uses `--wallet device` but does not mention how the passphrase is supplied; given the edge-device context, interactive TTY is not available.

The harness-quickstart §2 says:

> "**Passphrase:** pass via `--passphrase <string>`, `OWS_PASSPHRASE` env var, or leave empty and the CLI will prompt interactively."

"Leave empty and the CLI will prompt interactively" is only safe for human-operated sessions. For automated deployments, "leave empty" means "hang until killed."

`lib/wallet.ts` `resolvePassphrase`:

```typescript
export async function resolvePassphrase(opts: { passphrase?: string }): Promise<string> {
  if (opts.passphrase !== undefined) return opts.passphrase;
  const env = process.env.OWS_PASSPHRASE;
  if (env !== undefined && env.length > 0) return env;
  // Interactive prompt — blocks until input
  return prompt('Enter OWS passphrase: ');
}
```

No TTY detection. No timeout. No warning.

## 3. Evidence

`packages/cli/src/lib/wallet.ts` `resolvePassphrase`: falls through to an interactive prompt with no guard.

`packages/cli/src/index.ts`: all `execute-*` commands and `create-wallet` accept `--passphrase` as an option but do not mark it required. Commander does not enforce supply.

`plugins/robotmoney-cli/skills/robotmoney-cli/SKILL.md`: does not mention passphrase resolution or warn that automated use requires `--passphrase` or `OWS_PASSPHRASE`.

## 4. Proposed resolution

**4.1 Detect non-interactive context and fail fast**

Before falling through to the TTY prompt, check whether stdin is a TTY:

```typescript
import { isTTY } from './tty.js';

if (!isTTY()) {
  throw new Error(
    'No passphrase supplied and stdin is not a TTY. ' +
    'Provide --passphrase <string> or set OWS_PASSPHRASE env var.'
  );
}
// safe to prompt
return prompt('Enter OWS passphrase: ');
```

`process.stdin.isTTY` is `true` in interactive terminals and `undefined`/`false` in pipes, cron, and MCP contexts. A hard error with a clear message is far better than a silent hang.

**4.2 SKILL.md and harness-quickstart update**

Add a warning to both documents:

> **Automated deployments must supply a passphrase.** Use `--passphrase <string>` (not recommended — visible in process list) or `OWS_PASSPHRASE` env var (recommended). If neither is set in a non-interactive context, `execute-*` will exit with an error rather than hang.

**4.3 `create-wallet` passphrase note**

`create-wallet`'s post-creation instructions should include:

> "Set `OWS_PASSPHRASE` in your harness's environment before scheduling any `execute-*` commands."

## 5. Acceptance criteria

- In a non-TTY context (e.g. piped stdin, `</dev/null`), `execute-deposit` exits non-zero with a JSON error `{ code: "PASSPHRASE_REQUIRED", error: "..." }` rather than hanging.
- In an interactive TTY context, the existing prompt behaviour is unchanged.
- `SKILL.md` documents the `OWS_PASSPHRASE` env var as the required pattern for autonomous deployments.
- `harness-quickstart.md` §2 is updated to make the non-interactive failure mode explicit.
- Unit test: mock `process.stdin.isTTY = false` and assert the command exits with `PASSPHRASE_REQUIRED` error.

## 6. Open questions

- **`--allow-interactive` escape hatch.** Should there be an explicit flag to permit interactive prompts even in a non-TTY-looking environment (e.g. some CI systems report no TTY but are attended)? Or should the detection be: "no passphrase supplied + no TTY → error", always? The latter is simpler and safer.
- **Passphrase security in env var.** `OWS_PASSPHRASE` in an env var is visible to any process that can read the environment (e.g. `ps auxe`, `/proc/<pid>/environ`). For production deployments this should be noted as a security consideration — a secrets manager (Vault, AWS Secrets Manager, OWS's own secure config) is preferable. Document in SKILL.md but don't block the fix on solving this.

## 7. References

- Passphrase resolution: [`../../packages/cli/src/lib/wallet.ts`](../../packages/cli/src/lib/wallet.ts) `resolvePassphrase`
- Harness quickstart (misleading guidance): [`../support/harness-quickstart.md`](../support/harness-quickstart.md)
- PRD stories: [`../prd.md`](../prd.md) §4.1, §4.2
- Data sources analysis: [`data-sources.md`](data-sources.md) §3.3
