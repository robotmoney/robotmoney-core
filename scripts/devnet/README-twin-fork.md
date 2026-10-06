# Twin fork tool (core issues 1498, 1496)

The Twin chain (chain id 918453) is a pinned lazy fork of real Base state made with anvil. There is no warm list, no state dump, no patched state and no genesis snapshot. Tests deploy their own vault through our deploy scripts and read addresses from the manifests. No test reads the live v1 vault, its adapters, the old admin Safe or any hard-coded Robot Money address (clean room rule).

Environment steps that may differ from production: fund gas, fund USDC, warp time. Nothing else.

## Usage

```
bun scripts/devnet/twin-fork.ts start [--port 8545] [--host 127.0.0.1] [--block-time SECS] [--chain-id 918453] [--upstream URL]
    [--pin-block N|auto] [--cache-dir DIR] [--pin-file pin.json] [--state-dir DIR]
    [--repin-on-stale | --no-repin-on-stale] [--stop-timeout 90000] [--retries 10] [--fork-retry-backoff 1000] [--compute-units-per-second 50]
bun scripts/devnet/twin-fork.ts wait-ready [--pin-block N]
bun scripts/devnet/twin-fork.ts status
bun scripts/devnet/twin-fork.ts fund-gas  <address> <eth>
bun scripts/devnet/twin-fork.ts fund-usdc <address> <usdc base units>   # 5000000 = 5 USDC
bun scripts/devnet/twin-fork.ts warp <seconds>                          # refuses on chain id 8453
bun scripts/devnet/twin-fork.ts stop
```

Use the same `--port` and `--state-dir` for every command of one instance. `fund-gas`, `fund-usdc`, `warp`, `status` and `wait-ready` talk to `--rpc-url` (or the env `TWIN_RPC_URL`) when given, so they can drive a fork this tool did not start. `start` and `stop` always use the local port. The state dir holds the pid file and the anvil log (default `$TMPDIR/twin-fork-<port>`).

`fund-usdc` writes the real FiatToken `balanceAndBlacklistStates[holder]` slot (mapping at storage slot 9, key `keccak256(pad32(holder) ++ pad32(9))`, balance in the low 255 bits) with `anvil_setStorageAt`, then checks `balanceOf`. Total supply is not changed. `warp` uses `evm_increaseTime` then `evm_mine`. This is how the 48h governance waits run.

## Pinning

`--pin-block auto` reads the upstream head with `eth_blockNumber` (with retry) and pins head minus 2 (reorg safety). `--pin-file` receives `{block, hash, timestamp, upstreamHost}`. The host is written, never the URL. Every job of one CI run must use the same pin.

## Stale pin

A non-archive upstream stops serving the state of an old block. `start` probes the pinned block (`eth_getBalance` at the pin). If the upstream answers "missing trie node" or similar, and also if anvil dies with that error, `start --repin-on-stale` prints a loud `WARN: STALE PIN` line, re-pins to head minus 2 and rewrites `--pin-file` with the new block. It is on by default when `CI` or `GITHUB_ACTIONS` is set and off locally (a stale pin is then an error). `--no-repin-on-stale` forces it off. A re-pin means jobs of the same run may not share a block, so treat the WARN as a signal to rerun the whole run.

## Caching

Anvil keeps its fork RPC cache in `$HOME/.foundry/cache/rpc/<chain>/<block>/`. `--cache-dir DIR` runs anvil with `HOME=DIR`, so the cache lives in `DIR/.foundry/cache/rpc`. CI persists `DIR` with actions/cache keyed by the pin block. A cache hit means no upstream calls for state already read. Anvil writes the cache only when it exits, so `stop` sends SIGTERM and waits (`--stop-timeout`, default 90 s) before it would SIGKILL. The `twin-fork` action only restores the cache. The `twin-fork-save-cache` action stops the fork and then runs `actions/cache/save` keyed by the pin block.

## Rate limits and the upstream

The default upstream is `https://mainnet.base.org` (no key, no archive node, rate limited). Anvil retries (`--retries`, `--fork-retry-backoff`, `--compute-units-per-second`) and the tool retries start up to `--start-attempts` times, with backoff on HTTP 429. Lower `--compute-units-per-second` if you still see 429.

For a paid provider set the env `BASE_UPSTREAM_RPC` (a secret; the actions use their `upstream-secret` input, or an already-set `BASE_UPSTREAM_RPC` env when the input is empty, and never print it; set in the GitHub Environment or the credential doctor vault, see the devops credential doctor runbook). The tool logs only the host. Anvil takes the URL as a command-line argument, so on a shared host it is visible in `ps` to local users. Use a dedicated host or accept that exposure. The pinned block must still be recent enough for the provider (a non-archive node serves only recent blocks, so start soon after choosing a pin).

## Stage hosts (service)

systemd unit (text), keeps the tool-managed fork alive. Secrets go in `/etc/twin-fork.env` (mode 0600, `BASE_UPSTREAM_RPC=...`), never in the unit:

```
[Unit]
Description=Twin chain (pinned lazy Base fork)
After=network-online.target
[Service]
User=twin
EnvironmentFile=-/etc/twin-fork.env
ExecStart=/usr/local/bin/bun /opt/robotmoney-core/scripts/devnet/twin-fork.ts start --port 8545 --host 0.0.0.0 --block-time 1 --cache-dir /var/lib/twin-fork --state-dir /var/lib/twin-fork/state --pin-file /var/lib/twin-fork/pin.json
ExecStop=/usr/local/bin/bun /opt/robotmoney-core/scripts/devnet/twin-fork.ts stop --port 8545 --state-dir /var/lib/twin-fork/state
Type=oneshot
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
```

`--host 0.0.0.0` lets the dapp stack containers on the host reach the fork, and `--block-time 1` keeps the tip moving for the explorer-indexer (its safe head is tip minus 5). Drop both for a fork that nothing but loopback tests use. The harness and `scripts/stage/core-stack.ts` reuse this service when `TWIN_RPC_URL` names it.

`start` returns once anvil is ready and anvil runs detached, so the unit is `oneshot` with `RemainAfterExit` (no automatic restart on a crash). For restart on failure, run anvil in the foreground instead with the exact argv the tool prints (`anvil --fork-url ... --fork-block-number N --chain-id 918453 ...`).

Docker one-liner (text). Pin a block first, for example N from `pin.json`:

```
docker run -d --name twin -p 127.0.0.1:8545:8545 ghcr.io/foundry-rs/foundry:stable anvil --host 0.0.0.0 --fork-url https://mainnet.base.org --fork-block-number N --chain-id 918453 --retries 10 --fork-retry-backoff 1000 --compute-units-per-second 50 --quiet
```

## CI: choose the pin once per workflow run

```yaml
jobs:
  pin:
    runs-on: ubuntu-latest
    outputs:
      block: ${{ steps.pin.outputs.block }}
    steps:
      - uses: actions/checkout@v4
      - id: pin
        uses: ./.github/actions/twin-pin        # an optional pin-block input hands a parent's pin through unchanged
        with:
          upstream-secret: ${{ secrets.BASE_UPSTREAM_RPC }}   # optional
  chain-test:
    needs: pin
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - id: twin
        uses: ./.github/actions/twin-fork
        with:
          pin-block: ${{ needs.pin.outputs.block }}
          upstream-secret: ${{ secrets.BASE_UPSTREAM_RPC }}
          # host: "0.0.0.0" and block-time: "1" when a docker container (the indexer) must reach the fork
      - run: echo "Twin at $TWIN_RPC_URL pinned at ${{ steps.twin.outputs.pin-block }}"
      # ... the job's real steps ...
      - name: Stop the Twin fork and save its RPC cache
        if: always()
        uses: ./.github/actions/twin-fork-save-cache      # LAST step of EVERY job that uses twin-fork
```

### Action interface

`twin-fork` inputs: `pin-block`, `upstream-secret`, `port`, `host`, `block-time`. Outputs (both naming styles, same values):

| Output | Alias | Value |
| --- | --- | --- |
| `rpc-url` | `TWIN_RPC_URL` | `http://127.0.0.1:<port>` |
| `pin-block` | `PIN_BLOCK` | the block the fork serves (after any re-pin) |

The action also exports env `TWIN_RPC_URL`, `TWIN_PIN_BLOCK` and `TWIN_CACHE_DIR` for later steps of its own job. `twin-pin` outputs `block`. `twin-fork-save-cache` takes no inputs and has no outputs, it reads the pin file the fork wrote.

The upstream is the `upstream-secret` input, or the `BASE_UPSTREAM_RPC` env when the input is empty. It is never echoed.

Enforced by `scripts/devnet/check-twin-chain-ci-selftest.ts`: every `twin-fork` use has a matching `twin-fork-save-cache` last step with `if: always()`, one pin expression per workflow, the output names above, and `github.action_path` in all three actions.

### From another repo

Check core out and use the actions from the checkout. The actions locate `scripts/devnet` through `github.action_path`, so core need not be the workspace root:

```yaml
      - uses: actions/checkout@v4
        with: { repository: robotmoney/robotmoney-core, path: core }
      - id: pin
        uses: ./core/.github/actions/twin-pin
      - id: twin
        uses: ./core/.github/actions/twin-fork
        with: { pin-block: "${{ steps.pin.outputs.block }}" }
      - run: echo "$TWIN_RPC_URL ${{ steps.twin.outputs.PIN_BLOCK }}"
      - if: always()
        uses: ./core/.github/actions/twin-fork-save-cache
```

The composite action installs foundry and bun, restores the cache keyed `twin-anvil-rpc-<pin>`, starts the tool, waits until `eth_chainId` is 918453 and `eth_blockNumber` is the pin (or later, for a fork that mines on a timer).

## Rust harness

`testing/smoke-test` (`src/twin_fork.rs`) is the Rust side. `Fixture::new()` reuses the fork named by `TWIN_RPC_URL`, or runs `twin-fork.ts start` (host `0.0.0.0`, block time 1, pin from `TWIN_PIN_BLOCK` or auto, cache from `TWIN_CACHE_DIR`) and stops it on drop. It funds keys with `fund-gas` and `fund-usdc` and exposes `Fixture::warp`. See `docs/technical/full-stack-devnet.md`.

## Tests

```
bun test scripts/devnet/twin-fork-lib.test.ts --timeout 60000          # unit, no network
TWIN_FORK_SMOKE=1 bun test scripts/devnet/twin-fork-lib.test.ts --timeout 240000   # starts anvil on the public endpoint
```
