//! Canonical: docs/walkthroughs/opencode-readonly-fork.md (issue #53),
//! step 3 (operator config template).
//!
//! Asserts that the `rmpc-fork.toml.template` shipped under
//! `fixtures/` deserializes with the *real* `rmpc` config loader.
//! This guarantees the walkthrough's TOML block does not drift from
//! the loader's accepted field set (which is `deny_unknown_fields` —
//! a stale field would error here).

use std::fs;

use opencode_walkthrough_tests::{config_template_path, walkthrough_md};
use rust_payment_client::config::Config;

#[test]
fn fixture_parses_with_rmpc_config_loader() {
    let path = config_template_path();
    let raw = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read template {}: {e}", path.display()));
    let cfg = Config::from_str(&raw)
        .unwrap_or_else(|e| panic!("rmpc config loader rejected the walkthrough template: {e}"));

    // Spot-check the fields the walkthrough story depends on.
    assert_eq!(
        cfg.chain_id, 8453,
        "walkthrough targets Base mainnet (8453)"
    );
    assert!(
        cfg.signer.allow_software_fallback,
        "fork-only walkthrough requires software fallback to be enabled"
    );
    assert!(
        cfg.rpc_url.starts_with("http://127.0.0.1") || cfg.rpc_url.starts_with("http://localhost"),
        "walkthrough config must point at a local anvil fork; got {}",
        cfg.rpc_url
    );
}

#[test]
fn walkthrough_doc_quotes_the_template_body() {
    // Defends against the doc and the fixture diverging silently:
    // the walkthrough's step-3 TOML block must contain the same
    // critical lines the fixture defines.
    let template = fs::read_to_string(config_template_path()).expect("read template");
    let doc = fs::read_to_string(walkthrough_md()).expect("read walkthrough");

    for needle in [
        "chain_id              = 8453",
        "rpc_url               = \"http://127.0.0.1:8545\"",
        "allow_software_fallback = true",
    ] {
        assert!(
            template.contains(needle),
            "fixture template missing canonical line: {needle}"
        );
        assert!(
            doc.contains(needle),
            "walkthrough doc missing canonical line: {needle} \
             (drift between docs/walkthroughs/opencode-readonly-fork.md and \
             testing/opencode-walkthrough/fixtures/rmpc-fork.toml.template)"
        );
    }
}
