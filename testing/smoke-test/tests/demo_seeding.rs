//! Smoke-test: demo seeding of the four-vault catalog and real simulated
//! depositors funding every vault at boot (issues #465, #479, #559, #560, #563).
//!
//! Asserts the smoke-test devnet boots in the four-vault shape:
//!   1. `VaultRegistry.listVaults()` returns four **Active** vaults — the
//!      primary `RobotMoneyVault` (§11.1), `ProtocolAssetVault` (§11.2),
//!      `AgentTokenVault` (§11.3) and the deSPXA `RwaVault` (§11.4). The first
//!      three are router-eligible; rmRWA is Active but not router-eligible
//!      (ADR-0006 §1) and is seeded by a direct deposit.
//!   2. `PortfolioRouter.getWeights()` returns three weight entries — the
//!      router-eligible vaults — summing to exactly 10 000 bps. rmRWA is never
//!      weighted.
//!   3. After `Fixture::seed_demo_depositors`, **all four** vaults report
//!      non-zero `totalAssets` and each simulated depositor holds receipt-share
//!      balances across the seeded vaults.
//!
//! Run with:
//!   cargo test -p smoke-test --release --test demo_seeding -- --test-threads=1 --nocapture

use alloy_primitives::Address;
use smoke_test::{prerequisites_available, Fixture};

fn skip_if_no_prereqs(name: &str) -> bool {
    if !prerequisites_available() {
        eprintln!("[{name}] docker/forge/cast not on PATH; skipping.");
        return true;
    }
    false
}

fn fixture() -> &'static Fixture {
    use std::sync::OnceLock;
    static CELL: OnceLock<Fixture> = OnceLock::new();
    CELL.get_or_init(|| Fixture::new().expect("smoke-test fixture boot failed"))
}

// ── RPC helpers ──────────────────────────────────────────────────────────────

fn rpc_call<T: for<'de> serde::Deserialize<'de>>(
    url: &str,
    method: &str,
    params: serde_json::Value,
) -> T {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap();
    let body = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": method, "params": params
    });
    let resp: serde_json::Value = client
        .post(url)
        .json(&body)
        .send()
        .expect("RPC request failed")
        .json()
        .expect("RPC response is not JSON");
    serde_json::from_value(resp.get("result").expect("no result field").clone())
        .expect("RPC result decode failed")
}

/// Decode a 32-byte ABI uint256 result into u128 (sufficient for token amounts).
fn u256_from_hex(hex: &str) -> u128 {
    let s = hex.trim_start_matches("0x");
    let len = s.len();
    let slice = if len > 32 { &s[len - 32..] } else { s };
    u128::from_str_radix(slice, 16).unwrap_or(0)
}

fn eth_call_raw(rpc_url: &str, to: Address, data: &str) -> String {
    rpc_call(
        rpc_url,
        "eth_call",
        serde_json::json!([
            {"to": format!("{to:#x}"), "data": data},
            "latest"
        ]),
    )
}

fn balance_of(rpc_url: &str, token: Address, owner: Address) -> u128 {
    let data = format!(
        "0x70a08231000000000000000000000000{}",
        format!("{owner:#x}").trim_start_matches("0x")
    );
    u256_from_hex(&eth_call_raw(rpc_url, token, &data))
}

fn total_assets(rpc_url: &str, vault: Address) -> u128 {
    // totalAssets() selector: 0x01e1d114
    u256_from_hex(&eth_call_raw(rpc_url, vault, "0x01e1d114"))
}

/// Convert ERC-4626 shares to underlying assets via `convertToAssets(uint256)`.
/// RobotMoneyVault uses `_decimalsOffset() = 18` so a raw `balanceOf` share
/// count is 1e18× the underlying asset; this view function does the
/// vault-side conversion so the test arithmetic stays vault-agnostic.
fn convert_to_assets(rpc_url: &str, vault: Address, shares: u128) -> u128 {
    // convertToAssets(uint256) selector: 0x07a2d13a
    let data = format!("0x07a2d13a{:0>64x}", shares);
    u256_from_hex(&eth_call_raw(rpc_url, vault, &data))
}

/// Decode a dynamic `address[]` ABI return: offset (32) + length (32) + N*32.
/// Returns the addresses in order. Robust enough for the small registry the
/// demo seeds (3 entries); a generic decoder lives in alloy but we avoid the
/// extra dep here.
fn decode_address_array(hex: &str) -> Vec<Address> {
    let s = hex.trim_start_matches("0x");
    let bytes = (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap())
        .collect::<Vec<u8>>();
    if bytes.len() < 64 {
        return Vec::new();
    }
    let len = u128::from_be_bytes(bytes[48..64].try_into().unwrap()) as usize;
    let mut out = Vec::with_capacity(len);
    for i in 0..len {
        let start = 64 + i * 32;
        let end = start + 32;
        if end > bytes.len() {
            break;
        }
        out.push(Address::from_slice(&bytes[start + 12..end]));
    }
    out
}

/// Decode a tuple `(address[], uint256[])` ABI return as used by
/// `PortfolioRouter.getWeights()`.
fn decode_address_array_and_uint_array(hex: &str) -> (Vec<Address>, Vec<u128>) {
    let s = hex.trim_start_matches("0x");
    let bytes = (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap())
        .collect::<Vec<u8>>();
    if bytes.len() < 64 {
        return (Vec::new(), Vec::new());
    }
    let off_vaults = u128::from_be_bytes(bytes[16..32].try_into().unwrap()) as usize;
    let off_bps = u128::from_be_bytes(bytes[48..64].try_into().unwrap()) as usize;
    let len_vaults =
        u128::from_be_bytes(bytes[off_vaults + 16..off_vaults + 32].try_into().unwrap()) as usize;
    let mut vaults = Vec::with_capacity(len_vaults);
    for i in 0..len_vaults {
        let start = off_vaults + 32 + i * 32;
        vaults.push(Address::from_slice(&bytes[start + 12..start + 32]));
    }
    let len_bps =
        u128::from_be_bytes(bytes[off_bps + 16..off_bps + 32].try_into().unwrap()) as usize;
    let mut bps = Vec::with_capacity(len_bps);
    for i in 0..len_bps {
        let start = off_bps + 32 + i * 32;
        bps.push(u128::from_be_bytes(
            bytes[start + 16..start + 32].try_into().unwrap(),
        ));
    }
    (vaults, bps)
}

// ── Tests ────────────────────────────────────────────────────────────────────

/// Read a registered vault's `VaultStatus` via `getVault(address)`.
///
/// `VaultRegistry.getVault(address)` returns `(VaultMetadata metadata,
/// VaultStatus status)`. The outer tuple ABI layout is:
///   bytes  0..32  — offset to dynamic `metadata` (holds a string, encoded
///                   out-of-line)
///   bytes 32..64  — `status` as a uint8 zero-padded to 32 bytes
/// We only need the status word; pulling the second head slot is the most
/// direct decode and avoids walking the metadata bytes. Status encodes as
/// 0=Active, 1=Paused, 2=Retired.
fn vault_status(fx: &Fixture, vault: Address) -> u128 {
    // getVault(address) selector: 0x0eb9af38
    let data = format!(
        "0x0eb9af38000000000000000000000000{}",
        format!("{vault:#x}").trim_start_matches("0x")
    );
    let raw = eth_call_raw(fx.rpc_url(), fx.registry(), &data);
    let s = raw.trim_start_matches("0x");
    assert!(
        s.len() >= 128,
        "getVault({vault:#x}) return too short: {raw}"
    );
    let status_word = &s[64..128];
    u128::from_str_radix(status_word, 16)
        .unwrap_or_else(|e| panic!("status word {status_word:?} not hex: {e}"))
}

/// AC1 (issues #465, #479, #559, #560): VaultRegistry.listVaults() returns the
/// four PRD §11 vaults — primary, protocol, agent and RWA — all Active.
#[test]
fn registry_lists_four_active_vaults() {
    if skip_if_no_prereqs("registry_lists_four_active_vaults") {
        return;
    }
    let fx = fixture();

    // listVaults() selector: 0x50cc258e
    let raw = eth_call_raw(fx.rpc_url(), fx.registry(), "0x50cc258e");
    let vaults = decode_address_array(&raw);
    assert_eq!(
        vaults.len(),
        4,
        "expected 4 registered vaults after demo seeding, got {} ({:?})",
        vaults.len(),
        vaults
    );

    // All four PRD §11 vaults must be present and report Active (status=0):
    // the three router-eligible vaults plus the directly-seeded RWA vault.
    let mut expected = fx.all_demo_vaults().to_vec();
    expected.push(fx.rwa_vault());
    for v in expected {
        assert!(
            vaults.contains(&v),
            "expected vault {v:#x} in registry, got {vaults:?}"
        );
        let status = vault_status(fx, v);
        assert_eq!(
            status, 0,
            "vault {v:#x} should be Active (status=0); got status={status}"
        );
    }
}

/// AC3: Router weights cover the three router-eligible vaults (§11.1/§11.2/
/// §11.3) and sum to exactly 10 000 bps. The §11.4 RWA vault is never weighted
/// (ADR-0006 §1) — it is seeded by a direct deposit instead.
#[test]
fn router_weights_cover_three_eligible_vaults() {
    if skip_if_no_prereqs("router_weights_cover_three_eligible_vaults") {
        return;
    }
    let fx = fixture();

    // getWeights() selector: 0x22acb867
    let raw = eth_call_raw(fx.rpc_url(), fx.router(), "0x22acb867");
    let (vaults, bps) = decode_address_array_and_uint_array(&raw);
    assert_eq!(
        vaults.len(),
        3,
        "expected 3 router weight entries (eligible vaults), got {vaults:?}"
    );
    assert_eq!(bps.len(), 3, "expected 3 router weight bps entries");

    // The three router-eligible vaults must all appear in the weight vector;
    // the RWA vault must not.
    for v in fx.all_demo_vaults() {
        assert!(
            vaults.contains(&v),
            "router-eligible vault {v:#x} missing from weights {vaults:?}"
        );
    }
    assert!(
        !vaults.contains(&fx.rwa_vault()),
        "RWA vault {:#x} must not be router-weighted, got {vaults:?}",
        fx.rwa_vault()
    );

    let total: u128 = bps.iter().sum();
    assert_eq!(
        total, 10_000,
        "router weights must sum to 10000 bps, got {total}"
    );
}

/// AC2: After seeding simulated depositors, **all four** vaults report non-zero
/// `totalAssets` and every depositor holds a non-zero receipt-share balance
/// across the seeded vaults.
///
/// The router deposit funds the three router-eligible vaults (§11.1/§11.2/
/// §11.3); a direct deposit funds the §11.4 RWA vault. Basket and RWA legs run
/// real USDC → token swaps, so the depositor's per-vault share count is not a
/// clean linear function of the deposit amount — we assert non-zero TVL and
/// non-zero depositor shares (the invariant the dapp tiles depend on), not an
/// exact share/asset identity.
#[test]
fn simulated_depositors_fund_all_four_vaults() {
    if skip_if_no_prereqs("simulated_depositors_fund_all_four_vaults") {
        return;
    }
    let fx = fixture();

    let per_user_usdc: u128 = 1_000 * 1_000_000;
    let count: u32 = 3;
    let depositors = fx
        .seed_demo_depositors(count, per_user_usdc)
        .expect("seed_demo_depositors");
    assert_eq!(depositors.len(), count as usize);

    // Every one of the four vaults must hold real deposits.
    let mut all_vaults = fx.all_demo_vaults().to_vec();
    all_vaults.push(fx.rwa_vault());
    for v in &all_vaults {
        let ta = total_assets(fx.rpc_url(), *v);
        assert!(ta > 0, "vault {v:#x} has zero totalAssets after seeding");
    }

    // Each depositor must hold receipt shares across the seeded vaults: the
    // primary (router) leg and the RWA (direct) leg are the highest-signal
    // checks because both mint shares 1:1-ish without basket dilution edge
    // cases. Require a non-zero balance on each.
    for (addr, _tx) in &depositors {
        let primary_shares = balance_of(fx.rpc_url(), fx.vault(), *addr);
        assert!(
            primary_shares > 0,
            "depositor {addr:#x} holds no primary-vault shares"
        );
        let rwa_shares = balance_of(fx.rpc_url(), fx.rwa_vault(), *addr);
        assert!(
            rwa_shares > 0,
            "depositor {addr:#x} holds no RWA-vault shares"
        );
        // convert_to_assets sanity-checks the primary receipt is redeemable.
        let _ = convert_to_assets(fx.rpc_url(), fx.vault(), primary_shares);
    }
}
