//! Canonical: docs/development/testing-strategy-ethereum.md — Doc-parity test suite
//! Doc-parity test suite. Each module targets a specific doc or walkthrough
//! and asserts that CLI surface, config templates, and runtime behaviour
//! match what the doc claims.
//!
//! Modules:
//! - [`opencode`] — `docs/development/opencode-readonly-fork.md`

pub mod opencode;
