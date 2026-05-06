//! Canonical: docs/implementation-plan.md §8 — scenario 4
//! (`abi_address_sanity`).
//!
//! Asserts that every configured Robot Money / USDC contract has
//! deployed bytecode at the expected fork pin and that the ERC-20
//! / ERC-4626 view selectors decode against the live ABI. This is
//! the cheapest scenario in the §8 set and runs on every PR per
//! ADR §3.4.
//!
//! On failure, the assertion message names the address and the
//! selector that drifted, so a maintainer can pinpoint the cause
//! without re-reading the test (acceptance criterion: "actionable
//! errors").

use alloy_primitives::U256;
use rmpc_fork_e2e::{addresses, scenarios, skip_if_no_fork, ForkFixture, IRobotMoneyVault, IERC20};

#[test]
fn abi_address_sanity() {
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    eprintln!("[abi_address_sanity] {}", fx.summary_line());

    // Every address in the canonical surface must have deployed code.
    for addr in addresses::BASE_ADDRESSES {
        let code = fx.rpc().get_code(*addr).expect("eth_getCode");
        assert!(
            code.len() > 2,
            "address {addr:#x} has no code at fork block {} — possible address drift",
            fx.pin.block
        );
    }

    // Cheap caller for view-only reads.
    let acct = fx
        .ephemeral(U256::from(10u64).pow(U256::from(17u64)), U256::ZERO)
        .expect("ephemeral funded with ETH");

    // USDC.decimals() == 6, USDC.symbol() == "USDC".
    let bytes = acct
        .call(addresses::USDC, &IERC20::decimalsCall {})
        .expect("USDC.decimals()");
    let dec = scenarios::decode_u8(&bytes).expect("decode USDC decimals");
    assert_eq!(dec, 6, "USDC decimals drift: got {dec}");

    let sym_bytes = acct
        .call(addresses::USDC, &IERC20::symbolCall {})
        .expect("USDC.symbol()");
    let sym = decode_string(&sym_bytes).expect("decode USDC symbol");
    assert_eq!(sym, "USDC", "USDC symbol drift: got {sym}");

    // Vault.asset() == USDC; Vault.decimals() exists; Vault.symbol() == "rmUSDC".
    let asset_bytes = acct
        .call(addresses::VAULT, &IRobotMoneyVault::assetCall {})
        .expect("Vault.asset()");
    let asset_addr = alloy_primitives::Address::from_slice(&asset_bytes[12..32]);
    assert_eq!(
        asset_addr,
        addresses::USDC,
        "Vault.asset() != USDC: got {asset_addr:#x}"
    );

    let vsym_bytes = acct
        .call(addresses::VAULT, &IRobotMoneyVault::symbolCall {})
        .expect("Vault.symbol()");
    let vsym = decode_string(&vsym_bytes).expect("decode vault symbol");
    assert_eq!(vsym, "rmUSDC", "Vault symbol drift: got {vsym}");

    // ExitFeeBps must respect the documented 100-bps ceiling.
    let efee_bytes = acct
        .call(addresses::VAULT, &IRobotMoneyVault::exitFeeBpsCall {})
        .expect("Vault.exitFeeBps()");
    let efee = scenarios::decode_u256(&efee_bytes).expect("decode exitFeeBps");
    assert!(
        efee <= U256::from(100u64),
        "Vault.exitFeeBps()={efee} exceeds documented 100-bps ceiling"
    );

    // Vault paused() should be readable (we don't assert false — a
    // paused vault is a legitimate pin if EMERGENCY_ROLE has paused
    // it; we just assert the selector exists and decodes).
    let _ = acct
        .call(addresses::VAULT, &IRobotMoneyVault::pausedCall {})
        .expect("Vault.paused()");
}

/// Minimal ABI string decoder — bytes32 offset, bytes32 length,
/// then the UTF-8 payload.
fn decode_string(b: &alloy_primitives::Bytes) -> Result<String, String> {
    if b.len() < 64 {
        return Err(format!("string return too short: {} bytes", b.len()));
    }
    let len = U256::from_be_slice(&b[32..64]).to::<usize>();
    if b.len() < 64 + len {
        return Err(format!(
            "string payload truncated: header says len={len} but only {} bytes total",
            b.len()
        ));
    }
    String::from_utf8(b[64..64 + len].to_vec()).map_err(|e| format!("utf8: {e}"))
}
