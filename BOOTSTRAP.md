# Agent Bootstrap

Paste the prompt below into a fresh session of your agent runtime, then come back to the Robot Money dapp once the agent prints its public address.

> Agent, install Robot Money per the instructions in this file.

The agent should perform all of the steps below itself. Vendor-specific nuances are called out inline.

### Before you start — set the keystore passphrase

`rmpc` needs a passphrase to decrypt the agent's keystore (created in step 4). The human operator must export it once in their terminal **before** launching the agent runtime so the agent process inherits it:

```bash
read -s -p "Agent keystore passphrase: " RMPC_KEYSTORE_PASSPHRASE
export RMPC_KEYSTORE_PASSPHRASE
```

This uses `read -s` so the passphrase is never echoed, never written to shell history, and never appears on the command line. The agent inherits `RMPC_KEYSTORE_PASSPHRASE` from the process environment automatically.

## 1. Install `rmpc`

Either install a release binary or build from source — both are supported.

**Option A — release binary (preferred):** Download the latest `rmpc` for your platform from <https://github.com/lucky-tensor/robotmoney-monorepo/releases/latest> and place it on `PATH`. Verify with `rmpc --version`.

> **Known issue:** the release binary may exit silently with exit code 3 on some systems (no stdout, stderr, or log output). If `rmpc --help` works but any subcommand exits 3 with no output, build from source instead (Option B).

**Option B — build from source (recommended if release binary fails):** Clone <https://github.com/lucky-tensor/robotmoney-skills>, then:

```bash
cargo build -p rust-payment-client --release
cp target/release/rmpc ~/.local/bin/
rmpc --version
```

## 2. Register the Robot Money skill with your agent runtime

The plugin lives at `plugins/robotmoney-cli/` in the repo. Register it the way your runtime expects:

- **OpenCode:** the skill is a SKILL.md + references bundle loaded via the Skill tool. Clone the repo so the agent can read `plugins/robotmoney-cli/skills/robotmoney-cli/SKILL.md` and its `references/` directory. No plugin registration command is needed — the agent references the skill files directly.
- **Claude Code:** add `plugins/robotmoney-cli` as a plugin in your Claude Code config (no separate clone needed if you already built from source).
- **OpenClaw:** set `RMPC_BIN` to the installed `rmpc` path so the default harness resolves it; the plugin is not loaded the same way — the harness invokes `rmpc` directly.

## 3. Write the operator config

Write a fork-default operator config at `./rmpc-fork.toml` using the template in `docs/walkthroughs/opencode-readonly-fork.md` §Step 3, substituting the real gateway and vault addresses if you have them.

The template omits `state_dir` — add it to the config or set `RMPC_STATE_DIR` in the environment, otherwise `rmpc` exits silently with code 3.

The template also hardcodes `chain_id = 8453` (Base mainnet). If your RPC endpoint uses a different chain, discover the real id before running self-check:

```bash
curl -s <YOUR_RPC_URL> -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | \
  python3 -c "import json,sys; print(int(json.load(sys.stdin)['result'], 16))"
```

Update `chain_id` in `rmpc-fork.toml` with the result.

OpenClaw-only: place the config at `/etc/openclaw/rmpc.toml` instead, then export `RMPC_CONFIG=/etc/openclaw/rmpc.toml` and `RMPC_NETWORK=fork`. Start the bounded monitor with `bash testing/openclaw-config/openclaw_harness.sh` and confirm it exits 0.

## 4. Create a keystore and run self-check

If you don't have a key pair yet, create one:

```bash
# Generate a random private key
openssl rand -hex 32 > /tmp/rmpc-privkey.txt

# Import it into a keystore (creates the file at the given path)
RMPC_KEYSTORE_PASSPHRASE="your-passphrase" \
  RMPC_IMPORT_PRIVKEY_HEX="$(cat /tmp/rmpc-privkey.txt)" \
  rmpc-keystore-import /path/to/keystore.json
```

Update `keystore_path` in `rmpc-fork.toml` to point at the generated file.

Then run the self-check:

```bash
RMPC_KEYSTORE_PASSPHRASE="your-passphrase" \
  rmpc self-check --config ./rmpc-fork.toml --pretty
```

If the startup succeeds you'll see a JSON envelope with an `agent_address` field — **copy it**, that is the agent's public address.

> `ok: false` and an `error` field (e.g. `ErrChainIdMismatch`, `ErrCodeHashMismatch`) are expected when the gateway/vault addresses in the config are placeholders. The signer backend is still ready — the presence of an `agent_address` proves the keystore decrypted and the backend initialized.

## 5. Hand the address back to the operator

Open the Robot Money dapp, paste the agent's public address into the "Authorize agent" panel, set the deposit caps, and submit the `grantAgentRole` transaction. Once the dapp confirms the on-chain state change, the agent is authorized.
