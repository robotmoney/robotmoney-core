# Agent Bootstrap Prompts

Paste the paragraph for your agent runtime into a new session. The agent will download the `rmpc` binary, load the Robot Money skill, write an operator config, and tell you when it needs you to open the dapp to authorize the signing key.

## OpenCode

> Download the latest `rmpc` release binary for this platform from `https://github.com/lucky-tensor/robotmoney-skills/releases/latest` and place it on `PATH`. Then load the Robot Money skill package by running `opencode --plugin /path/to/robotmoney-skills/plugins/robotmoney-cli`. Once the plugin is loaded, write a fork-default operator config at `./rmpc-fork.toml` using the template in `docs/walkthroughs/opencode-readonly-fork.md` §Step 3, substituting the real gateway and vault addresses if you have them. Run `rmpc self-check --config ./rmpc-fork.toml --pretty` to confirm the signer backend is reachable. Finally, open the Robot Money dapp, paste the agent's public address into the "Authorize agent" panel, set the deposit caps, and submit the `grantAgentRole` transaction — come back here once the dapp confirms the on-chain state change.

## OpenClaw

> Download the latest `rmpc` release binary for this platform from `https://github.com/lucky-tensor/robotmoney-skills/releases/latest` and install it at the path referenced by `RMPC_BIN` (or place it system-wide so the default harness path resolves). Write an operator config at `/etc/openclaw/rmpc.toml` using the template in `docs/walkthroughs/openclaw-config.md` §2, then export `RMPC_CONFIG=/etc/openclaw/rmpc.toml` and `RMPC_NETWORK=fork`. Start the bounded monitor with `bash testing/openclaw-config/openclaw_harness.sh` and confirm it exits 0 after the configured iterations. Once the monitor is green, open the Robot Money dapp, paste the agent's public address into the "Authorize agent" panel, set the deposit caps, and submit the `grantAgentRole` transaction — the harness will pick up the new policy on its next poll cycle.

## Claude Code

> Download the latest `rmpc` release binary for this platform from `https://github.com/lucky-tensor/robotmoney-skills/releases/latest` and place it on `PATH`. From your checkout of this repo, register the skill package with Claude Code by adding `plugins/robotmoney-cli` as a plugin (the skill files are already present at that path — no separate clone needed). Write a fork-default operator config at `./rmpc-fork.toml` using the template in `docs/walkthroughs/opencode-readonly-fork.md` §Step 3. Run `rmpc self-check --config ./rmpc-fork.toml --pretty` and confirm the signer backend reports ready. When you are satisfied the reads are working, open the Robot Money dapp, paste the agent's public address into the "Authorize agent" panel, set the deposit caps, and submit the `grantAgentRole` transaction — return here once the dapp confirms the authorization is on-chain.
