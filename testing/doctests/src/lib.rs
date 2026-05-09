//! Doc-parity test suite. Each module targets a specific doc or walkthrough
//! and asserts that CLI surface, config templates, and runtime behaviour
//! match what the doc claims.
//!
//! Modules:
//! - [`opencode`] — `docs/walkthroughs/opencode-readonly-fork.md`

pub mod opencode;
