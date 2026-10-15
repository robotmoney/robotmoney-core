//! Canonical: docs/architecture.md §5.2 — Agent Permissions Gateway (agent consent)
//! Implements: issue #1791 — `rmpc agent-consent`
//!
//! `rmpc agent-consent` signs the gateway's EIP-712 `AgentConsent` with the
//! agent keystore. These tests drive the real binary against a mockito
//! JSON-RPC server:
//!
//! - `agent_consent_signs_the_golden_vector`: the agent key of the golden
//!   vector (anvil #1) at nonce 3 on chain 8453, gateway 0x…0b00, prints the
//!   digest and the `r ‖ s ‖ v` signature `cast wallet sign --data` makes for
//!   the same typed data, and reads the nonce from the gateway.
//! - `agent_consent_refuses_a_chain_id_mismatch`: the domain binds the chain
//!   id, so an RPC serving another chain is refused before anything is
//!   signed.

mod common;

use crate::common::{
    abi_addr_hex, enc_address, enc_u256, jrpc_result, match_eth_call_selector_with_first_arg,
    selector_hex_of, GATEWAY, TEST_PASSPHRASE,
};
use alloy_primitives::{address, hex as ahex, keccak256, Address, U256};
use assert_cmd::Command;
use mockito::Matcher;
use rust_payment_client::gateway::RobotMoneyGateway;
use rust_payment_client::signer::software::{SoftwareSigner, PASSPHRASE_ENV_VAR};
use serde_json::{json, Value};
use std::path::PathBuf;
use tempfile::TempDir;

/// Anvil account #1 — the agent of the golden vector.
const AGENT_PRIVKEY_HEX: &str = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const AGENT: Address = address!("70997970C51812dc3A010C7d01b50e0d17dc79C8");
/// Anvil account #2 — the depositor that will reveal.
const OWNER: Address = address!("3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");

const GOLDEN_DIGEST: &str = "0x3ac1860ad8706f9a902e92d0657147f83d27f3a7c64bd38132d667196db1cdbf";
const GOLDEN_SIGNATURE: &str = "0xe38b75ee922654c47fc343bb040b28fa809f2302b4e05f99fd2090da06f897ff5d60b64ba17d2729dd8df7d7e15f7fec9059d8dcba7ffba665dc5d24924d8fb51b";

struct ConsentFixture {
    _tmp: TempDir,
    config_path: PathBuf,
}

impl ConsentFixture {
    fn build(rpc_url: &str, chain_id: u64) -> Self {
        let tmp = TempDir::new().expect("tempdir");
        let keystore_path = tmp.path().join("agent.keystore.json");
        let key: [u8; 32] = ahex::decode(AGENT_PRIVKEY_HEX).unwrap().try_into().unwrap();
        SoftwareSigner::create_keystore(&keystore_path, &key, TEST_PASSPHRASE)
            .expect("create keystore");
        let runtime_hash = format!("0x{}", ahex::encode(keccak256(common::GATEWAY_CODE)));
        let config_path = tmp.path().join("rmpc.toml");
        std::fs::write(
            &config_path,
            format!(
                r#"chain_id              = {chain_id}
rpc_url               = "{rpc_url}"
gateway_address       = "{GATEWAY:#x}"
usdc_address          = "0x0000000000000000000000000000000000000c00"
vault_address         = "0x0000000000000000000000000000000000000d00"
gateway_runtime_hash  = "{runtime_hash}"

[signer]
allow_software_fallback = true
keystore_path           = "{ks}"
"#,
                ks = keystore_path.display()
            ),
        )
        .expect("write config");
        Self {
            _tmp: tmp,
            config_path,
        }
    }

    fn run(&self) -> std::process::Output {
        Command::cargo_bin("rmpc")
            .expect("rmpc binary built")
            .env(
                PASSPHRASE_ENV_VAR,
                std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
            )
            .args([
                "agent-consent",
                "--config",
                self.config_path.to_str().unwrap(),
                "--owner",
                &format!("{OWNER:#x}"),
            ])
            .output()
            .expect("rmpc ran")
    }
}

async fn mock_method(server: &mut mockito::Server, method: &str, result: &str) -> mockito::Mock {
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": method})))
        .with_status(200)
        .with_body(jrpc_result(result))
        .create_async()
        .await
}

#[tokio::test]
async fn agent_consent_signs_the_golden_vector() {
    let mut server = mockito::Server::new_async().await;
    let _chain = mock_method(&mut server, "eth_chainId", "0x2105").await;
    let _block = mock_method(&mut server, "eth_blockNumber", "0x64").await;
    let nonce = server
        .mock("POST", "/")
        .match_body(match_eth_call_selector_with_first_arg(
            &selector_hex_of::<RobotMoneyGateway::agentConsentNonceCall>(),
            &abi_addr_hex(AGENT),
        ))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(U256::from(3u64))))
        .expect(1)
        .create_async()
        .await;
    let owner = server
        .mock("POST", "/")
        .match_body(match_eth_call_selector_with_first_arg(
            &selector_hex_of::<RobotMoneyGateway::agentOwnerCall>(),
            &abi_addr_hex(AGENT),
        ))
        .with_status(200)
        .with_body(jrpc_result(&enc_address(Address::ZERO)))
        .expect(1)
        .create_async()
        .await;

    let fix = ConsentFixture::build(&server.url(), 8453);
    let out = fix.run();
    assert_eq!(
        out.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    nonce.assert_async().await;
    owner.assert_async().await;

    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["ok"], true);
    assert_eq!(v["action"], "agent-consent");
    assert_eq!(v["agent"], format!("{AGENT:#x}"));
    assert_eq!(v["owner"], format!("{OWNER:#x}"));
    assert_eq!(v["share_receiver"], format!("{OWNER:#x}"));
    assert_eq!(v["nonce"], "3");
    assert_eq!(v["chain_id"], 8453);
    assert_eq!(v["gateway"], format!("{GATEWAY:#x}"));
    assert_eq!(v["block_number"], 100);
    assert!(v["current_owner"].is_null());
    assert_eq!(v["digest"], GOLDEN_DIGEST);
    assert_eq!(v["signature"], GOLDEN_SIGNATURE);
}

#[tokio::test]
async fn agent_consent_refuses_a_chain_id_mismatch() {
    let mut server = mockito::Server::new_async().await;
    // The RPC serves Base Sepolia while the config says Base.
    let _chain = mock_method(&mut server, "eth_chainId", "0x14a34").await;
    let no_reads = server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_call"})))
        .expect(0)
        .create_async()
        .await;

    let fix = ConsentFixture::build(&server.url(), 8453);
    let out = fix.run();
    assert_eq!(out.status.code(), Some(2));
    no_reads.assert_async().await;
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["ok"], false);
    assert_eq!(v["error"], "ErrChainIdMismatch");
    assert!(v.get("signature").is_none());
}
