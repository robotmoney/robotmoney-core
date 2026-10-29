# Testing deposits and withdrawals on Base (Deploy 3)

This guide is for testers. It shows how to put 1 USDC into the Robot Money test vaults through the router, and how to take it back out.

**Read this first.** These are TEST contracts on Base mainnet (chain 8453). They are unaudited. They hold real money. Use only money you can lose. Every test is 1 USDC, withdrawn straight back.

## What you need

- `cast` from Foundry.
- A fresh wallet that `cast` can sign with: a keystore or a Ledger.
- About 0.001 ETH on Base for gas.
- At least 1 USDC on Base.

Never test with a deployment key. That means no deployer, Safe owner, pauser or emergency key. Make a new wallet for testing.

## The contracts

Deploy 3 was upgraded to v0.6.0 on 2026-10-29. The addresses did not change.

| Name | Address | Notes |
|---|---|---|
| USDC (Base) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | The token you deposit. |
| Router | `0x8dc32ECf1C839f67Be58eC0Dea43Fe6974593D1e` | Splits one deposit across the vaults. |
| rmUSDC vault | `0x00b6560DDcc7b7413920f408713411Ebd28b3D5F` | Fixed income. |
| rmPROTO vault | `0xec0CE235382e36B52E8a41c5FAA67D6C46536023` | Protocol tokens. |
| rmRWA vault | `0x20913c41bfeF5E49132D690d891eEbFEC549Cd49` | Real world assets. |
| rmAGENT vault | `0x9b7C21fD176f4c8CF0571A1F51383561eB7089bA` | **Retired.** You can only withdraw from it. |

Other addresses you may see:
- **Old addresses.** The addresses in `deployments/8453/deploy-2/` belong to Deploy 2, an older and separate deployment. Do not test with them.
- **Consensus receipt.** `0x0fa82D61266FFe25F04272C1Cdf1939a56E4ac95` records the committee vote that set the split.
- **Contract records.** The full Deploy 3 records are the run manifests.

## Limits

- A vault takes at most 100 USDC per deposit.
- A vault holds at most 1,000 USDC in total.
- Keep every test at 1 USDC.

## Step 1: set up your terminal

Run these in `bash`. Replace the two values in angle brackets.

```bash
export ETH_RPC_URL=https://mainnet.base.org
export USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
export ROUTER=0x8dc32ECf1C839f67Be58eC0Dea43Fe6974593D1e
export ME=<your wallet address>
export SIGN="--keystore <path to your keystore>"    # or: export SIGN="--ledger"
```

If you use `zsh` (the macOS default), `$SIGN` will not work as written. Run `bash` first, or type the flag into each command.

## Step 2: check before you deposit

```bash
# You hold USDC. 1000000 means 1 USDC (USDC has 6 decimals).
cast call $USDC 'balanceOf(address)(uint256)' $ME

# The router's split: the vaults, then each vault's share in basis points (10000 = 100%).
cast call $ROUTER 'getEffectiveWeights()(address[],uint256[])'

# Deposits are open. Each line must print false.
for v in $(cast call $ROUTER 'getEffectiveWeights()(address[],uint256[])' | head -n 1 | tr -d '[],'); do
  cast call $v 'depositsPaused()(bool)'
done
```

Today the split is 7000, 1500, 1500. That means 70% goes to rmUSDC, 15% to rmPROTO and 15% to rmRWA. The split can change when the investment committee's choice is applied, so always read it.

If any vault prints `true`, deposits are paused for a test. Wait and try later. Withdrawals still work.

## Step 3: deposit 1 USDC through the router

```bash
# Let the router take exactly 1 USDC from your wallet.
cast send $USDC 'approve(address,uint256)' $ROUTER 1000000 $SIGN

# Deposit. Always pass this gas limit (see "If something goes wrong").
cast send $ROUTER 'deposit(uint256,uint256[])' 1000000 '[]' --gas-limit 8400000 $SIGN
```

The `'[]'` means you set no minimum on what each vault gives you back.

## Step 4: see your shares

You get shares in each vault that received part of your deposit.

```bash
for v in 0x00b6560DDcc7b7413920f408713411Ebd28b3D5F \
         0xec0CE235382e36B52E8a41c5FAA67D6C46536023 \
         0x20913c41bfeF5E49132D690d891eEbFEC549Cd49; do
  SHARES=$(cast call $v 'balanceOf(address)(uint256)' $ME | awk '{print $1}')
  echo "$v shares=$SHARES worth=$(cast call $v 'previewRedeem(uint256)(uint256)' $SHARES)"
done
```

The share numbers look huge. That is on purpose: it protects the vaults from an attack. Use the `worth` column instead. It is what you would get back in USDC, with 6 decimals.

## Step 5: withdraw

Withdrawals are always open, even while deposits are paused. Withdraw from each vault where you hold shares:

```bash
export VAULT=0x00b6560DDcc7b7413920f408713411Ebd28b3D5F   # repeat for rmPROTO and rmRWA
SHARES=$(cast call $VAULT 'balanceOf(address)(uint256)' $ME | awk '{print $1}')
cast send $VAULT 'redeem(uint256,address,address)' $SHARES $ME $ME --gas-limit 3000000 $SIGN
```

Check that the USDC came back:

```bash
cast call $USDC 'balanceOf(address)(uint256)' $ME
```

You may get back a little less than you put in. rmPROTO and rmRWA trade USDC into their tokens and back, and each trade costs a small amount.

**If a withdrawal fails on rmPROTO or rmRWA,** take the vault's own tokens instead of USDC. This does not read a price, so it works when the USDC withdrawal fails:

```bash
cast send $VAULT 'redeemInKind(uint256,address,address)' $SHARES $ME $ME --gas-limit 3000000 $SIGN
```

**If you still hold rmAGENT shares** from before it was retired, withdraw them the same way with `VAULT=0x9b7C21fD176f4c8CF0571A1F51383561eB7089bA`. Deposits into rmAGENT fail now.

## If something goes wrong

- **The deposit fails with `InsufficientGas`.** The router needs a gas limit you set yourself: 2,400,000 per vault in the split, plus 1,200,000. For three vaults that is 8,400,000. Never let your wallet guess. Unused gas is refunded.
- **A read right after a send shows the old value.** The public RPC is load balanced. A read can hit a node that has not seen your transaction yet. Wait a few seconds and read again.
- **`replacement transaction underpriced`.** The RPC has not caught up with your last send. Wait a few seconds and run the command again.
- **A balance looks wrong in a wallet app.** Use `previewRedeem` as in step 4. The raw share number is not a USDC amount.

## What changed in v0.6.0

- **rmAGENT is retired.** It takes no new deposits. Holders can still withdraw.
- **The router splits across three vaults, not four.** A router deposit now needs `--gas-limit 8400000` instead of 10,800,000.
- **No price recorder step.** You no longer poke a recorder before a deposit. That step was only for rmAGENT.
- **The agent payment gateway was upgraded.** Its address `0x253a51AF2464A2a9a830f2007659ff0fBb4588ec` did not change. Testers deposit through the router, not the gateway.
