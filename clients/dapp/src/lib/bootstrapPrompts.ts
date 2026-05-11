/**
 * Canonical source: /BOOTSTRAP.md at the repo root.
 *
 * Inlined here because Vite's filesystem boundary does not extend outside
 * `clients/dapp`. Keep these strings in sync with BOOTSTRAP.md — the
 * onboarding wizard renders one of them as the agent-bootstrap copy buffer.
 */

export type AgentRuntime = "opencode" | "openclaw" | "claude-code";

export interface BootstrapPrompt {
  readonly id: AgentRuntime;
  readonly label: string;
  readonly prompt: string;
}

export const BOOTSTRAP_PROMPTS: ReadonlyArray<BootstrapPrompt> = [
  {
    id: "opencode",
    label: "OpenCode",
    prompt:
      'Download the latest `rmpc` release binary for this platform from `https://github.com/lucky-tensor/robotmoney-skills/releases/latest` and place it on `PATH`. Then load the Robot Money skill package by running `opencode --plugin /path/to/robotmoney-skills/plugins/robotmoney-cli`. Once the plugin is loaded, write a fork-default operator config at `./rmpc-fork.toml` using the template in `docs/walkthroughs/opencode-readonly-fork.md` §Step 3, substituting the real gateway and vault addresses if you have them. Run `rmpc self-check --config ./rmpc-fork.toml --pretty` to confirm the signer backend is reachable. Finally, open the Robot Money dapp, paste the agent\'s public address into the "Authorize agent" panel, set the deposit caps, and submit the `grantAgentRole` transaction — come back here once the dapp confirms the on-chain state change.',
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    prompt:
      'Download the latest `rmpc` release binary for this platform from `https://github.com/lucky-tensor/robotmoney-skills/releases/latest` and install it at the path referenced by `RMPC_BIN` (or place it system-wide so the default harness path resolves). Write an operator config at `/etc/openclaw/rmpc.toml` using the template in `docs/walkthroughs/openclaw-config.md` §2, then export `RMPC_CONFIG=/etc/openclaw/rmpc.toml` and `RMPC_NETWORK=fork`. Start the bounded monitor with `bash testing/openclaw-config/openclaw_harness.sh` and confirm it exits 0 after the configured iterations. Once the monitor is green, open the Robot Money dapp, paste the agent\'s public address into the "Authorize agent" panel, set the deposit caps, and submit the `grantAgentRole` transaction — the harness will pick up the new policy on its next poll cycle.',
  },
  {
    id: "claude-code",
    label: "Claude Code",
    prompt:
      'Download the latest `rmpc` release binary for this platform from `https://github.com/lucky-tensor/robotmoney-skills/releases/latest` and place it on `PATH`. From your checkout of this repo, register the skill package with Claude Code by adding `plugins/robotmoney-cli` as a plugin (the skill files are already present at that path — no separate clone needed). Write a fork-default operator config at `./rmpc-fork.toml` using the template in `docs/walkthroughs/opencode-readonly-fork.md` §Step 3. Run `rmpc self-check --config ./rmpc-fork.toml --pretty` and confirm the signer backend reports ready. When you are satisfied the reads are working, open the Robot Money dapp, paste the agent\'s public address into the "Authorize agent" panel, set the deposit caps, and submit the `grantAgentRole` transaction — return here once the dapp confirms the authorization is on-chain.',
  },
];
