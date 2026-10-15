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

**Option A — release binary (preferred):** Install it with this repo's verified
recipe, `scripts/release/install-rmpc.sh`. It applies two checks, in this order,
and only then extracts and installs:

1. **Checksum** (issue #1204). It downloads the release archive *and* its
   published `.sha256`, checks that the checksum file is a single line naming
   *that* archive, hashes the archive itself and compares.
2. **Build provenance** (issue #1236). It runs `gh attestation verify` over the
   archive, pinned to this repository, to
   `.github/workflows/release-rmpc.yml` as the signing workflow, to the source
   ref `refs/tags/<tag>` of the tag you install, and to the `push` trigger. Only
   an org admin can create an `rmpc-v*` tag, and only that tag push attests, so
   an attestation a repository writer mints by dispatching the workflow on a
   branch is refused. `--tag` must be `rmpc-vX.Y.Z`.

A checksum mismatch, a checksum file covering some other file, or an attestation
that does not verify aborts before extraction, so an archive that fails either
check never reaches `PATH`. Do not fetch the tarball and unpack the binary
yourself: step 4 below creates a **signing keystore** with whatever binary you
installed here.

**Prerequisites:** `curl`, `tar`, `sha256sum` (or `shasum`), and the
[GitHub CLI](https://cli.github.com) `gh` ≥ 2.49. `gh` is **required**, not
optional — the installer refuses to run without it rather than installing a
binary whose provenance it could not check. If `gh` reports an authentication or
rate-limit problem, run `gh auth login` and retry.

> **What these checks do and do not prove.** The `.sha256` shares a trust root
> with the archive: same release, same host, same TLS session, and whoever can
> write the release can write both. On its own it *detects* a corrupted,
> truncated or substituted **download** — a mirror, proxy or cache serving bytes
> the release does not hold — and nothing more. The **attestation** is the check
> with a different trust root. It is a Sigstore signature over the archive's
> digest, made with an OIDC identity that GitHub issues only to an Actions run in
> this repository, so a leaked `contents: write` token, a stolen `GITHUB_TOKEN`,
> or a maintainer account used to swap release assets **cannot** produce one.
>
> Repository write is not enough either: a writer can dispatch the release
> workflow on a branch, but that run never attests, and an attestation from any
> run other than the push of the installed `rmpc-v*` tag fails the source-ref
> and trigger pins.
>
> What it does **not** prove is that the code was reviewed. Provenance answers
> "this archive came out of that workflow for that admin-pushed tag", not "the
> commit it was built from was any good": the admin who pushes the tag vouches
> for the commit. Read `attested` as *built by this repo's release workflow from
> the tagged commit*, never as *reviewed*.

```bash
# From the repo root. rmpc releases are tagged `rmpc-vX.Y.Z`; the dApp publishes
# into its own `vX.Y.Z` namespace (issue #1243), so `releases/latest` is NOT
# usable here — a dApp release would win that race and the installer would
# correctly fail with exit 3 looking for an rmpc archive that release does not
# hold. Select the newest rmpc release explicitly:
TAG=$(curl -fsSL https://api.github.com/repos/robotmoney/robotmoney-core/releases \
      | grep -o '"tag_name": *"rmpc-v[^"]*"' | head -1 | cut -d'"' -f4)
./scripts/release/install-rmpc.sh --tag "$TAG" --dest ~/.local/bin
rmpc --version
```

The script exits `4` if the archive does not match its published checksum
(printing `ChecksumMismatch`), if the release publishes no checksum at all, or if
the published checksum file does not name this archive — the last case being the
one where a hostile mirror serves a real digest for some *other* file so the
verification would otherwise pass. It exits `6` (`NotAttested`) if the archive
has no build-provenance attestation that verifies against this repository and its
release workflow. It exits `2` if `gh` is not installed. In every case nothing is
extracted and nothing is installed.

> **Releases published before these checks existed:** `release-rmpc.yml` only
> began emitting `<archive>.tar.gz.sha256` in #1204 and only began attesting
> build provenance in #1236. Every release up to and including `v0.3.3` — the
> last rmpc release cut under the old shared `vX.Y.Z` tag namespace — ships
> archives with no checksum beside them, and the installer refuses a bare
> `vX.Y.Z` tag outright (exit `2`). `rmpc-v0.3.4` was cut by dispatching the
> workflow from `dev`, so its attestation names `refs/heads/dev` and the
> `workflow_dispatch` trigger, and the installer refuses it with exit `6`. That
> is the script working, not failing. Until a release cut by pushing its
> `rmpc-v*` tag exists, use **Option B** and build from source.
> Do **not** answer either exit code by downloading the tarball by hand — that is
> precisely the unverified path this replaced.

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

The gateway is an ERC-1967 proxy (ADR-0014), so `gateway_runtime_hash` pins
only the proxy's own code, which an upgrade never changes. rmpc also needs the
code hash of the implementation behind it, or every write refuses with
`ErrImplementationNotApproved` (preflight check 2b). Read it from the chain:

```bash
RPC="https://robotmoney-dev-rpc.superfield.co"
IMPL_SLOT=0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc   # ERC-1967 implementation slot
IMPL=$(cast parse-bytes32-address "$(cast storage "$GATEWAY" "$IMPL_SLOT" --rpc-url "$RPC")")
IMPL_HASH=$(cast keccak "$(cast code "$IMPL" --rpc-url "$RPC")")
```

The stage manifest `gateway.json` records the same value as
`gateway_implementation_runtime_hash`. If `IMPL` is the zero address the
gateway is a direct deployment: leave `gateway_implementation_hashes` out,
because rmpc refuses a pin for a direct gateway.

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
gateway_implementation_hashes = ["<IMPL_HASH>"]   # approved gateway implementation(s); add the next one before its upgrade executes
proxy_implementation_hashes   = ["<VAULT_IMPL_HASH>"]   # approved vault (and router) implementation(s), the same way
max_fee_per_gas_cap  = 100000000000

[signer]
allow_software_fallback = true
keystore_path           = "./keystore.json"
```

If your operator provides a different hosted devnet endpoint, replace
`rpc_url` with that URL and update `gateway_address`, `vault_address`,
`gateway_runtime_hash` and `gateway_implementation_hashes` from the deployment
your operator supplies. `rmpc get-gateway --config ./rmpc-devnet.toml` prints
the live implementation, its code hash and whether the config approves it.
When the operator announces a gateway upgrade, add the new implementation's
hash to `gateway_implementation_hashes` before the timelock executes it, keep
the old one until it has executed, then drop the old one
(`docs/operations/contract-release-runbooks.md` §4.12).

The vault is a proxy too. `VAULT_IMPL_HASH` is
`cast keccak "$(cast code "$(cast implementation "$VAULT" --rpc-url "$RPC")" --rpc-url "$RPC")"`.
A deposit, a withdraw and the router commands refuse with
`ErrImplementationNotApproved` naming the vault or router until its
implementation's code hash is in `proxy_implementation_hashes`. The smoke-test
deploy output prints both keys (`gateway_implementation_hash`,
`proxy_implementation_hashes`).

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
