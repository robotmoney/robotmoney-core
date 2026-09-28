//! Canonical: docs/architecture.md §5.4 — Explorer Indexer and API.
//!
//! WHY THIS BUILD SCRIPT EXISTS (issue #1416)
//! ------------------------------------------
//! `src/db.rs` embeds the whole migration set at COMPILE time:
//!
//! ```ignore
//! pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
//! ```
//!
//! On **stable** Rust that macro reads `migrations/` with plain `std::fs` and
//! registers no build dependency on it. sqlx calls
//! `proc_macro::tracked_path::path()` — the API that would tell cargo the macro
//! consumed those files — only under
//! `#[cfg(any(sqlx_macros_unstable, procmacro2_semver_exempt))]`
//! (`sqlx-macros-core/src/migrate.rs`), and this workspace builds on stable.
//!
//! The macro does expand each migration it finds to
//! `include_str!("<absolute path>")`, and rustc records every `include_str!`
//! in its dep-info — so an EDIT to, or a DELETION of, a migration that existed
//! at the last build already makes cargo recompile. What nothing records is
//! the DIRECTORY LISTING: a newly ADDED `.sql` file appears in no dep-info, so
//! cargo considers `explorer-indexer` fresh, and the binary and the test
//! binaries keep an embedded migration set that lacks the new migration. CI is
//! exposed to exactly this because `Swatinem/rust-cache` restores `target/`
//! across runs — a PR that only adds a migration (the common shape of schema
//! work) could go green with the new migration never compiled in, and
//! `indexer --migrate-only` built from that cache would not apply it.
//!
//! This script supplies the dependency sqlx cannot. `rerun-if-changed` on a
//! DIRECTORY is walked recursively by cargo (it takes the newest mtime of the
//! directory and everything beneath it), so an addition — and, redundantly
//! with rustc's dep-info, an edit or a deletion — re-runs this script, which
//! marks the crate dirty, which re-expands `sqlx::migrate!`.
//!
//! Two guards hold this in place:
//! - `tests/migration_set_parity.rs` compares the compile-time embedded set
//!   against the run-time contents of `migrations/` (versions, descriptions
//!   and SQL text), so a stale binary fails red wherever it is tested;
//! - `.github/scripts/tests/test_indexer_migration_rebuild_trigger.sh` warms
//!   `target/`, adds / edits / deletes a migration with no `.rs` change, and
//!   asserts this script re-ran and the parity target passed after each —
//!   the only check that can see this script go missing, since on a cold
//!   build the parity target passes with or without it.

use std::path::Path;

fn main() {
    // Cargo resolves a relative rerun-if-changed against the package root, the
    // same root `sqlx::migrate!("./migrations")` resolves against — so the two
    // always name the same directory.
    let migrations = Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");

    // Fail the build rather than emit a directive for a path that does not
    // exist: cargo silently ignores a rerun-if-changed on a missing path, which
    // would quietly restore the very staleness bug this script exists to fix.
    assert!(
        migrations.is_dir(),
        "expected a migrations directory at {} — `sqlx::migrate!(\"./migrations\")` in \
         src/db.rs reads it at compile time, and this build script must track it so a \
         .sql-only change forces a rebuild (issue #1416)",
        migrations.display()
    );

    println!("cargo:rerun-if-changed=migrations");
    println!("cargo:rerun-if-changed=build.rs");
}
