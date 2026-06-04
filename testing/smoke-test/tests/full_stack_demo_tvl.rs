//! Integration test: explorer API reports the four-vault real-TVL end state
//! after DappStack::boot.
//!
//! Boots the full compose stack (chain + dapp + explorer-api + indexer), then
//! polls GET /v1/vaults and asserts the four-vault real-TVL invariant the dapp
//! tiles depend on: **exactly four** vault entries (PRD §11.1–§11.4), each
//! **Active** (status == 0) and each reporting **non-zero** `total_assets`.
//! This exercises the automatic demo-depositor seeding added by issue #532 and
//! extended to all four vaults by issue #563: DappStack::boot calls
//! seed_demo_depositors so every vault's TVL is non-zero without any manual
//! follow-up command.
//!
//! Canonical docs: docs/prd.md, testing/smoke-test/src/lib.rs, issue #592.
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
    /// 0 = Active, 1 = Paused, 2 = Retired (matches on-chain VaultStatus enum).
    status: i16,
    total_assets: Option<String>,
}

impl VaultEntry {
    /// A vault entry satisfies the four-vault real-TVL invariant when it is
    /// Active and its latest snapshot carries a non-zero `total_assets`.
    fn is_active_with_nonzero_tvl(&self) -> bool {
        self.status == 0
            && self
                .total_assets
                .as_deref()
                .is_some_and(|s| s != "0" && !s.is_empty())
    }
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

/// After DappStack::boot, GET /v1/vaults must surface the four-vault real-TVL
/// end state (issue #592): **exactly four** vault entries (PRD §11.1–§11.4),
/// each **Active** (status == 0) and each with **non-zero** `total_assets`.
/// The seeding is automatic: DappStack::boot calls seed_demo_depositors
/// internally (issues #532, #563) so no manual step is needed.
///
/// The explorer-indexer writes vault_snapshot rows as it processes Deposit
/// events; total_assets is populated once the first snapshot lands. We give
/// the indexer up to 90 s to process the seed deposits across all four vaults
/// mined during boot — the four-vault end state needs one snapshot per vault,
/// so it lags a single-vault non-zero check.
#[test]
fn explorer_api_shows_four_active_nonzero_vaults_after_boot() {
    if skip_if_no_prereqs("explorer_api_shows_four_active_nonzero_vaults_after_boot") {
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

    // Poll for up to 90 s giving the indexer time to snapshot all four vaults.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
    let mut last_response: Option<VaultListResponse> = None;
    while std::time::Instant::now() < deadline {
        match fetch_vaults(explorer_api_url) {
            Ok(resp) => {
                let active_nonzero = resp
                    .vaults
                    .iter()
                    .filter(|v| v.is_active_with_nonzero_tvl())
                    .count();
                // Exactly four entries, all Active with non-zero TVL.
                if resp.vaults.len() == 4 && active_nonzero == 4 {
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
            format!(
                "{} entries: [{}]",
                r.vaults.len(),
                r.vaults
                    .iter()
                    .map(|v| format!("status={} total_assets={:?}", v.status, v.total_assets))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
        .unwrap_or_else(|| "no response received".to_string());

    panic!(
        "expected exactly four Active vaults each with total_assets > 0 after \
         DappStack::boot + 90s indexer wait, but got: {vaults_debug}"
    );
}
