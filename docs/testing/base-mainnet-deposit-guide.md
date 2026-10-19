# Depositing into the Robot Money test vaults on Base (Deploy 3)

For internal contributors who want to test the Deploy 3 contracts by hand with a 1 USDC deposit.

These are TEST contracts on Base mainnet (chain 8453). They are unaudited and run under tiny caps. They hold real money. Deposit only what you can lose, and expect rmAGENT to return about 94% of what you put in.

You need: `cast` from Foundry, a Base RPC URL, a wallet that `cast` can sign with (keystore, Ledger or private key), a little ETH on Base for gas, and USDC on Base.

Never use a deployment key for these tests: not the deployer, a Safe owner, the pauser, the emergency key or the recorder keeper. Every rehearsal shares the deployer, which must keep one nonce writer. Use a fresh account of your own.

## What changed since Deploy 2

- **New addresses.** Deploy 3 (release v0.5.0, core `57fbe618`) is a new deployment. The Deploy 2 contracts are still on chain, and their addresses are in `deployments/8453/deploy-2/`.
- **Upgradeable proxies.** Every address below is a proxy. Its implementation can change only through the upgrade timelock, which the Safe controls. Your shares stay at the proxy address across an upgrade.
- **Router gas.** A router deposit now needs at least 2,400,000 gas per leg, up from 1,700,000. With four legs, use `--gas-limit 10800000` (`clients/dapp/src/lib/depositGas.ts`).
- **rmAGENT price guard.** The NAV deviation guard is 400 bps, up from Deploy 2's 100. A stale recorder still blocks rmAGENT deposits, so poke it first.
- **Agent gateway.** Deploy 3 adds a payment gateway that `rmpc` agents deposit through. People deposit through the router or a vault, not the gateway.
- **The deployment is still under QA.** Runbook steps may pause deposits for a while. Check `depositsPaused()` before you deposit.

## Addresses (Deploy 3)

| Name | Address |
|---|---|
| USDC (Base) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Portfolio router | `0x8dc32ECf1C839f67Be58eC0Dea43Fe6974593D1e` |
| rmUSDC vault | `0x00b6560DDcc7b7413920f408713411Ebd28b3D5F` |
| rmPROTO vault | `0xec0CE235382e36B52E8a41c5FAA67D6C46536023` |
| rmAGENT vault | `0x9b7C21fD176f4c8CF0571A1F51383561eB7089bA` |
| rmRWA vault | `0x20913c41bfeF5E49132D690d891eEbFEC549Cd49` |
| rmAGENT price recorder | `0x584172344296E33DF7A796cDB04f793458C4BE60` |
| Agent payment gateway (for `rmpc`) | `0x253a51AF2464A2a9a830f2007659ff0fBb4588ec` |
| Vault registry | `0x4DF8cDed6f235cDc69f81b9fe11dD9e317793a45` |
| Upgrade timelock | `0x31E3197ebBF4643Fb0a0b5C2FD01E26E1aC4b1de` |
| Safe | `0x4A2E451e1ecC49684171E8eC9e50424f9193A1Ab` |

The source is the Deploy 3 run's manifests. Read the router's split on chain:

```bash
cast call 0x8dc32ECf1C839f67Be58eC0Dea43Fe6974593D1e 'getEffectiveWeights()(address[],uint256[])'
```

At launch it splits a deposit 85.50% rmUSDC, 5.25% rmPROTO, 5.75% rmAGENT and 3.50% rmRWA.

## Limits

- Per deposit: 100 USDC on rmUSDC, rmPROTO and rmRWA, and 15 USDC on rmAGENT.
- Total value: 1,000 USDC per vault, and 100 USDC on rmAGENT.
- Rule for the test deployment: every test deposit is 1 USDC, redeemed straight back. Larger amounts hit the per-deposit caps on the router legs.

Read the live caps with `cast call $VAULT 'perDepositCap()(uint256)'` and `cast call $VAULT 'tvlCap()(uint256)'`.

## Setup

```bash
export ETH_RPC_URL=https://mainnet.base.org
export USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
export ROUTER=0x8dc32ECf1C839f67Be58eC0Dea43Fe6974593D1e
export RECORDER=0x584172344296E33DF7A796cDB04f793458C4BE60
export ME=<your address>
# pick one signing flag and reuse it below:
#   --keystore PATH --password-file FILE     (Foundry keystore)
#   --ledger                                 (Ledger)
export SIGN="--keystore $HOME/.foundry/keystores/mykey --password-file $HOME/.keypass"
```

**zsh (the macOS default) does not split `$SIGN` into separate arguments.** Run the commands in `bash`, write the flags inline in every `cast send`, or use `${=SIGN}`.

About 0.001 ETH covers a full round trip. `cast` bids the network price, which is a few thousandths of a gwei on Base. Your wallet must still hold the gas limit times the maximum fee before a send. Unused gas is refunded.

## Rules that avoid failed transactions

1. **Set the gas limit yourself.** A four-leg router deposit needs at least 9,600,000 gas at entry: use `--gas-limit 10800000`. A vault deposit needs at least 1,600,000: use `--gas-limit 2500000`. A vault redeem: use `--gas-limit 3000000`.
2. **Never rely on a `pending` gas estimate.** Simulate and estimate at `latest`. The Moonwell vault behind rmUSDC panics at `pending` now and then.
3. **Poke the price recorder first.** rmAGENT refuses deposits when the recorder is stale or its price is far from the live pool price. Call `record()`, then check `isFresh()`. No keeper runs for the Deploy 3 recorder.
4. **Wait for the public RPC to catch up.** `mainnet.base.org` is load balanced. A read right after a send can hit a node that has not seen your transaction yet: a balance reads 0, or the next send reuses a nonce. Wait a few seconds and read again.

## Deposit 1 USDC through the router

```bash
# 1. check you hold the USDC (6 decimals: 1000000 = 1 USDC)
cast call $USDC 'balanceOf(address)(uint256)' $ME

# 2. check no vault has deposits paused (each must print false)
for v in $(cast call $ROUTER 'getEffectiveWeights()(address[],uint256[])' | head -n 1 | tr -d '[],'); do
  cast call $v 'depositsPaused()(bool)'
done

# 3. poke the recorder, then confirm it is fresh (must print true)
cast send $RECORDER 'record()' $SIGN
cast call $RECORDER 'isFresh()(bool)'

# 4. approve exactly the amount to the router
cast send $USDC 'approve(address,uint256)' $ROUTER 1000000 $SIGN

# 5. preview the split (optional). The output is raw hex: each leg is vault, weight in basis points, amount, available.
cast call $ROUTER 'previewDeposit(uint256)' 1000000

# 6. deposit. The empty array means no per-vault slippage floor.
#    If cast fails with 'replacement transaction underpriced', the RPC has not caught up with step 4:
#    wait a few seconds and rerun, or add --nonce <next nonce>.
cast send $ROUTER 'deposit(uint256,uint256[])' 1000000 '[]' --gas-limit 10800000 $SIGN
```

If `isFresh()` stays false, or the deposit reverts on the rmAGENT leg, call `record()` again at least 60 seconds later. After a quiet period it can take several calls before the recorded average catches the pool price.

Shares land in your wallet in all four vaults. Check each one:

```bash
for v in 0x00b6560DDcc7b7413920f408713411Ebd28b3D5F \
         0xec0CE235382e36B52E8a41c5FAA67D6C46536023 \
         0x9b7C21fD176f4c8CF0571A1F51383561eB7089bA \
         0x20913c41bfeF5E49132D690d891eEbFEC549Cd49; do
  cast call $v 'balanceOf(address)(uint256)' $ME
done
```

## Deposit into one vault directly

```bash
export VAULT=0x00b6560DDcc7b7413920f408713411Ebd28b3D5F   # rmUSDC
cast send $USDC 'approve(address,uint256)' $VAULT 1000000 $SIGN
cast send $VAULT 'deposit(uint256,address)' 1000000 $ME --gas-limit 2500000 $SIGN
```

For rmAGENT, poke the recorder first (step 3 above).

## Reading your balance

- Shares have `decimals() == 6`, but the vaults use a virtual-share offset of 18, so a raw balance is about 1e18 times the USDC value. A wallet shows a huge number of rmUSDC. This is intentional (inflation-attack protection). Use `convertToAssets` and `previewRedeem` to read value.
- `convertToAssets` ignores exit costs. rmAGENT pays about 94% of a 1 USDC round trip, while `convertToAssets` says about 97%. Use `previewRedeem` for what an exit pays (core issue 1795).

## Get your money back

Withdrawals are always open, even while deposits are paused. Redeem all your shares from each vault:

```bash
SHARES=$(cast call $VAULT 'balanceOf(address)(uint256)' $ME | awk '{print $1}')
cast send $VAULT 'redeem(uint256,address,address)' $SHARES $ME $ME --gas-limit 3000000 $SIGN
```

If the USDC redeem reverts on rmPROTO, rmAGENT or rmRWA, redeem in kind. You receive the underlying tokens instead of USDC. `redeemInKind` reads no price, so it works even when the rmAGENT recorder is stale:

```bash
cast send $VAULT 'redeemInKind(uint256,address,address)' $SHARES $ME $ME --gas-limit 3000000 $SIGN
```

## Known issues

- Position value from `convertToAssets` overstates rmAGENT by about 3% against what an exit pays (core issue 1795, open).
- No keeper calls `record()` for the Deploy 3 recorder, so rmAGENT deposits fail after a quiet period until someone pokes. The keeper script is `scripts/ops/recorder-keeper.sh` (core issue 1779).
- The Deploy 2 issues on router gas (core issue 1777) and the rmPROTO USDC redeem (core issue 1778) are closed. `redeemInKind` stays the fallback exit.
