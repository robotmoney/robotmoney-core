# Stage keeper runbook (Deploy 4 on Base)

The one-vault FlowQueue only settles when a keeper calls `settle()`. Without it, deposits and redemptions stay
Pending forever. This page runs `scripts/ops/onevault-keeper.sh` for Deploy 4 on the stage host.

## What runs where

| Item | Value |
| --- | --- |
| Host | `rm-core-stage-1` (ssh alias), user `root` |
| Directory | `~/onevault-keeper/` (mode 700) |
| Script | `onevault-keeper.sh` (copy of `scripts/ops/onevault-keeper.sh`, direct-key mode) |
| Launcher | `start-keeper.sh` (copy of `scripts/ops/start-stage-keeper.sh`; reads the password on stdin) |
| Keystore | `KEEPER.keystore` (encrypted, 0600), key `0x75E3f84949d5e0aB621EEb06537A1a944274768B` |
| Log | `~/onevault-keeper/keeper.log` |
| RPC | `https://mainnet.base.org` |
| Queue | `0xbB414D1536Fef6c240e984a24F777ca0958e5439` |
| Rebalancer | `0x13c1169Da48Bb06E327286971eB3E56c0411A65B` |
| Tick | every 300 s |
| Gas floor | `MIN_GAS_WEI=200000000000000` (0.0002 ETH) |

Deploy 4 grants `KEEPER_ROLE` straight to the key, not to a KeeperAccount. So `KEEPER_ACCOUNT_ADDRESS` is left unset,
and the script sends each call directly from the key.

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
