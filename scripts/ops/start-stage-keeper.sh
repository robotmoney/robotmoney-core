#!/usr/bin/env bash
# Starts the Deploy 4 keeper. Reads the keystore password from stdin; it is never written to disk here.
set -u
cd "$HOME/onevault-keeper" || exit 1
pkill -f '^bash onevault-keeper\.sh' || true
IFS= read -r KEEPER_PASSWORD || [[ -n "${KEEPER_PASSWORD:-}" ]] || { echo "no password on stdin" >&2; exit 1; }
export KEEPER_PASSWORD PATH="$HOME/.foundry/bin:$PATH" \
  RPC_URL=https://mainnet.base.org \
  QUEUE_ADDRESS=0xbB414D1536Fef6c240e984a24F777ca0958e5439 \
  REBALANCER_ADDRESS=0x13c1169Da48Bb06E327286971eB3E56c0411A65B \
  KEEPER_KEYSTORE="$HOME/onevault-keeper/KEEPER.keystore" \
  MIN_GAS_WEI=200000000000000 INTERVAL_SECS=300
setsid nohup bash onevault-keeper.sh >>keeper.log 2>&1 </dev/null &
echo "started pid $!"
