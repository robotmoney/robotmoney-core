//! Canonical: docs/walkthroughs/opencode-readonly-fork.md (issue #53).
//!
//! Mirror of `clients/rust-payment-client/tests/skill_docs_parity.rs`
//! (issue #52, PR #72), narrowed to the OpenCode walkthrough doc.
//!
//! Three groups of asserts:
//!
//! 1. Every `rmpc <subcommand>` token mentioned in formatted code
//!    (fenced blocks or inline backticks) inside the walkthrough must
//!    exist in the actual `rmpc --help` output.
//! 2. Every `--flag` token mentioned in formatted code inside the
//!    walkthrough must exist on some `rmpc` subcommand's `--help`.
//! 3. The walkthrough must reference the skill package at
//!    `plugins/robotmoney-cli/`, and every relative-path file it links
//!    to must exist on disk.

use std::collections::BTreeSet;
use std::fs;

use doctests::opencode::{rmpc_help, walkthrough_md};
use test_utils::find_workspace_root;

/// Read the walkthrough doc as a single string.
fn doc_text() -> String {
    let path = walkthrough_md();
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// Yield every backtick-delimited inline code span and every fenced
/// code block body. (Same algorithm as `skill_docs_parity.rs`.)
fn code_spans(text: &str) -> Vec<String> {
    let mut spans: Vec<String> = Vec::new();
    let mut in_fence = false;
    let mut fence_buf = String::new();
    let mut prose_for_inline = String::new();
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            if in_fence {
                spans.push(std::mem::take(&mut fence_buf));
                in_fence = false;
            } else {
                in_fence = true;
            }
            continue;
        }
        if in_fence {
            fence_buf.push_str(line);
            fence_buf.push('\n');
        } else {
            prose_for_inline.push_str(line);
            prose_for_inline.push('\n');
        }
    }
    let mut chars = prose_for_inline.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '`' {
            continue;
        }
        let mut buf = String::new();
        for ch in chars.by_ref() {
            if ch == '`' {
                break;
            }
            buf.push(ch);
        }
        if !buf.is_empty() {
            spans.push(buf);
        }
    }
    spans
}

/// Subcommand list from `rmpc --help`.
fn rmpc_subcommands() -> BTreeSet<String> {
    let help = rmpc_help(&[]);
    let mut in_commands = false;
    let mut out: BTreeSet<String> = BTreeSet::new();
    for line in help.lines() {
        let trimmed = line.trim_end();
        if trimmed.starts_with("Commands:") {
            in_commands = true;
            continue;
        }
        if !in_commands {
            continue;
        }
        if trimmed.is_empty() {
            if !out.is_empty() {
                break;
            }
            continue;
        }
        if !line.starts_with("  ") {
            break;
        }
        let name = line.split_whitespace().next().unwrap_or("");
        if name.is_empty() || name == "help" {
            continue;
        }
        out.insert(name.to_string());
    }
    assert!(
        !out.is_empty(),
        "could not parse subcommand list from `rmpc --help`:\n{help}"
    );
    out
}

/// Long-flag tokens appearing in a subcommand's `--help` body.
fn rmpc_subcommand_flags(sub: &str) -> BTreeSet<String> {
    let help = rmpc_help(&[sub]);
    let mut flags = BTreeSet::new();
    for tok in help.split(|c: char| !(c.is_alphanumeric() || c == '-' || c == '_')) {
        if let Some(rest) = tok.strip_prefix("--") {
            if rest.is_empty() {
                continue;
            }
            let valid = rest
                .chars()
                .next()
                .map(|c| c.is_ascii_lowercase())
                .unwrap_or(false)
                && rest
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
            if valid {
                flags.insert(format!("--{rest}"));
            }
        }
    }
    flags
}

/// Extract `rmpc <subcommand>` references from formatted code in the
/// walkthrough.
fn documented_subcommands(text: &str) -> BTreeSet<String> {
    let mut out: BTreeSet<String> = BTreeSet::new();
    for span in code_spans(text) {
        let words: Vec<&str> = span.split_whitespace().collect();
        for win in words.windows(2) {
            if win[0] != "rmpc" {
                continue;
            }
            let next = win[1].trim_matches(|c: char| !(c.is_ascii_lowercase() || c == '-'));
            if next.is_empty() || next.starts_with('-') {
                continue;
            }
            if !next.chars().all(|c| c.is_ascii_lowercase() || c == '-') {
                continue;
            }
            out.insert(next.to_string());
        }
    }
    out
}

/// Extract `--flag` tokens from formatted code in the walkthrough.
fn documented_flags(text: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let joined: String = code_spans(text).join(" ");
    for tok in joined.split(|c: char| c.is_whitespace() || ",()[]{}*\"".contains(c)) {
        if let Some(rest) = tok.strip_prefix("--") {
            let trimmed = rest.trim_end_matches(|c: char| !(c.is_ascii_alphanumeric() || c == '-'));
            if trimmed.is_empty() {
                continue;
            }
            if !trimmed
                .chars()
                .next()
                .map(|c| c.is_ascii_lowercase())
                .unwrap_or(false)
            {
                continue;
            }
            if !trimmed
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            {
                continue;
            }
            out.insert(format!("--{trimmed}"));
        }
    }
    out
}

#[test]
fn every_documented_subcommand_exists_in_rmpc_help() {
    let text = doc_text();
    let actual = rmpc_subcommands();
    let documented = documented_subcommands(&text);

    // The walkthrough intentionally documents an *unknown* subcommand
    // to demonstrate the refusal envelope ("not-a-real-subcommand").
    // It also uses meta-tokens like `rmpc <sub>` in prose explaining
    // the parity rule itself. Allowlist those so the parity check
    // still fires for any other typo.
    let allow_unknown: BTreeSet<&str> = [
        "not-a-real-subcommand", // step 6 refusal demo
        "sub",                   // meta-reference inside `rmpc <sub>`
        "subcommand",            // meta-reference inside `rmpc <subcommand>`
    ]
    .into_iter()
    .collect();

    let missing: Vec<&String> = documented
        .iter()
        .filter(|s| !actual.contains(*s) && !allow_unknown.contains(s.as_str()))
        .collect();
    assert!(
        missing.is_empty(),
        "walkthrough references rmpc subcommands not in `rmpc --help`: {:?}\n\
         actual rmpc subcommands: {:?}",
        missing,
        actual,
    );
}

#[test]
fn every_documented_flag_exists_on_some_rmpc_subcommand() {
    let text = doc_text();

    // Build the union of top-level flags + per-subcommand flags.
    let mut union: BTreeSet<String> = BTreeSet::new();
    {
        let help = rmpc_help(&[]);
        for tok in help.split(|c: char| !(c.is_alphanumeric() || c == '-' || c == '_')) {
            if let Some(rest) = tok.strip_prefix("--") {
                if rest.is_empty() {
                    continue;
                }
                let valid = rest
                    .chars()
                    .next()
                    .map(|c| c.is_ascii_lowercase())
                    .unwrap_or(false)
                    && rest
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
                if valid {
                    union.insert(format!("--{rest}"));
                }
            }
        }
    }
    for sub in rmpc_subcommands() {
        union.extend(rmpc_subcommand_flags(&sub));
    }
    union.insert("--help".into());
    union.insert("--version".into());

    // Tool flags that legitimately appear in the walkthrough but belong
    // to OpenCode/anvil/foundry, not to rmpc. Allowlist them — the
    // parity check is about rmpc surface drift, not about every tool
    // mentioned in the doc.
    let foreign_flags: BTreeSet<&str> = [
        "--plugin",        // opencode flag
        "--fork-url",      // anvil flag
        "--port",          // anvil flag
        "--silent",        // anvil flag
        "--release",       // cargo flag
        "--bin",           // cargo flag
        "--manifest-path", // cargo flag
        "--version",       // generic; included in union anyway
        "--flag",          // meta-reference inside the parity-rule prose
    ]
    .into_iter()
    .collect();

    let documented = documented_flags(&text);
    let missing: Vec<&String> = documented
        .iter()
        .filter(|f| !union.contains(*f) && !foreign_flags.contains(f.as_str()))
        .collect();
    assert!(
        missing.is_empty(),
        "walkthrough references --flags not exposed by any rmpc subcommand: {:?}\n\
         union of rmpc flags: {:?}",
        missing,
        union,
    );
}

#[test]
fn skill_package_referenced_and_files_exist() {
    let text = doc_text();
    assert!(
        text.contains("plugins/robotmoney-cli/"),
        "walkthrough must reference plugins/robotmoney-cli/"
    );

    // Pull every `plugins/robotmoney-cli/...` and `testing/...` path
    // mention out of the doc text and assert each exists on disk.
    let cleaned = text.replace('`', "");
    let mut paths: BTreeSet<String> = BTreeSet::new();
    for tok in cleaned.split(|c: char| c.is_whitespace() || "()[]<>".contains(c)) {
        let stripped = tok.trim_end_matches(|c: char| ".,;:!?\"'".contains(c));
        for prefix in ["plugins/robotmoney-cli/", "testing/doctests/"] {
            if let Some(_rest) = stripped.strip_prefix(prefix) {
                if stripped.contains('.') || stripped.ends_with('/') {
                    paths.insert(stripped.to_string());
                }
            }
        }
    }
    assert!(
        !paths.is_empty(),
        "walkthrough must reference at least one concrete plugin or test file path"
    );
    let root = find_workspace_root().expect("workspace root");
    for p in &paths {
        let on_disk = root.join(p);
        assert!(
            on_disk.exists(),
            "walkthrough references {p} but {} does not exist",
            on_disk.display()
        );
    }
}

#[test]
fn walkthrough_links_implementation_plan_section_10() {
    let text = doc_text();
    assert!(
        text.contains("docs/implementation-plan.md") && text.contains("§10"),
        "walkthrough must back-link to docs/implementation-plan.md §10 \
         (the canonical Phase 4 doc this work implements)"
    );
}
