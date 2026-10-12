//! Pins the `unique_depositors` counting rule in `docs/explorer-api.md` (issue 1766).

const DOC: &str = include_str!("../../../docs/explorer-api.md");

#[test]
fn doc_states_the_unique_depositors_counting_rule() {
    for sentence in [
        "`unique_depositors` on `/v1/stats` is the number of distinct addresses that currently hold shares in any of the vaults",
        "The seed receiver counts while it holds the seed shares, and the deployer does not once it has redeemed.",
        "`UNIQUE_DEPOSITORS_SQL`",
    ] {
        assert!(DOC.contains(sentence), "docs/explorer-api.md lost: {sentence}");
    }
}
