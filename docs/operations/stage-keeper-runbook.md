# Stage keeper runbook (Deploy 4 on Base)

The one-vault FlowQueue only settles when a keeper calls `settle()`. Without it, deposits and redemptions stay
Pending forever. This page runs `scripts/ops/onevault-keeper.sh` for Deploy 4 on the stage host.

## What runs where

| Item | Value |
| --- | --- |
| Host | `rm-core-stage-1` (ssh alias), user `root` |
| Directory | `~/onevault-keeper/` (mode 700) |
| Script | `onevault-keeper.sh` (copy of `scripts/ops/onevault-keeper.sh`, direct-key mode) |
| Launcher | `start-keeper.sh` (copy of `scripts/ops/start-stage-keeper.sh`; reads the password on stdin; self-test `scripts/ops/test-start-stage-keeper.sh`) |
| Keystore | `KEEPER.keystore` (encrypted, 0600), key `0x75E3f84949d5e0aB621EEb06537A1a944274768B` |
| Log | `~/onevault-keeper/keeper.log` |
| RPC | `https://mainnet.base.org` |
| Queue | `0xbB414D1536Fef6c240e984a24F777ca0958e5439` |
| Rebalancer | `0x13c1169Da48Bb06E327286971eB3E56c0411A65B` |
| Tick | every 300 s |
| Gas floor | `MIN_GAS_WEI=200000000000000` (0.0002 ETH) |

Deploy 4 grants `KEEPER_ROLE` straight to the key, not to a KeeperAccount. So `KEEPER_ACCOUNT_ADDRESS` is left unset,
and the script sends each call directly from the key.

## Install

The keeper script needs the direct-key mode and `KEEPER_PASSWORD` support from the keeper fix (2048). Copy both files
from a checkout that has it:

```bash
ssh rm-core-stage-1 'mkdir -p ~/onevault-keeper && chmod 700 ~/onevault-keeper'
scp scripts/ops/onevault-keeper.sh rm-core-stage-1:onevault-keeper/onevault-keeper.sh
scp scripts/ops/start-stage-keeper.sh rm-core-stage-1:onevault-keeper/start-keeper.sh
scp -p ~/robotmoney-keys/base-mainnet-test/KEEPER rm-core-stage-1:onevault-keeper/KEEPER.keystore
```

Foundry must be in `~/.foundry/bin` on the host. The launcher adds it to `PATH`.

## The password

The password never sits on the stage disk and never appears on a command line.

- The operator machine pipes it over ssh stdin into the launcher.
- The launcher exports it as `KEEPER_PASSWORD` for the script only.
- Cast only reads a password from a regular file. So the script writes it to a 0600 file in RAM (`/dev/shm`), deletes
  it on exit, and unsets the variable.
- Do not use cast's `ETH_PASSWORD`. It is a file path, and cast prints its value in the error when the file is missing.

## Start or restart

Run from the operator machine:

```bash
ssh rm-core-stage-1 'bash ~/onevault-keeper/start-keeper.sh' < ~/robotmoney-keys/base-mainnet-test.pass
```

The launcher stops any running copy first. A host reboot stops the keeper, so run this again after a reboot.

## Check it

```bash
ssh rm-core-stage-1 'pgrep -af "^bash onevault-keeper"; tail -20 ~/onevault-keeper/keeper.log'
```

A healthy idle tick logs `nothing due`. A settle logs `sent settle(uint256,uint256)`. Alerts are one JSON line each.

From anywhere, `cast nonce 0x75E3f84949d5e0aB621EEb06537A1a944274768B` rises each time the keeper sends.

## Stop

```bash
ssh rm-core-stage-1 'pkill -f "^bash onevault-keeper\.sh"'
```

Use the `^` anchor. Without it, `pkill -f` matches the ssh session's own command and kills it.

## Gas

The key held 0.00088 ETH on 2026-11-23. A settle on Base costs a small fraction of the floor. When the log shows
`low_gas`, send ETH to the keeper key and restart.

## Known gaps

- No supervisor. A crash or reboot stops settlement until someone restarts it.
- `ALERT_WEBHOOK` is not set, so alerts only go to the log.
- The script logs a mined revert as sent. `cast send` exits 0 on a revert, and the script reads only the exit code
  (settle `0xb8a1e8ea…29d5` reverted with `SettleSideOutOfGas(Deposit)` on 2026-11-23). The keeper service below fixes
  this.

## The keeper service (replaces the script)

`services/keeper` is the TypeScript keeper of proposal §8.1. It checks every receipt, alerts `<duty>_reverted` with the
decoded reason, sets the settle gas limit from the contract's own side budget, and serves `/healthz` and `/metrics`.
The script stays the stage keeper until the service has run one full week on stage with no missed epoch and no
unalerted revert. Then the script and its tests are deleted.

Never run the script and the service on the same key at once. Stop the script first.

### Install

On the host, as root:

```bash
git clone --depth 1 https://github.com/robotmoney/robotmoney-core /opt/robotmoney-keeper
(cd /opt/robotmoney-keeper/services/keeper && bun install --frozen-lockfile)
install -d -m 700 /etc/robotmoney-keeper
install -m 600 ~/onevault-keeper/KEEPER.keystore /etc/robotmoney-keeper/keeper.keystore
cp /opt/robotmoney-keeper/services/keeper/keeper.example.toml /etc/robotmoney-keeper/keeper.toml
cp /opt/robotmoney-keeper/services/keeper/systemd/robotmoney-keeper.service /etc/systemd/system/
```

Edit `/etc/robotmoney-keeper/keeper.toml` with the values in the table at the top: `queue`, `rebalancer`,
`chainId = 8453`, no `keeperAccount` (Deploy 4 is direct mode), `minGasWei = "200000000000000"`. Use a vetted paid RPC
as `rpcUrl` and `https://mainnet.base.org` only in `rpcFallbackUrls`.

### The password

The unit reads it through systemd `LoadCredential=` from `/etc/robotmoney-keeper/password` (root, mode 0600). The
service refuses a password file that a group or other user can read. Write it from the operator machine over ssh
stdin, so it never appears on a command line:

```bash
ssh rm-core-stage-1 'umask 077; cat > /etc/robotmoney-keeper/password' < ~/robotmoney-keys/base-mainnet-test.pass
```

For a one-off run without systemd, pipe the password on stdin instead:
`bun src/cli.ts --config keeper.toml --once < password`. `--once` runs one tick and exits 0 (no alert), 1 (an alert),
or 2 (bad config, a failed start-up check, or another instance holds the lock).

### Start, check, stop

```bash
ssh rm-core-stage-1 'pkill -f "^bash onevault-keeper\.sh"; systemctl daemon-reload; systemctl enable --now robotmoney-keeper'
ssh rm-core-stage-1 'journalctl -u robotmoney-keeper -n 20; curl -s localhost:9464/healthz; curl -s localhost:9464/metrics'
ssh rm-core-stage-1 'systemctl stop robotmoney-keeper'
```

`/healthz` returns 200 while the last tick finished within 2 × `intervalSecs`. `/metrics` carries
`keeper_last_tick_timestamp_seconds` and `keeper_seconds_since_last_settle` for the Watchdog's keeper liveness check
(the Watchdog does not read them yet). Exit 2 does not restart
(`RestartPreventExitStatus=2`): read the `keeper_unconfigured` line in the journal and fix the config.

### Alerts

One JSON line each in the journal, and a POST to `alertWebhook` when set. The same kind and cause alerts once, again
every `realertSecs`, and once on recovery (`"recovered":true`). Kinds: `keeper_unconfigured`, `queue_paused`,
`low_gas`, `gas_price_high`, `settle_reverted`, `step_reverted`, `delist_step_reverted`, `send_failed`, `tx_stuck`,
`rpc_unreadable`, `epoch_overdue`.
