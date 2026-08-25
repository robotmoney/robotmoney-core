//! Parser conformance for executable `rmpc` examples published in plugin skills.
//!
//! The Swarm skill's two vote-submit examples deliberately use concrete values
//! here so clap parses the same argument order and flags an operator receives,
//! without loading a config or sending an on-chain transaction.

use clap::Parser;
use rust_payment_client::cli::Cli;
use std::fs;
use std::path::{Path, PathBuf};

/// Repo root, located by walking up from `CARGO_MANIFEST_DIR` until we find
/// the shipped plugin directory next to `clients/`.
fn repo_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut cur: &Path = &manifest;
    loop {
        if cur.join("plugins").is_dir() && cur.join("clients").is_dir() {
            return cur.to_path_buf();
        }
        cur = cur.parent().expect(
            "walked past filesystem root without finding repo root \
             (expected sibling plugins/ and clients/ directories)",
        );
    }
}

fn swarm_skill() -> String {
    let path = repo_root().join("plugins/robotmoney-swarm/skills/robotmoney-swarm/SKILL.md");
    fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

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
    let documented = swarm_skill();
    assert_eq!(
        documented
            .matches("rmpc committee --config <CONFIG> vote-submit")
            .count(),
        2,
        "the Swarm skill must publish both vote-submit examples in parser-correct order"
    );
    assert!(
        documented.contains("--weight-bps <BPS>"),
        "the workflow example must use the real --weight-bps flag"
    );
    Cli::try_parse_from(VOTE_SUBMIT_EXAMPLE)
        .expect("the Swarm workflow vote-submit example must parse");
}

#[test]
fn swarm_skill_reference_vote_submit_example_parses() {
    let documented = swarm_skill();
    assert!(
        documented.contains("--weight-bps <0-10000>"),
        "the reference example must use the real --weight-bps flag"
    );
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

#[test]
fn swarm_skill_rejects_the_previously_documented_config_position() {
    let mut invalid = VOTE_SUBMIT_EXAMPLE.to_vec();
    let config_index = invalid
        .iter()
        .position(|argument| *argument == "--config")
        .expect("example contains --config");
    let config = invalid.remove(config_index);
    let config_path = invalid.remove(config_index);
    let vote_submit_index = invalid
        .iter()
        .position(|argument| *argument == "vote-submit")
        .expect("example contains vote-submit");
    invalid.insert(vote_submit_index + 1, config_path);
    invalid.insert(vote_submit_index + 1, config);

    let error =
        Cli::try_parse_from(invalid).expect_err("stale config position must fail clap parsing");
    assert!(
        error.to_string().contains("--config"),
        "unexpected clap error: {error}"
    );
}
