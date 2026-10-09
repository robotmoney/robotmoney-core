//! The govern stdout contract between the publish-contracts CLI (`publish-contracts/` in this repo) (producer) and this harness (consumer).
//!
//! `tests/fixtures/govern-stdout.jsonl` is a recorded sample of what `publish-contracts govern` prints on stdout:
//! one JSON line per round event, `{"row":..,"phase":..,"txHash":..,"status":..,"readyAt":..}`. The same file lives at
//! `publish-contracts/tests/fixtures/govern-stdout.jsonl`, where a contract test asserts the CLI prints exactly it.
//! This test feeds it to `parse_govern_output` and `check_govern_rows`. No docker, no chain, no network.

use smoke_test::publish::{check_govern_rows, parse_govern_output};

const SAMPLE: &str = include_str!("fixtures/govern-stdout.jsonl");

// One entry per round event, in the order the CLI prints them. The default stage sheet unpauses PROTO and RWA: both unpauses are scheduled in one
// sitting (both `scheduled` lines first), then both `executed` lines, then the Twin-only rounds one at a time (`scheduled`, then `executed` or `cancelled`).
const ROWS: [&str; 10] = [
    "unpause-PROTO",
    "unpause-RWA",
    "unpause-PROTO",
    "unpause-RWA",
    "update-delay",
    "update-delay",
    "batch",
    "batch",
    "cancel",
    "cancel",
];

#[test]
fn the_recorded_govern_stdout_parses_into_one_row_per_line() {
    let rows = parse_govern_output(SAMPLE).expect("the sample has row lines");
    let names: Vec<&str> = rows.iter().map(|r| r.row.as_str()).collect();
    assert_eq!(names, ROWS);
    for r in &rows {
        assert_eq!(r.status, 1, "row {} status", r.row);
        assert_eq!(r.tx_hash.len(), 66, "row {} tx hash", r.row);
    }
}

#[test]
fn every_row_of_the_sample_passes_the_harness_check() {
    let rows = parse_govern_output(SAMPLE).unwrap();
    check_govern_rows(&rows).expect("a 32-byte tx hash and receipt status 1 on every row");
}

#[test]
fn log_noise_around_the_rows_is_ignored() {
    let noisy = format!("some banner\n{SAMPLE}[publish] done\n");
    let rows = parse_govern_output(&noisy).unwrap();
    assert_eq!(rows.len(), ROWS.len());
}

#[test]
fn a_reverted_row_fails_the_check_and_names_the_row() {
    let bad = SAMPLE.replacen("\"status\":1", "\"status\":0", 1);
    let rows = parse_govern_output(&bad).unwrap();
    let err = check_govern_rows(&rows).unwrap_err().to_string();
    assert!(err.contains("unpause-PROTO"), "{err}");
    assert!(err.contains("status is 0"), "{err}");
}

#[test]
fn output_with_no_row_lines_is_an_error() {
    assert!(parse_govern_output("{\"event\":\"run.done\"}\nplain text\n").is_err());
}
