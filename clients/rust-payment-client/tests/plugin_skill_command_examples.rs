//! Parser conformance for every `rmpc` invocation published by a plugin skill.
//!
//! Canonical: issue #1203 — the Swarm skill shipped a `rmpc committee
//! vote-submit` example with a flag that does not exist (`--target-weight-bps`)
//! and a `--config` placed after the leaf subcommand, where the non-global
//! parent argument cannot be parsed. A skill is the only instruction surface an
//! onboarding agent has, so a command that does not parse fails silently from
//! the operator's point of view.
//!
//! This test binary is the executable guard against that whole class of drift.
//! It reads the shipped markdown under `plugins/**/skills/**.md`, harvests every
//! `rmpc` command line, and checks it against the real clap surface — the same
//! `Cli` the `rmpc` binary is built from — in one of two tiers:
//!
//!   * **Complete invocations** (a fenced shell example that is not elided with
//!     `...`) must `Cli::try_parse_from` successfully. This catches wrong flag
//!     names, wrong flag positions, wrong value types, and missing required
//!     arguments.
//!   * **Elided invocations and inline prose mentions** (`rmpc committee
//!     --config <CONFIG> register ...`, `` `rmpc status --payment-id <id>` ``)
//!     are incomplete by construction, so they cannot be parsed whole. Their
//!     subcommand path must still resolve and every flag they do name must exist
//!     on that path. This catches exactly the `--target-weight-bps` mistake
//!     wherever it hides in prose.
//!
//! No config is loaded and no transaction is signed — parsing is the entire
//! subject under test, so the binary needs neither a chain nor a fixture.
//!
//! Documentation placeholders (`<CONFIG>`, `<ADDR>`, `<0x...64hex>`) parse as-is
//! because the corresponding clap arguments are `String`/`PathBuf`. The handful
//! of numerically-typed arguments get a representative value substituted (see
//! `NUMERIC_PLACEHOLDER_VALUES`) — and only when the documented value is a
//! `<...>` placeholder, so a concrete literal in the docs is still type-checked.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use clap::{Arg, ArgAction, Command as ClapCommand, CommandFactory, Parser};
use rust_payment_client::cli::Cli;

/// Fenced blocks whose info string is one of these hold executable shell.
/// `text` blocks (the `rmpc --help` surface listing) and `json` blocks are
/// deliberately excluded — they are output, not invocations.
const SHELL_FENCE_LANGS: &[&str] = &["", "bash", "sh", "shell", "console"];

/// Arguments whose clap type is numeric. A `<PLACEHOLDER>` documented for one of
/// these is replaced with a representative in-range value before parsing;
/// everything else in the CLI takes a `String`/`PathBuf` and parses verbatim.
const NUMERIC_PLACEHOLDER_VALUES: &[(&str, &str)] = &[
    ("--weight-bps", "6000"),
    ("--weights-bps", "6000,4000"),
    ("--confidence", "70"),
    ("--timestamp", "1735689600"),
    ("--deadline-secs", "300"),
    ("--receipt-timeout-secs", "60"),
    ("--gas-limit", "500000"),
    ("--fee-cap", "1000000000"),
];

/// Flags clap injects at build time; `Cli::command()` is not built, so they are
/// not visible through `get_arguments()`.
const IMPLICIT_FLAGS: &[&str] = &["help", "version"];

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

fn swarm_skill_path() -> PathBuf {
    repo_root().join("plugins/robotmoney-swarm/skills/robotmoney-swarm/SKILL.md")
}

fn swarm_skill() -> String {
    let path = swarm_skill_path();
    fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

/// Every markdown file shipped under `plugins/`, sorted for a stable failure
/// order. All of them are skill documents (`SKILL.md` or a `references/*.md`
/// it links).
fn plugin_skill_markdown() -> Vec<PathBuf> {
    fn walk(dir: &Path, found: &mut Vec<PathBuf>) {
        let entries =
            fs::read_dir(dir).unwrap_or_else(|e| panic!("read_dir {}: {e}", dir.display()));
        for entry in entries {
            let path = entry.expect("directory entry").path();
            if path.is_dir() {
                walk(&path, found);
            } else if path.extension().is_some_and(|ext| ext == "md") {
                found.push(path);
            }
        }
    }

    let mut found = Vec::new();
    walk(&repo_root().join("plugins"), &mut found);
    found.sort();
    found
}

/// One `rmpc` command line harvested from a skill document.
#[derive(Debug)]
struct Invocation {
    /// Repo-relative path, for a failure message that names the file to fix.
    file: String,
    /// 1-based line where the command starts.
    line: usize,
    /// The original text, for the failure message.
    source: String,
    /// Normalized argv, placeholders substituted where the type demands it.
    argv: Vec<String>,
    /// True when the example is elided (`...`) or is an inline prose mention,
    /// so required arguments may legitimately be absent.
    partial: bool,
}

/// Join backslash continuations and the indented `-`/`[` continuation lines the
/// synopsis blocks in `references/commands.md` use, so one logical command is
/// one entry. Returns `(1-based start line, joined text)`.
fn logical_lines(block: &[(usize, &str)]) -> Vec<(usize, String)> {
    let mut out: Vec<(usize, String)> = Vec::new();
    let mut pending_backslash = false;

    for (line_number, raw) in block {
        let trimmed_end = raw.trim_end();
        let has_backslash = trimmed_end.ends_with('\\');
        let body = if has_backslash {
            trimmed_end[..trimmed_end.len() - 1].trim_end()
        } else {
            trimmed_end
        };
        let body = body.trim_start();
        let indented = raw.starts_with(' ') || raw.starts_with('\t');
        let continues_synopsis = indented && (body.starts_with('-') || body.starts_with('['));

        if !out.is_empty() && (pending_backslash || continues_synopsis) {
            let last = out.last_mut().expect("non-empty");
            last.1.push(' ');
            last.1.push_str(body);
        } else {
            out.push((*line_number, body.to_string()));
        }
        pending_backslash = has_backslash;
    }

    out
}

/// Strip the decorations documentation puts around a token: optional-argument
/// brackets, the parenthesis of an inline aside.
fn clean_token(token: &str) -> &str {
    token
        .trim_start_matches('(')
        .trim_start_matches('[')
        .trim_end_matches(')')
        .trim_end_matches(']')
}

/// Turn one text line into an argv, or `None` when the line names no command.
/// The second element is true when the example is elided with `...`.
fn parse_command_line(text: &str) -> Option<(Vec<String>, bool)> {
    let words: Vec<&str> = text.split_whitespace().collect();
    let start = words.iter().position(|word| clean_token(word) == "rmpc")?;
    // A shell comment that happens to mention rmpc is prose, not a command.
    if words[..start].iter().any(|word| word.starts_with('#')) {
        return None;
    }

    let mut argv: Vec<String> = Vec::new();
    let mut partial = false;
    for word in &words[start..] {
        // Stop at a shell operator: what follows is a different program.
        if matches!(*word, "|" | "&&" | "||" | ">" | ">>" | "2>" | ";") || word.starts_with('#') {
            break;
        }
        let token = clean_token(word);
        if token == "..." || token == "…" {
            partial = true;
            continue;
        }
        if token.is_empty() {
            continue;
        }
        argv.push(token.to_string());
    }

    // Just the bare binary name in prose — nothing to check.
    if argv.len() < 2 {
        return None;
    }
    Some((argv, partial))
}

/// Replace a `<PLACEHOLDER>` value with a representative literal for the
/// numerically-typed arguments. Concrete documented values are left alone so
/// they are genuinely type-checked.
fn substitute_placeholders(argv: &mut [String]) {
    for index in 0..argv.len() {
        let Some(replacement) = NUMERIC_PLACEHOLDER_VALUES
            .iter()
            .find(|(flag, _)| *flag == argv[index])
            .map(|(_, value)| *value)
        else {
            continue;
        };
        let Some(value) = argv.get(index + 1) else {
            continue;
        };
        if value.contains('<') || value.contains('>') {
            argv[index + 1] = replacement.to_string();
        }
    }
}

/// Harvest every `rmpc` invocation from every shipped plugin skill document.
fn harvest_invocations() -> Vec<Invocation> {
    let root = repo_root();
    let mut invocations = Vec::new();

    for path in plugin_skill_markdown() {
        let relative = path
            .strip_prefix(&root)
            .unwrap_or(&path)
            .to_string_lossy()
            .into_owned();
        let text = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));

        let mut fence_lang: Option<String> = None;
        let mut block: Vec<(usize, &str)> = Vec::new();

        for (index, line) in text.lines().enumerate() {
            let line_number = index + 1;

            if let Some(rest) = line.trim_start().strip_prefix("```") {
                match fence_lang.take() {
                    None => {
                        fence_lang = Some(rest.trim().to_ascii_lowercase());
                        block.clear();
                    }
                    Some(lang) => {
                        if SHELL_FENCE_LANGS.contains(&lang.as_str()) {
                            for (start, joined) in logical_lines(&block) {
                                if let Some((argv, partial)) = parse_command_line(&joined) {
                                    invocations.push(Invocation {
                                        file: relative.clone(),
                                        line: start,
                                        source: joined,
                                        argv,
                                        partial,
                                    });
                                }
                            }
                        }
                        block.clear();
                    }
                }
                continue;
            }

            if fence_lang.is_some() {
                block.push((line_number, line));
                continue;
            }

            // Prose: inline code spans are abbreviated mentions, checked at the
            // flag/subcommand level rather than parsed whole.
            for span in line.split('`').skip(1).step_by(2) {
                if !span.starts_with("rmpc") {
                    continue;
                }
                if let Some((argv, _)) = parse_command_line(span) {
                    invocations.push(Invocation {
                        file: relative.clone(),
                        line: line_number,
                        source: span.to_string(),
                        argv,
                        partial: true,
                    });
                }
            }
        }

        assert!(
            fence_lang.is_none(),
            "{relative}: unterminated code fence — the harvester cannot trust this file"
        );
    }

    for invocation in &mut invocations {
        substitute_placeholders(&mut invocation.argv);
    }
    invocations
}

fn long_flag<'a>(command: &'a ClapCommand, name: &str) -> Option<&'a Arg> {
    command.get_arguments().find(|arg| {
        arg.get_long() == Some(name)
            || arg
                .get_all_aliases()
                .is_some_and(|aliases| aliases.contains(&name))
    })
}

fn short_flag(command: &ClapCommand, short: char) -> Option<&Arg> {
    command
        .get_arguments()
        .find(|arg| arg.get_short() == Some(short))
}

/// Check an abbreviated invocation: the subcommand path must resolve, and every
/// flag named must exist somewhere on that path (an ancestor's `global = true`
/// argument counts, which is why the whole path is searched).
fn check_partial_invocation(argv: &[String]) -> Result<(), String> {
    let mut path: Vec<ClapCommand> = vec![Cli::command()];
    let mut index = 1;

    while index < argv.len() {
        let token = &argv[index];

        if let Some(rest) = token.strip_prefix("--") {
            let name = rest.split('=').next().unwrap_or(rest);
            if IMPLICIT_FLAGS.contains(&name) {
                index += 1;
                continue;
            }
            let arg = path
                .iter()
                .rev()
                .find_map(|command| long_flag(command, name))
                .ok_or_else(|| {
                    format!(
                        "`--{name}` is not an argument of `{}`",
                        path.iter()
                            .map(ClapCommand::get_name)
                            .collect::<Vec<_>>()
                            .join(" ")
                    )
                })?;
            let takes_value = arg.get_action().takes_values() && !token.contains('=');
            index += if takes_value { 2 } else { 1 };
            continue;
        }

        if token.len() > 1 && token.starts_with('-') {
            let short = token.chars().nth(1).expect("checked length");
            let arg = path
                .iter()
                .rev()
                .find_map(|command| short_flag(command, short))
                .ok_or_else(|| format!("`-{short}` is not an argument of `rmpc`"))?;
            index += if arg.get_action().takes_values() {
                2
            } else {
                1
            };
            continue;
        }

        let current = path.last().expect("root is always present");
        let matched = current
            .get_subcommands()
            .find(|sub| {
                sub.get_name() == token || sub.get_all_aliases().any(|alias| alias == token)
            })
            .cloned()
            .ok_or_else(|| format!("`{token}` is not a subcommand of `{}`", current.get_name()))?;
        path.push(matched);
        index += 1;
    }

    Ok(())
}

/// The whole point of the harvester is that it finds things; a silently empty
/// corpus would make every check below a false green. The per-plugin floor is
/// derived from what is on disk rather than hardcoded, so deleting a plugin is
/// not a spurious failure while a plugin the harvester stops seeing is.
#[test]
fn harvester_finds_invocations_in_every_plugin_that_documents_rmpc() {
    let invocations = harvest_invocations();
    let complete = invocations.iter().filter(|i| !i.partial).count();
    assert!(
        invocations.len() >= 80,
        "expected the plugin skills to publish at least 80 rmpc invocations, found {} — \
         the harvester is probably broken",
        invocations.len()
    );
    assert!(
        complete >= 40,
        "expected at least 40 complete (fully parseable) invocations, found {complete}"
    );

    let harvested: BTreeSet<String> = invocations
        .iter()
        .filter_map(|i| i.file.split('/').nth(1).map(str::to_owned))
        .collect();

    let root = repo_root();
    let mut documented: BTreeSet<String> = BTreeSet::new();
    for path in plugin_skill_markdown() {
        let text = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
        if !text.contains("rmpc ") {
            continue;
        }
        let relative = path
            .strip_prefix(&root)
            .unwrap_or(&path)
            .to_string_lossy()
            .into_owned();
        if let Some(plugin) = relative.split('/').nth(1) {
            documented.insert(plugin.to_owned());
        }
    }
    assert!(
        !documented.is_empty(),
        "no plugin skill mentions rmpc — the file walk is broken"
    );
    for plugin in &documented {
        assert!(
            harvested.contains(plugin),
            "plugins/{plugin} documents rmpc but the harvester found no invocation in it"
        );
    }
}

/// AC: every `rmpc` invocation appearing in a plugin skill parses against the
/// real CLI surface.
#[test]
fn every_complete_plugin_skill_invocation_parses() {
    let invocations = harvest_invocations();
    let mut failures = Vec::new();
    let mut checked = 0usize;

    for invocation in invocations.iter().filter(|i| !i.partial) {
        checked += 1;
        if let Err(error) = Cli::try_parse_from(&invocation.argv) {
            failures.push(format!(
                "{}:{}\n    documented: {}\n    normalized: {}\n    clap: {}",
                invocation.file,
                invocation.line,
                invocation.source,
                invocation.argv.join(" "),
                error.to_string().lines().next().unwrap_or_default()
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "{} of {checked} documented rmpc invocations do not parse:\n\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

/// AC (abbreviated mentions): an elided example or an inline prose mention
/// cannot be parsed whole, but its subcommand path and every flag it names must
/// still exist. This is the tier that catches a wrong flag name in prose.
#[test]
fn every_abbreviated_plugin_skill_invocation_names_real_arguments() {
    let invocations = harvest_invocations();
    let mut failures = Vec::new();
    let mut checked = 0usize;

    for invocation in invocations.iter().filter(|i| i.partial) {
        checked += 1;
        if let Err(error) = check_partial_invocation(&invocation.argv) {
            failures.push(format!(
                "{}:{}\n    documented: {}\n    problem: {error}",
                invocation.file, invocation.line, invocation.source
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "{} of {checked} abbreviated rmpc mentions reference a non-existent \
         subcommand or flag:\n\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

// ---------------------------------------------------------------------------
// Negative controls — the checks above are only trustworthy if they are known
// to go red on the exact drift issue #1203 was filed for.
// ---------------------------------------------------------------------------

/// The concrete Swarm vote-submit example, in the order the skill publishes it.
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
fn swarm_skill_publishes_both_vote_submit_examples_in_parser_correct_order() {
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
    assert!(
        documented.contains("--weight-bps <0-10000>"),
        "the reference example must use the real --weight-bps flag"
    );
    assert!(
        !documented.contains("--target-weight-bps"),
        "the Swarm skill must not reintroduce the non-existent --target-weight-bps flag"
    );
    Cli::try_parse_from(VOTE_SUBMIT_EXAMPLE).expect("the Swarm vote-submit example must parse");
}

#[test]
fn swarm_skill_rejects_the_previously_documented_weight_flag() {
    let mut invalid = VOTE_SUBMIT_EXAMPLE.to_vec();
    let flag = invalid
        .iter_mut()
        .find(|argument| **argument == "--weight-bps")
        .expect("example contains --weight-bps");
    *flag = "--target-weight-bps";

    let error = Cli::try_parse_from(&invalid).expect_err("stale flag must fail clap parsing");
    assert!(
        error.to_string().contains("--target-weight-bps"),
        "unexpected clap error: {error}"
    );

    // The abbreviated tier must reject it too, so the same mistake cannot hide
    // in prose or behind an elided example.
    let argv: Vec<String> = invalid.iter().map(|s| (*s).to_string()).collect();
    let rejection =
        check_partial_invocation(&argv).expect_err("stale flag must fail the abbreviated check");
    assert!(
        rejection.contains("--target-weight-bps"),
        "unexpected rejection: {rejection}"
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

/// A guard on the guard: an unknown subcommand must be rejected by the
/// abbreviated tier, not silently accepted as a positional value.
#[test]
fn abbreviated_check_rejects_an_unknown_subcommand() {
    let argv: Vec<String> = ["rmpc", "committee", "vote-sumbit"]
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    let rejection = check_partial_invocation(&argv)
        .expect_err("a misspelled subcommand must fail the abbreviated check");
    assert!(
        rejection.contains("vote-sumbit"),
        "unexpected rejection: {rejection}"
    );
}

/// `ArgAction` is used to decide whether a flag consumes the next token; if
/// clap ever changed that shape the abbreviated tier would silently drift.
#[test]
fn flag_value_arity_is_read_from_the_real_parser() {
    let cli = Cli::command();
    let committee = cli
        .get_subcommands()
        .find(|sub| sub.get_name() == "committee")
        .expect("rmpc committee exists");
    let config = long_flag(committee, "config").expect("committee has --config");
    assert!(
        config.get_action().takes_values(),
        "--config must consume a value"
    );
    let pretty = long_flag(committee, "pretty").expect("committee has --pretty");
    assert!(
        matches!(pretty.get_action(), ArgAction::SetTrue),
        "--pretty must be a boolean flag"
    );
}
