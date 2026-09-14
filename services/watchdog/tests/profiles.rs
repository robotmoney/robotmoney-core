//! The committed watchdog profiles parse, and say what their headers claim.
//!
//! No Docker, no network: these assert on the files themselves, which are what
//! a staging deployment actually mounts.
//!
//! Task R8 / correction C-14: `config.staging-acceptance.toml` is the profile
//! whose receipt-liveness cadence is short enough to prove alert → anchor →
//! resolve inside one acceptance window. It is a *candidate* profile, never an
//! edit to the pinned `config.staging.toml`, and this test is what keeps the
//! two from drifting into each other.

use std::path::Path;
use watchdog::config::Config;

fn load(name: &str) -> Config {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(name);
    Config::from_file(&path).unwrap_or_else(|e| panic!("{name} must parse and validate: {e}"))
}

#[test]
fn the_pinned_staging_profile_still_carries_the_production_cadence() {
    let c = load("config.staging.toml");
    assert_eq!(c.chain_id, Some(918_453), "Fusion devnet");
    assert!(c.consensus_receipts.enabled);
    assert_eq!(c.consensus_receipts.expected_cadence_secs, 86_400);
    assert_eq!(c.consensus_receipts.grace_secs, 21_600);
    assert_eq!(
        c.consensus_receipts.budget_secs(),
        108_000,
        "a 30-hour budget: no acceptance run can wait this out, which is why \
         the acceptance profile exists"
    );
}

#[test]
fn the_acceptance_profile_can_be_exercised_inside_one_run() {
    let c = load("config.staging-acceptance.toml");
    let budget = c.consensus_receipts.budget_secs();
    assert!(c.consensus_receipts.enabled);
    assert!(
        budget <= 900,
        "the acceptance profile's budget is {budget}s; it must be short enough \
         for one recorded step to observe the gap open AND close"
    );
    assert!(
        budget >= 60,
        "a budget under a minute pages on chain latency rather than on a \
         missing receipt"
    );
}

#[test]
fn the_acceptance_profile_differs_from_the_pinned_one_only_in_cadence() {
    let pinned = load("config.staging.toml");
    let acceptance = load("config.staging-acceptance.toml");

    assert_eq!(acceptance.chain_id, pinned.chain_id);
    assert_eq!(
        acceptance.sla.max_response_secs,
        pinned.sla.max_response_secs
    );
    assert_eq!(acceptance.action.mode, pinned.action.mode);
    assert_eq!(acceptance.action.webhook_url, pinned.action.webhook_url);
    assert_eq!(
        acceptance.global.per_block_mint_limit_usdc,
        pinned.global.per_block_mint_limit_usdc
    );
    assert_eq!(
        acceptance.global.per_hour_mint_limit_usdc,
        pinned.global.per_hour_mint_limit_usdc
    );
    assert_eq!(
        acceptance.global.per_block_burn_limit_usdc,
        pinned.global.per_block_burn_limit_usdc
    );
    assert_eq!(
        acceptance.global.per_hour_burn_limit_usdc,
        pinned.global.per_hour_burn_limit_usdc
    );
    assert!(
        acceptance.consensus_receipts.budget_secs() < pinned.consensus_receipts.budget_secs(),
        "the one intended difference"
    );
}

#[test]
fn the_acceptance_profile_header_declares_itself_as_the_acceptance_profile() {
    // Correction C-14: an acceptance-only profile that does not say so in its
    // own header is one `scp` away from becoming the standing configuration.
    let text = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("config.staging-acceptance.toml"),
    )
    .expect("read acceptance profile");
    let header: String = text
        .lines()
        .take_while(|l| l.starts_with('#') || l.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        header.contains("ACCEPTANCE PROFILE"),
        "the header must name this an acceptance profile"
    );
    assert!(
        header.contains("config.staging.toml"),
        "the header must name the pinned profile it does NOT replace"
    );
    assert!(
        header.contains("R8"),
        "the header must cite the task that authorises it"
    );
}

#[test]
fn an_enabled_quorum_check_without_a_router_address_is_refused_at_startup() {
    // The acceptance profile ships `[governance] enabled = false` with the
    // address left for the Deploy phase. Flipping `enabled` without supplying
    // the address must fail loudly rather than run a blind check.
    let text = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("config.staging-acceptance.toml"),
    )
    .expect("read acceptance profile");
    let flipped = text.replace("enabled = false", "enabled = true");
    let cfg: Config = toml::from_str(&flipped).expect("parses");
    let err = cfg
        .validate()
        .expect_err("an enabled quorum check with no router address must be refused");
    assert!(
        format!("{err}").contains("router_address"),
        "unexpected error: {err}"
    );
}
