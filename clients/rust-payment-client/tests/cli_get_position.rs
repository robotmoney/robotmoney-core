//! Canonical: lucky-tensor/robotmoney-monorepo#109 — Architecture §5.1
//! Account-scope vault position reads.
//!
//! Fixture-based integration tests for `rmpc get-position --address <addr>`
//! (issue #666), consistent with the existing mockito CI pattern used by
//! `cli_get_vaults.rs`.

mod common;

use crate::common::{
    enc_u256, jrpc_result, match_eth_call_selector, selector_hex_of, GATEWAY, GATEWAY_CODE,
    TEST_PASSPHRASE, USDC, VAULT,
};
use alloy_primitives::{address, hex as ahex, keccak256, Address, U256};
use assert_cmd::Command;
use mockito::Matcher;
use rust_payment_client::gateway::{MockVault, VaultRegistry};
use rust_payment_client::signer::software::SoftwareSigner;
use serde_json::{json, Value};
use std::path::PathBuf;
use tempfile::TempDir;

/// A registry address constant for tests.
const REGISTRY: Address = address!("0000000000000000000000000000000000000e00");

/// The seeded holder address whose positions the tests query.
const HOLDER: Address = address!("00000000000000000000000000000000000000aa");

fn rmpc() -> Command {
    Command::cargo_bin("rmpc").expect("rmpc binary built")
}

/// Fixture that includes a `registry_address` in the TOML config.
struct RegistryFixture {
    _tmp: TempDir,
    pub config_path: PathBuf,
}

impl RegistryFixture {
    fn build(rpc_url: &str, chain_id: u64) -> Self {
        let tmp = TempDir::new().expect("tempdir");
        let keystore_path = tmp.path().join("keystore.json");
        const TEST_PRIVKEY: [u8; 32] = [
            0xac, 0x09, 0x74, 0xbe, 0xc3, 0x9a, 0x17, 0xe3, 0x6b, 0xa4, 0xa6, 0xb4, 0xd2, 0x38,
            0xff, 0x94, 0x4b, 0xac, 0xb4, 0x78, 0xcb, 0xed, 0x5e, 0xfc, 0xae, 0x78, 0x4d, 0x7b,
            0xf4, 0xf2, 0xff, 0x80,
        ];
        SoftwareSigner::create_keystore(&keystore_path, &TEST_PRIVKEY, TEST_PASSPHRASE)
            .expect("create keystore");

        let runtime_hash = format!("0x{}", ahex::encode(keccak256(GATEWAY_CODE)));
        let config_path = tmp.path().join("rmpc.toml");
        let toml = format!(
            r#"chain_id              = {chain_id}
rpc_url               = "{rpc_url}"
gateway_address       = "{GATEWAY:#x}"
usdc_address          = "{USDC:#x}"
vault_address         = "{VAULT:#x}"
registry_address      = "{REGISTRY:#x}"
gateway_runtime_hash  = "{runtime_hash}"
max_fee_per_gas_cap   = 100000000000

[signer]
allow_software_fallback = true
keystore_path           = "{}"
"#,
            keystore_path.display(),
        );
        std::fs::write(&config_path, toml).expect("write config");
        Self {
            _tmp: tmp,
            config_path,
        }
    }
}

/// ABI-encode a `listVaults` return value (address[]).
fn enc_address_array(addrs: &[Address]) -> String {
    use alloy_sol_types::SolCall;
    let blob = VaultRegistry::listVaultsCall::abi_encode_returns(&(addrs.to_vec(),));
    format!("0x{}", ahex::encode(blob))
}

/// ABI-encode a `VaultRecord` tuple for mocking `getVault` returns.
fn enc_vault_record(vault: Address, receipt_token: Address) -> String {
    use alloy_sol_types::SolCall;
    let record = VaultRegistry::VaultRecord {
        vault,
        name: "RobotMoney USDC Vault".to_string(),
        riskLabel: "STABLE_YIELD".to_string(),
        mandate: "Deposit USDC, earn yield".to_string(),
        status: 0, // Active
        receiptToken: receipt_token,
        depositCap: U256::ZERO,
        exitFeeBps: 0,
        registeredAt: 1_700_000_000,
    };
    let blob = VaultRegistry::getVaultCall::abi_encode_returns(&(record,));
    format!("0x{}", ahex::encode(blob))
}

/// Mock the `eth_chainId` / `eth_blockNumber` preamble shared by all tests.
async fn mock_preamble(server: &mut mockito::ServerGuard, chain_id: u64, block_no: u64) {
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_chainId"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{chain_id:x}")))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_blockNumber"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{block_no:x}")))
        .expect_at_least(0)
        .create_async()
        .await;
}

/// Happy path — a seeded holder with a non-zero share balance in a known
/// vault. Asserts `vaults` is non-empty and `portfolio_total_usdc` is
/// non-zero (AC: fixture-based test for seeded position data), plus the
/// derived `vault_tvl_share_bps` and per-field decimal-string shapes.
#[tokio::test]
async fn get_position_seeded_address_returns_nonempty_position() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let block_no = 0x60u64;
    let balance = U256::from(500_000u64);
    let usdc_value = U256::from(1_000_000u64);
    let total_assets = U256::from(2_000_000u64);

    mock_preamble(&mut server, chain_id, block_no).await;
    // listVaults() → [VAULT]
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            VaultRegistry::listVaultsCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_address_array(&[VAULT])))
        .expect_at_least(0)
        .create_async()
        .await;
    // getVault(VAULT) → record with receiptToken == VAULT
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            VaultRegistry::getVaultCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_vault_record(VAULT, VAULT)))
        .expect_at_least(0)
        .create_async()
        .await;
    // vault.balanceOf(HOLDER) → 500_000 shares
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            MockVault::balanceOfCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(balance)))
        .expect_at_least(0)
        .create_async()
        .await;
    // vault.previewRedeem(500_000) → 1_000_000 USDC
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            MockVault::previewRedeemCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(usdc_value)))
        .expect_at_least(0)
        .create_async()
        .await;
    // vault.totalAssets() → 2_000_000
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            MockVault::totalAssetsCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(total_assets)))
        .expect_at_least(0)
        .create_async()
        .await;

    let fix = RegistryFixture::build(&server.url(), chain_id);
    let out = rmpc()
        .args([
            "get-position",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--address",
            &format!("{HOLDER:#x}"),
        ])
        .assert()
        .success()
        .get_output()
        .clone();

    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["chain_id"], chain_id);
    assert_eq!(v["block_number"], block_no);
    assert_eq!(v["source"], "json_rpc");
    assert_eq!(v["partial"], false, "all sub-reads succeed: {v}");
    assert!(v["errors"].as_array().unwrap().is_empty());

    let d = &v["data"];
    assert_eq!(
        d["address"].as_str().unwrap().to_lowercase(),
        format!("{HOLDER:#x}")
    );
    // AC: vaults array non-empty for a seeded address against a known vault.
    let vaults = d["vaults"].as_array().unwrap();
    assert_eq!(vaults.len(), 1, "expected one vault entry: {v}");
    let vault = &vaults[0];
    assert_eq!(
        vault["vault_address"].as_str().unwrap().to_lowercase(),
        format!("{VAULT:#x}")
    );
    assert_eq!(
        vault["receipt_token_address"]
            .as_str()
            .unwrap()
            .to_lowercase(),
        format!("{VAULT:#x}")
    );
    assert_eq!(vault["receipt_token_balance"].as_str().unwrap(), "500000");
    assert_eq!(vault["usdc_value"].as_str().unwrap(), "1000000");
    // 1_000_000 / 2_000_000 → 5000 bps
    assert_eq!(vault["vault_tvl_share_bps"], 5000);
    // AC: portfolio_total_usdc non-zero, equal to the sum of usdc_value fields.
    assert_eq!(d["portfolio_total_usdc"].as_str().unwrap(), "1000000");
}

/// Zero-balance holder: vaults array still enumerates the registered vault
/// with zeroed values; `previewRedeem` is never required; total is "0".
#[tokio::test]
async fn get_position_zero_balance_holder() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let block_no = 0x61u64;

    mock_preamble(&mut server, chain_id, block_no).await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            VaultRegistry::listVaultsCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_address_array(&[VAULT])))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            VaultRegistry::getVaultCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_vault_record(VAULT, VAULT)))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            MockVault::balanceOfCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(U256::ZERO)))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            MockVault::totalAssetsCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(U256::from(2_000_000u64))))
        .expect_at_least(0)
        .create_async()
        .await;

    let fix = RegistryFixture::build(&server.url(), chain_id);
    let out = rmpc()
        .args([
            "get-position",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--address",
            &format!("{HOLDER:#x}"),
        ])
        .assert()
        .success()
        .get_output()
        .clone();

    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["partial"], false);
    let vaults = v["data"]["vaults"].as_array().unwrap();
    assert_eq!(vaults.len(), 1);
    assert_eq!(vaults[0]["receipt_token_balance"].as_str().unwrap(), "0");
    assert_eq!(vaults[0]["usdc_value"].as_str().unwrap(), "0");
    assert_eq!(vaults[0]["vault_tvl_share_bps"], 0);
    assert_eq!(v["data"]["portfolio_total_usdc"].as_str().unwrap(), "0");
}

/// Degradation path: `previewRedeem` reverts → `partial: true` with a
/// `vaults[0].usdc_value` error entry, exit code still 0.
#[tokio::test]
async fn get_position_preview_redeem_failure_yields_partial_envelope() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let block_no = 0x62u64;

    mock_preamble(&mut server, chain_id, block_no).await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            VaultRegistry::listVaultsCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_address_array(&[VAULT])))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            VaultRegistry::getVaultCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_vault_record(VAULT, VAULT)))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            MockVault::balanceOfCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(U256::from(500_000u64))))
        .expect_at_least(0)
        .create_async()
        .await;
    // previewRedeem reverts.
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            MockVault::previewRedeemCall,
        >()))
        .with_status(200)
        .with_body(r#"{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted"}}"#)
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            MockVault::totalAssetsCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(U256::from(2_000_000u64))))
        .expect_at_least(0)
        .create_async()
        .await;

    let fix = RegistryFixture::build(&server.url(), chain_id);
    let out = rmpc()
        .args([
            "get-position",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--address",
            &format!("{HOLDER:#x}"),
        ])
        .assert()
        .success()
        .get_output()
        .clone();

    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["partial"], true, "previewRedeem failed: {v}");
    let errors = v["errors"].as_array().unwrap();
    assert!(
        errors
            .iter()
            .any(|e| e["field"].as_str().unwrap_or_default() == "vaults[0].usdc_value"),
        "expected vaults[0].usdc_value error entry: {v}"
    );
    // Failed sub-read degrades to zero; the vault entry is still present.
    let vaults = v["data"]["vaults"].as_array().unwrap();
    assert_eq!(vaults.len(), 1);
    assert_eq!(vaults[0]["usdc_value"].as_str().unwrap(), "0");
}

/// Malformed --address exits 2.
#[test]
fn get_position_malformed_address_exits_2() {
    let fix = RegistryFixture::build("http://127.0.0.1:1", 31337);
    rmpc()
        .args([
            "get-position",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--address",
            "not-an-address",
        ])
        .assert()
        .code(2);
}

/// Missing registry_address in config exits 3 before any RPC.
#[test]
fn get_position_without_registry_address_exits_3() {
    let tmp = TempDir::new().expect("tempdir");
    let cfg_path = tmp.path().join("rmpc.toml");
    let toml = format!(
        r#"chain_id              = 31337
rpc_url               = "http://127.0.0.1:1"
gateway_address       = "0x{gw}"
usdc_address          = "0x{usdc}"
vault_address         = "0x{vault}"
gateway_runtime_hash  = "0x{zeros}"
max_fee_per_gas_cap   = 100000000000

[signer]
allow_software_fallback = true
keystore_path           = "{ks}"
"#,
        gw = "00".repeat(20),
        usdc = "00".repeat(20),
        vault = "00".repeat(20),
        zeros = "0".repeat(64),
        ks = tmp.path().join("ks.json").display(),
    );
    std::fs::write(&cfg_path, &toml).expect("write config");
    rmpc()
        .args([
            "get-position",
            "--config",
            cfg_path.to_str().unwrap(),
            "--address",
            "0x0000000000000000000000000000000000000001",
        ])
        .assert()
        .code(3);
}

/// `rmpc get-position --help` exits 0 — the subcommand is registered.
#[test]
fn get_position_help_exits_zero() {
    rmpc().args(["get-position", "--help"]).assert().success();
}
