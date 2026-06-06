# Agent Bootstrap

Paste the prompt below into a fresh session of your agent runtime, then come back to the Robot Money dapp once the agent prints its public address.

> **Environment reference:** for a full map of environment modes (local devnet, fork e2e, full-stack staging, mainnet read-only), startup commands, required env vars, and CI suites, see [`docs/development/environments.md`](docs/development/environments.md).

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

The Robot Money skill packages live under `plugins/` in this repo. Choose the block
for your runtime and run it verbatim — no manual config-file editing is needed.

There are two plugins:

- **`robotmoney-user`** — depositor agent: vault/gateway reads, deposit, and self-check.
  Install this unless you are setting up an investment-committee (analyst) agent.
- **`robotmoney-analyst`** — analyst agent: regime snapshot, governance reads, and
  proposal/vote stubs. Install this when setting up an investment-committee agent.

The blocks below install `robotmoney-user`. Replace every occurrence of
`robotmoney-user` with `robotmoney-analyst` in all commands and paths if you are
setting up an analyst agent.

### OpenCode

```bash
# From the repo root — registers the local plugin directory and writes the entry
# into .opencode/opencode.json in the current directory.
opencode plugin "file:./plugins/robotmoney-user"
```

`opencode plugin "file:<path>"` reads `plugins/robotmoney-user/package.json` and
the skill bundle under `skills/`, writes the plugin entry into the local
`.opencode/opencode.json`, and makes the skill available in the next OpenCode
session. The command exits 0 on success.

### Claude Code

```bash
# From the repo root — registers the plugin dir for this Claude Code session.
# For a persistent (user-scoped) install, append --scope user.
claude --plugin-dir ./plugins/robotmoney-user
```

Alternatively, to register once and persist across all future sessions:

```bash
claude plugin marketplace add . --sparse plugins/robotmoney-user --scope user
claude plugin install robotmoney-user --scope user
```

The `marketplace add` step reads `.claude-plugin/plugin.json` from the plugin
directory and registers this repo as a local marketplace. `plugin install` then
installs the named plugin. Both commands exit 0 on success.

### OpenClaw

```bash
# Set RMPC_BIN to the installed rmpc binary, then start the harness.
export RMPC_BIN="$(which rmpc)"
export RMPC_CONFIG=/etc/openclaw/rmpc.toml
export RMPC_NETWORK=fork
bash testing/openclaw-config/openclaw_harness.sh
```

OpenClaw invokes `rmpc` directly; there is no plugin install command. The
`RMPC_BIN` variable tells the harness where the binary lives. The skill's
`SKILL.md` (at `plugins/robotmoney-user/skills/robotmoney-user/SKILL.md`) is the
reference document for the session — point OpenClaw at that path if your harness
supports an explicit skill-file argument.

## 2.1 Verify the skill is callable (self-check)

Run the block for your runtime immediately after §2 completes. Exit code 0 means
the skill resolved and `rmpc` is reachable; non-zero means a step above failed.

```bash
# Works for all three runtimes — rmpc must be on PATH (§1).
# Substitute the correct config filename from §3.
rmpc --version
# Expected: prints "rmpc <version>" and exits 0.
# Non-zero exit or "command not found" → rmpc is not on PATH; recheck §1.
echo "rmpc on PATH: $?"
```

For Claude Code and OpenCode you can also verify skill resolution directly:

```bash
# Claude Code — confirm the skill is listed.
claude plugin list | grep robotmoney-user
# Exits 0 and prints the plugin name when installed; non-zero when absent.

# OpenCode — confirm the plugin appears in the loaded config.
grep -q "robotmoney-user" .opencode/opencode.json && echo "skill registered" || echo "MISSING: re-run §2 OpenCode block"
```

A runtime that completes §2 and passes the §2.1 checks is ready for §3.

## 3. Write the operator config

The config format depends on which chain you are targeting. Two profiles are
provided below. Use the one that matches your RPC endpoint.

### Profile A — Robot Money devnet (chain ID 918453)

The Robot Money devnet is a Geth+Lighthouse chain seeded from Base mainnet
state (chain ID **918453**). It uses the canonical Base USDC address (the
devnet genesis copies real Base contracts at their original addresses).
The default RPC for the hosted devnet is `https://robotmoney-dev-rpc.superfield.co`.

The gateway and vault are deployed fresh each time the devnet boots. After
running `cargo run -p smoke-test` (or your operator's deploy script), the
deployed addresses are written to `deployments/918453.json`. Read them out:

```bash
DEPLOY_JSON="deployments/918453.json"
GATEWAY=$(python3 -c "import json; d=json.load(open('$DEPLOY_JSON')); print(d['gateway'])")
VAULT=$(python3   -c "import json; d=json.load(open('$DEPLOY_JSON')); print(d['vault'])")
HASH=$(python3    -c "import json; d=json.load(open('$DEPLOY_JSON')); print(d['gateway_runtime_hash'])")
```

Then write `./rmpc-devnet.toml`:

```toml
# Robot Money devnet operator config.
# Chain: Geth+Lighthouse devnet forked from Base mainnet (chain ID 918453).
# Gateway and vault addresses are set after deployment — see BOOTSTRAP.md §3.

chain_id             = 918453
rpc_url              = "https://robotmoney-dev-rpc.superfield.co"  # hosted devnet RPC; replace with your operator's endpoint if needed
gateway_address      = "<GATEWAY from deployments/918453.json>"
usdc_address         = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"   # canonical Base USDC (same address on devnet)
vault_address        = "<VAULT from deployments/918453.json>"
gateway_runtime_hash = "<gateway_runtime_hash from deployments/918453.json>"
max_fee_per_gas_cap  = 100000000000

[signer]
allow_software_fallback = true
keystore_path           = "./keystore.json"
```

If your operator provides a different hosted devnet endpoint, replace
`rpc_url` with that URL and update `gateway_address`, `vault_address`, and
`gateway_runtime_hash` from the deployment manifest your operator supplies.

### Profile B — Base mainnet anvil fork (chain ID 8453)

For the read-only OpenCode walkthrough against a local anvil fork of Base
mainnet, use the template in `docs/development/opencode-readonly-fork.md`
§Step 3 instead. That profile hardcodes `chain_id = 8453` and uses placeholder
addresses intentionally — the walkthrough is read-only and expects degraded
(`partial: true`) responses.

### Common config notes

The config omits `state_dir` — add it to the config or set `RMPC_STATE_DIR`
in the environment, otherwise `rmpc` exits silently with code 3.

OpenClaw-only: place the config at `/etc/openclaw/rmpc.toml` instead, then
export `RMPC_CONFIG=/etc/openclaw/rmpc.toml` and `RMPC_NETWORK=fork`. Start
the bounded monitor with `bash testing/openclaw-config/openclaw_harness.sh`
and confirm it exits 0.

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

Update `keystore_path` in your config file (`rmpc-devnet.toml` for Profile A,
`rmpc-fork.toml` for Profile B) to point at the generated file.

Then run the self-check (substitute the correct config filename):

```bash
RMPC_KEYSTORE_PASSPHRASE="your-passphrase" \
  rmpc self-check --config ./rmpc-devnet.toml --pretty
```

If the startup succeeds you'll see a JSON envelope with an `agent_address` field — **copy it**, that is the agent's public address.

> `ok: false` and an `error` field (e.g. `ErrChainIdMismatch`, `ErrCodeHashMismatch`) are expected when the gateway/vault addresses in the config are placeholders. The signer backend is still ready — the presence of an `agent_address` proves the keystore decrypted and the backend initialized.

## 5. Hand the address back to the operator

Open the Robot Money dapp, paste the agent's public address into the "Authorize agent" panel, set the deposit caps, and submit the `grantAgentRole` transaction. Once the dapp confirms the on-chain state change, the agent is authorized.

## Demo ops: seed simulated depositors (issue #503)

The live demo at `robotmoney-dev-dapp.superfield.co` shows non-zero vault balances
only after the simulated-depositor seed has been run against the devnet. Run it once
after each devnet reboot (i.e. every time `make testnet` completes deployment):

```bash
# Read the deployed addresses from the smoke-test output or from the deployment JSON.
make demo-seed-depositors \
  RPC_URL=https://robotmoney-dev-rpc.superfield.co \
  DEPLOYER_KEY=0x<deployer-private-key> \
  USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  ROUTER_ADDRESS=0x<router-address-from-deployment> \
  REGISTRY_ADDRESS=0x<registry-address-from-deployment>
```

`DEPLOYER_KEY` must be the private key of an EOA that holds:
- At least `0.05 ETH × COUNT` for depositor gas (default 5 depositors → 0.25 ETH).
- At least `PER_USER_USDC × COUNT` USDC to fund depositor wallets (default 5 000 USDC).

On the smoke-test devnet the genesis-funded deployer EOA (`DEPLOYER_PRIVATE_KEY_HEX`
in `testing/smoke-test/src/lib.rs`) holds the ETH budget. The harness USDC holder
(`HARNESS_USDC_HOLDER_PRIVATE_KEY_HEX`) holds the USDC supply — pass whichever key
owns the faucet supply on your target devnet.

After seeding, verify that each Active vault reports non-zero `totalAssets`:

```bash
cast call --rpc-url $RPC_URL $ROUTER_ADDRESS "totalAssets()(uint256)"
# or use the REGISTRY_ADDRESS flag — the make target prints totalAssets per vault automatically.
```

The price strip (ETH/USD and three pool prices) works without MetaMask because the
dapp bundle now includes an HTTP fallback transport at `VITE_DEVNET_RPC_URL` for
devnet read calls. No additional ops step is needed for the price strip beyond
building the dapp with `VITE_DEVNET_RPC_URL` set to the public RPC endpoint.
