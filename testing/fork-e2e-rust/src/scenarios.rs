//! Canonical: Plan tracking issue #109 §8 ("Required scenarios").
//!
//! Shared helpers used by the five §8 scenarios. The scenarios
//! themselves live as `#[test]` cases under `tests/` so each one
//! gets its own forked anvil backend (per ADR §3.5 — fork-restart
//! per test).
//!
//! Helpers exposed here are intentionally thin — encoding a
//! Solidity call, decoding a uint256 return, comparing receipt
//! gas vs a documented budget — so test files read close to plain
//! prose.

use alloy_primitives::{Address, U256};
use alloy_sol_types::SolCall;

use crate::{
    Account, Bytes, ForkFixture, HarnessError, IBasketVault, IRobotMoneyVault, Receipt, IERC20,
};

/// Read a `uint256`-returning view function on the vault. The
/// caller must know the function actually returns a single
/// uint256 — we decode the first 32 bytes of the ABI-encoded
/// return blob unconditionally. Using the raw decode here (rather
/// than a typed `SolCall::Return` bound) keeps this helper usable
/// against the alloy `sol!` macro's wrapper return structs without
/// per-call boilerplate.
pub fn vault_read_u256<C: SolCall>(
    fx: &ForkFixture,
    caller: &Account<'_>,
    call: &C,
) -> Result<U256, HarnessError> {
    let _ = fx; // future-proofing — caller already routes through the fixture's RPC
    let bytes: Bytes = caller.call(crate::addresses::VAULT, call)?;
    decode_u256(&bytes)
}

/// Read a `uint256`-returning view function on USDC. See
/// [`vault_read_u256`] for the rationale on the unbounded
/// `SolCall` parameter.
pub fn usdc_read_u256<C: SolCall>(
    fx: &ForkFixture,
    caller: &Account<'_>,
    call: &C,
) -> Result<U256, HarnessError> {
    let _ = fx;
    let bytes: Bytes = caller.call(crate::addresses::USDC, call)?;
    decode_u256(&bytes)
}

/// Decode a 32-byte big-endian u256 return blob.
pub fn decode_u256(b: &Bytes) -> Result<U256, HarnessError> {
    if b.len() < 32 {
        return Err(HarnessError::Rpc(format!(
            "u256 return too short: {} bytes",
            b.len()
        )));
    }
    Ok(U256::from_be_slice(&b[..32]))
}

/// Decode a `bool` (right-aligned in 32 bytes).
pub fn decode_bool(b: &Bytes) -> Result<bool, HarnessError> {
    if b.len() < 32 {
        return Err(HarnessError::Rpc(format!(
            "bool return too short: {} bytes",
            b.len()
        )));
    }
    Ok(b[31] != 0)
}

/// Decode a uint8 (decimals, e.g.).
pub fn decode_u8(b: &Bytes) -> Result<u8, HarnessError> {
    if b.len() < 32 {
        return Err(HarnessError::Rpc(format!(
            "u8 return too short: {} bytes",
            b.len()
        )));
    }
    Ok(b[31])
}

/// Approve `spender` to pull `amount` of USDC from `account`.
/// Returns the approval receipt.
pub fn approve_usdc(
    account: &Account<'_>,
    spender: Address,
    amount: U256,
) -> Result<Receipt, HarnessError> {
    let call = IERC20::approveCall { spender, amount };
    account.send(crate::addresses::USDC, &call, U256::ZERO, 100_000)
}

/// Deposit USDC into the vault on behalf of `receiver`.
pub fn vault_deposit(
    account: &Account<'_>,
    assets: U256,
    receiver: Address,
) -> Result<Receipt, HarnessError> {
    let call = IRobotMoneyVault::depositCall { assets, receiver };
    account.send(crate::addresses::VAULT, &call, U256::ZERO, 800_000)
}

/// Redeem `shares` from the vault.
pub fn vault_redeem(
    account: &Account<'_>,
    shares: U256,
    receiver: Address,
    owner: Address,
) -> Result<Receipt, HarnessError> {
    let call = IRobotMoneyVault::redeemCall {
        shares,
        receiver,
        owner,
    };
    account.send(crate::addresses::VAULT, &call, U256::ZERO, 1_200_000)
}

// ──────────────────────────────────────────────────────────────────────
// Basket vault helpers (ProtocolAssetVault / AgentTokenVault)
// These target an arbitrary vault address so the caller can pass a
// freshly-deployed basket vault address from the fork-e2e test.
// ──────────────────────────────────────────────────────────────────────

/// Read a `uint256`-returning view function on any basket vault at `vault`.
/// See [`vault_read_u256`] for the rationale on unbounded `SolCall`.
pub fn basket_read_u256<C: alloy_sol_types::SolCall>(
    caller: &Account<'_>,
    vault: Address,
    call: &C,
) -> Result<U256, HarnessError> {
    let bytes: Bytes = caller.call(vault, call)?;
    decode_u256(&bytes)
}

/// Deposit `assets` USDC into the basket vault at `vault_addr`.
/// Gas is set higher than for `RobotMoneyVault` because each basket
/// deposit executes one Uniswap V3 swap per active asset.
pub fn basket_deposit(
    account: &Account<'_>,
    vault_addr: Address,
    assets: U256,
    receiver: Address,
) -> Result<Receipt, HarnessError> {
    let call = IBasketVault::depositCall { assets, receiver };
    // 2.5M gas: covers USDC pull + up to 2 Uniswap V3 exactInputSingle hops.
    account.send(vault_addr, &call, U256::ZERO, 2_500_000)
}

/// Redeem `shares` from the basket vault at `vault_addr`.
/// Gas is set higher than for `RobotMoneyVault` because each basket
/// redeem executes one Uniswap V3 swap per active asset.
pub fn basket_redeem(
    account: &Account<'_>,
    vault_addr: Address,
    shares: U256,
    receiver: Address,
    owner: Address,
) -> Result<Receipt, HarnessError> {
    let call = IBasketVault::redeemCall {
        shares,
        receiver,
        owner,
    };
    // 2.5M gas: covers share burn + up to 2 Uniswap V3 exactInputSingle hops.
    account.send(vault_addr, &call, U256::ZERO, 2_500_000)
}
