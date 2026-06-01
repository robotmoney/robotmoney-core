//! Integration test: explorer API reports non-zero vault TVL after DappStack::boot.
//!
//! Boots the full compose stack (chain + dapp + explorer-api + indexer), then
//! polls GET /v1/vaults and asserts that at least one vault reports
//! total_assets != "0". This exercises the automatic demo-depositor seeding
//! added by issue #532: DappStack::boot now calls seed_demo_depositors so the
//! vault TVL is non-zero without any manual follow-up command.
//!
//! Canonical docs: docs/prd.md, testing/smoke-test/src/lib.rs
//!
//! Run with:
//!   cargo test -p smoke-test --release --test full_stack_demo_tvl -- --test-threads=1 --nocapture

use smoke_test::{prerequisites_available, DappStack, DappStackOptions, Fixture, PublicEndpoints};

fn skip_if_no_prereqs(name: &str) -> bool {
    if !prerequisites_available() {
        eprintln!("[{name}] docker/forge/cast not on PATH; skipping.");
        return true;
    }
    false
}

/// Deserialise only the fields we care about from GET /v1/vaults.
#[derive(Debug, serde::Deserialize)]
struct VaultListResponse {
    vaults: Vec<VaultEntry>,
}

#[derive(Debug, serde::Deserialize)]
struct VaultEntry {
    total_assets: Option<String>,
}

/// Poll GET /v1/vaults on the explorer-api and return the response.
fn fetch_vaults(explorer_api_url: &str) -> Result<VaultListResponse, String> {
    let url = format!("{explorer_api_url}/v1/vaults");
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("reqwest builder: {e}"))?;
    let resp = client
        .get(&url)
        .send()
        .map_err(|e| format!("GET {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GET {url}: HTTP {}", resp.status()));
    }
    resp.json::<VaultListResponse>()
        .map_err(|e| format!("GET {url} json decode: {e}"))
}

/// After DappStack::boot, GET /v1/vaults must return at least one vault with
/// total_assets != "0". The seeding is automatic: DappStack::boot calls
/// seed_demo_depositors internally (issue #532) so no manual step is needed.
///
/// The explorer-indexer writes vault_snapshot rows as it processes Deposit
/// events; total_assets is populated once the first snapshot lands. We give
/// the indexer up to 60 s to process the seed deposits mined during boot.
#[test]
fn explorer_api_shows_nonzero_total_assets_after_boot() {
    if skip_if_no_prereqs("explorer_api_shows_nonzero_total_assets_after_boot") {
        return;
    }

    let fixture = Fixture::new().expect("fixture boot");
    let opts = DappStackOptions {
        dapp_port: None,
        explorer_api_port: None,
        public_endpoints: PublicEndpoints::Local,
    };
    let dapp = DappStack::boot(&fixture, opts).expect("DappStack::boot");

    let explorer_api_url = &dapp.endpoints.explorer_api_url;

    // Poll for up to 60 s giving the indexer time to process the seed deposits.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    let mut last_response: Option<VaultListResponse> = None;
    while std::time::Instant::now() < deadline {
        match fetch_vaults(explorer_api_url) {
            Ok(resp) => {
                let any_nonzero = resp.vaults.iter().any(|v| {
                    v.total_assets
                        .as_deref()
                        .is_some_and(|s| s != "0" && !s.is_empty())
                });
                if any_nonzero {
                    // Pass — at least one vault has non-zero TVL.
                    return;
                }
                last_response = Some(resp);
            }
            Err(e) => {
                eprintln!("full_stack_demo_tvl: poll error (will retry): {e}");
            }
        }
        std::thread::sleep(std::time::Duration::from_secs(3));
    }

    let vaults_debug = last_response
        .map(|r| {
            r.vaults
                .iter()
                .map(|v| format!("total_assets={:?}", v.total_assets))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_else(|| "no response received".to_string());

    panic!(
        "expected at least one vault with total_assets > 0 after DappStack::boot + 60s indexer wait, \
         but got: [{vaults_debug}]"
    );
}
