# Revert SEED_DEPOSIT_AMOUNT to 1,000 USDC before mainnet

## What changed

`Deploy.s.sol`'s `SEED_DEPOSIT_AMOUNT` was temporarily lowered from
`1_000 * 1e6` (1,000 USDC) to `1 * 1e6` (1 USDC) to unblock the Base Sepolia
live deployment rehearsal (docs/operations/base-sepolia-deployment.md):
testnet USDC faucets (Circle) cap requests at 20 USDC per claim, making it
impractical to accumulate 1,000 USDC on a throwaway deployer key just to
exercise the deploy tooling.

Files touched:

- `contracts/script/Deploy.s.sol` — `SEED_DEPOSIT_AMOUNT` constant.
- `contracts/test/Deploy.t.sol` — unit assertion of the constant's value.

## Why this matters

Per `docs/technical/security-model.md` §3 and `docs/technical/smart-contracts.md`
§8.3, the seed deposit is a defense-in-depth measure against the ERC-4626
first-depositor share-price inflation attack, on top of the `10^18`
virtual-share offset (`_decimalsOffset() == 18`). The seed deposit's job is to
anchor the vault's share price to *real* capital before any public depositor
arrives — 1 USDC of real capital is a much weaker anchor than 1,000 USDC.

`SEED_DEPOSIT_AMOUNT` is one constant shared by every network that runs
`Deploy.s.sol` — mainnet, the Robot Money Devnet, and testnet rehearsals alike.
It was deliberately left as a single hardcoded constant (not an env override)
when this change was made, at the user's request, to keep the change minimal.

## Action required

Before any Base mainnet deployment, revert `SEED_DEPOSIT_AMOUNT` to
`1_000 * 1e6` (1,000 USDC) and restore the corresponding assertion in
`contracts/test/Deploy.t.sol`. Consider, at that time, whether the constant
should instead become an env-overridable value defaulting to 1,000 USDC, so a
future testnet rehearsal doesn't require touching this file again.
