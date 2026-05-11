# Agent Bootstrap

Paste the prompt below into a fresh session of your agent runtime, then come back to the Robot Money dapp once the agent prints its public address.

> Agent, install Robot Money per the instructions in this file.

The agent should perform all of the steps below itself. Vendor-specific nuances are called out inline.

## 1. Install `rmpc`

Either install a release binary or build from source — both are supported.

**Option A — release binary (preferred):** Download the latest `rmpc` for your platform from <https://github.com/lucky-tensor/robotmoney-skills/releases/latest> and place it on `PATH`. Verify with `rmpc --version`.

**Option B — build from source:** Clone <https://github.com/lucky-tensor/robotmoney-skills>, then `cargo build -p rmpc --release` and copy `target/release/rmpc` onto `PATH`.

## 2. Register the Robot Money skill with your agent runtime

The plugin lives at `plugins/robotmoney-cli/` in the repo. Register it the way your runtime expects:

- **OpenCode:** `opencode --plugin /path/to/robotmoney-skills/plugins/robotmoney-cli`
- **Claude Code:** add `plugins/robotmoney-cli` as a plugin in your Claude Code config (no separate clone needed if you already built from source).
- **OpenClaw:** set `RMPC_BIN` to the installed `rmpc` path so the default harness resolves it; the plugin is not loaded the same way — the harness invokes `rmpc` directly.

## 3. Write the operator config

Write a fork-default operator config at `./rmpc-fork.toml` using the template in `docs/walkthroughs/opencode-readonly-fork.md` §Step 3, substituting the real gateway and vault addresses if you have them.

OpenClaw-only: place the config at `/etc/openclaw/rmpc.toml` instead, then export `RMPC_CONFIG=/etc/openclaw/rmpc.toml` and `RMPC_NETWORK=fork`. Start the bounded monitor with `bash testing/openclaw-config/openclaw_harness.sh` and confirm it exits 0.

## 4. Self-check

Run `rmpc self-check --config ./rmpc-fork.toml --pretty` (or with your OpenClaw config path) and confirm the signer backend reports ready. The output includes the agent's **public address** — copy it.

## 5. Hand the address back to the operator

Open the Robot Money dapp, paste the agent's public address into the "Authorize agent" panel, set the deposit caps, and submit the `grantAgentRole` transaction. Once the dapp confirms the on-chain state change, the agent is authorized.
