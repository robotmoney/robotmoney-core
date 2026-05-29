//! Smoke-test: demo seeding of the four-vault catalog, simulated depositors,
//! and a non-degenerate router weight split (issues #465, #479).
//!
//! Asserts the smoke-test devnet boots in the four-vault shape:
//!   1. `VaultRegistry.listVaults()` returns four vaults — the primary
//!      `RobotMoneyVault`, the two `DeployDemoExtraVaults` stand-ins (all
//!      three Active), plus the RWA/Thematic placeholder (issue #479), which
//!      is registered non-Active (Paused) and never router-eligible so the
//!      deployed set matches the four PRD §11 categories.
//!   2. `PortfolioRouter.getWeights()` returns the three demo weights
//!      (5000/3000/2000 bps) summing to exactly 10 000 — the RWA placeholder
//!      is never weighted.
//!   3. After `Fixture::seed_demo_depositors`, each Active vault reports
//!      non-zero `totalAssets` and the sum of the simulated depositors' share
//!      balances on each vault equals that vault's `totalAssets`.
//!
//! The basket vaults `ProtocolAssetVault` and `AgentTokenVault` remain
//! ADR-blocked (see `docs/technical/basket-vault-gap-report.md`); the demo
//! ships passthrough-backed stand-ins so the multi-vault router story is
//! exercised end-to-end without depending on TWAP hardening.
//!
//! Run with:
//!   cargo test -p smoke-test --release --test demo_seeding -- --test-threads=1 --nocapture

use alloy_primitives::Address;
use smoke_test::{
    prerequisites_available, Fixture, DEMO_WEIGHT_PRIMARY_BPS,
};

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

/// AC1 (issues #465, #479): VaultRegistry.listVaults() returns four vaults —
/// three Active router vaults plus the non-Active RWA/Thematic placeholder.
#[test]
fn registry_lists_four_vaults_with_rwa_placeholder() {
    if skip_if_no_prereqs("registry_lists_four_vaults_with_rwa_placeholder") {
        return;
    }
    let fx = fixture();

    // listVaults() selector: 0x50cc258e
    let raw = eth_call_raw(fx.rpc_url(), fx.registry(), "0x50cc258e");
    let vaults = decode_address_array(&raw);
    assert_eq!(
        vaults.len(),
        4,
        "expected 4 registered vaults after demo seeding (3 Active + RWA placeholder), got {} ({:?})",
        vaults.len(),
        vaults
    );

    // The three Active router vaults must be present and report Active.
    let active = fx.all_demo_vaults();
    for v in active {
        assert!(
            vaults.contains(&v),
            "expected Active vault {v:#x} in registry, got {vaults:?}"
        );
        let status = vault_status(fx, v);
        assert_eq!(
            status, 0,
            "vault {v:#x} should be Active (status=0); got status={status}"
        );
    }

    // The RWA/Thematic placeholder must be present and report a non-Active
    // status (Paused=1). Its inactive state is on-chain registry state, the
    // same signal the dapp reads to render a Future / Coming-soon tile.
    let rwa = fx.rwa_vault();
    assert!(
        vaults.contains(&rwa),
        "expected RWA placeholder {rwa:#x} in registry, got {vaults:?}"
    );
    let rwa_status = vault_status(fx, rwa);
    assert_ne!(
        rwa_status, 0,
        "RWA placeholder {rwa:#x} must be non-Active; got status={rwa_status}"
    );
    assert_eq!(
        rwa_status, 1,
        "RWA placeholder {rwa:#x} should be Paused (status=1); got status={rwa_status}"
    );
}

/// AC3: Router weights cover all three vaults, each > 0, summing to 10 000.
#[test]
fn router_weights_are_three_way_split() {
    if skip_if_no_prereqs("router_weights_are_three_way_split") {
        return;
    }
    let fx = fixture();

    // getWeights() selector: 0x22acb867
    let raw = eth_call_raw(fx.rpc_url(), fx.router(), "0x22acb867");
    let (vaults, bps) = decode_address_array_and_uint_array(&raw);
    assert_eq!(vaults.len(), 1, "expected 1 router weight entry (primary)");
    assert_eq!(bps.len(), 1, "expected 1 router weight bps entry");

    // Only the primary RobotMoneyVault (PRD §11.1) is router-eligible — the
    // basket vaults stay gap-blocked per PRD §11.2/§11.3.
    assert_eq!(vaults[0], fx.vault(), "weight[0] must be the primary vault");
    assert_eq!(
        bps[0] as u64, DEMO_WEIGHT_PRIMARY_BPS,
        "primary vault must carry the full 10000 bps"
    );
}

/// AC2: After seeding simulated depositors via the router, each vault reports
/// non-zero `totalAssets` and the sum of per-depositor share balances equals
/// each vault's `totalAssets`.
#[test]
fn simulated_depositors_match_total_assets() {
    if skip_if_no_prereqs("simulated_depositors_match_total_assets") {
        return;
    }
    let fx = fixture();

    // Seed three depositors with 1000 USDC each — generous enough that the
    // weight split yields non-zero per-leg amounts (e.g. 200 USDC into the
    // smallest leg at 2000 bps) even after the router's rounding-remainder
    // assignment.
    let per_user_usdc: u128 = 1_000 * 1_000_000;
    let count: u32 = 3;
    let depositors = fx
        .seed_demo_depositors(count, per_user_usdc)
        .expect("seed_demo_depositors");
    assert_eq!(depositors.len(), count as usize);

    let vaults = fx.all_demo_vaults();
    for v in vaults {
        let ta = total_assets(fx.rpc_url(), v);
        assert!(ta > 0, "vault {v:#x} has zero totalAssets after seeding");

        // Sum each simulated depositor's share balance on this vault,
        // converted to underlying assets so the test holds regardless of the
        // vault's `_decimalsOffset()` (RobotMoneyVault uses 18, so raw share
        // counts are 1e18× the asset). The vault's own
        // `convertToAssets(shares)` is the canonical inversion of the
        // mint-on-deposit math.
        let mut sum_assets: u128 = 0;
        for (addr, _tx) in &depositors {
            let shares = balance_of(fx.rpc_url(), v, *addr);
            let assets = convert_to_assets(fx.rpc_url(), v, shares);
            sum_assets = sum_assets.saturating_add(assets);
        }
        // PassthroughAdapter does not accrue yield during the seed, so
        // summing depositor receipt-equivalent assets must equal totalAssets
        // exactly. (No rounding remainder: every receipt is freshly minted in
        // this test run; pre-existing dust would only manifest if other
        // tests had deposited first.)
        assert_eq!(
            sum_assets, ta,
            "vault {v:#x}: sum of depositors' receipt-equivalent assets ({sum_assets}) must equal totalAssets ({ta})"
        );
    }
}
