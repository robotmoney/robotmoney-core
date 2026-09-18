//! `EXPLORER_INDEXER_REQUIRE_PG` is a real control, not a comment (task T30b).
//!
//! Needs no Docker on purpose: the meaning of the variable is a pure function,
//! so the control is covered on every runner, including the ones that cannot
//! run the fixture it guards.

mod common;

use common::{check_require_pg, REQUIRE_PG_ENV};

#[test]
fn the_variable_the_ci_steps_set_is_accepted() {
    // Three CI steps export `EXPLORER_INDEXER_REQUIRE_PG: "1"`. Before T30b
    // nothing read it, so those steps asserted a control that did not exist.
    assert_eq!(REQUIRE_PG_ENV, "EXPLORER_INDEXER_REQUIRE_PG");
    assert!(check_require_pg(Some("1")).is_ok());
    assert!(check_require_pg(Some("true")).is_ok());
    assert!(check_require_pg(Some("YES")).is_ok());
    assert!(check_require_pg(Some(" 1 ")).is_ok());
}

#[test]
fn unset_still_means_postgres_is_required() {
    // The fixture is Postgres-required unconditionally; an unset variable must
    // not read as permission to skip.
    assert!(check_require_pg(None).is_ok());
    assert!(check_require_pg(Some("")).is_ok());
}

#[test]
fn a_request_for_an_opt_out_mode_is_refused_rather_than_invented() {
    for v in ["0", "false", "no", "off", "maybe"] {
        let err = check_require_pg(Some(v)).unwrap_err_or_else_msg(v);
        assert!(
            err.contains(REQUIRE_PG_ENV) && err.contains("no such mode"),
            "unexpected refusal text for {v:?}: {err}"
        );
    }
}

/// Small helper so the loop reads as one assertion per value.
trait UnwrapErrMsg {
    fn unwrap_err_or_else_msg(self, value: &str) -> String;
}

impl UnwrapErrMsg for Result<(), String> {
    fn unwrap_err_or_else_msg(self, value: &str) -> String {
        match self {
            Ok(()) => panic!(
                "{REQUIRE_PG_ENV}={value:?} asks for a skip-capable mode and must be refused, \
                 not silently accepted"
            ),
            Err(e) => e,
        }
    }
}
