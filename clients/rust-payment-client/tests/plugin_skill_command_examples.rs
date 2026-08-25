//! Parser conformance for executable `rmpc` examples published in plugin skills.
//!
//! The Swarm skill's two vote-submit examples deliberately use concrete values
//! here so clap parses the same argument order and flags an operator receives,
//! without loading a config or sending an on-chain transaction.

use clap::Parser;
use rust_payment_client::cli::Cli;

const VOTE_SUBMIT_EXAMPLE: &[&str] = &[
    "rmpc",
    "committee",
    "--config",
    "rmpc.toml",
    "vote-submit",
    "--vault",
    "0x1111111111111111111111111111111111111111",
    "--stance",
    "overweight",
    "--weight-bps",
    "6000",
    "--confidence",
    "70",
    "--rationale-uri",
    "https://example.test/rationale",
    "--vote-json-hash",
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "--prompt-hash",
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "--inputs-digest",
    "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "--timestamp",
    "1735689600",
    "--order-id",
    "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    "--pretty",
];

#[test]
fn swarm_skill_workflow_vote_submit_example_parses() {
    Cli::try_parse_from(VOTE_SUBMIT_EXAMPLE)
        .expect("the Swarm workflow vote-submit example must parse");
}

#[test]
fn swarm_skill_reference_vote_submit_example_parses() {
    Cli::try_parse_from(VOTE_SUBMIT_EXAMPLE)
        .expect("the Swarm reference vote-submit example must parse");
}

#[test]
fn swarm_skill_rejects_the_previously_documented_weight_flag() {
    let mut invalid = VOTE_SUBMIT_EXAMPLE.to_vec();
    let flag = invalid
        .iter_mut()
        .find(|argument| **argument == "--weight-bps")
        .expect("example contains --weight-bps");
    *flag = "--target-weight-bps";

    let error = Cli::try_parse_from(invalid).expect_err("stale flag must fail clap parsing");
    assert!(
        error.to_string().contains("--target-weight-bps"),
        "unexpected clap error: {error}"
    );
}
