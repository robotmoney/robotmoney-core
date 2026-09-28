//! Canonical: docs/architecture.md §5.4 — Explorer Indexer and API.
//!
//! WHY THIS TARGET EXISTS (issue #1416)
//! ------------------------------------
//! `src/db.rs` embeds the migration set at COMPILE time with
//! `sqlx::migrate!("./migrations")`. On stable Rust that macro registers no
//! build dependency on the directory it read — sqlx calls
//! `proc_macro::tracked_path::path()` only under `#[cfg(sqlx_macros_unstable)]`.
//! It does expand each file it found to `include_str!`, so rustc tracks
//! edits and deletions of migrations that already existed; but a newly ADDED
//! `.sql` file is in no dep-info, so without help cargo considers this crate
//! fresh and the binary keeps an embedded set that lacks the new migration.
//! `build.rs` supplies the missing `cargo:rerun-if-changed=migrations`.
//!
//! This target is the guard on that mechanism. It compares the COMPILE-time
//! embedded set (`MIGRATOR`, frozen into this test binary when the crate was
//! last built) against the RUN-time contents of `migrations/` (read from disk
//! here and now): first the `version -> description` set (catches an added,
//! deleted or renamed migration), then each migration's SQL text byte for byte
//! (an in-place edit leaves the version set unchanged; rustc's `include_str!`
//! tracking covers that case today, and this assertion keeps it covered if a
//! future sqlx stops expanding to `include_str!`). The two sides can only
//! disagree if a rebuild trigger failed against a warm `target/`.
//!
//! On a COLD build both sides always agree, so this target alone cannot prove
//! the trigger exists. `.github/scripts/tests/test_indexer_migration_rebuild_trigger.sh`
//! is the behavioural half: it warms `target/`, then adds, edits and deletes a
//! probe migration with no `.rs` change and re-runs this target after each —
//! so a regression in `build.rs` (deleting it, renaming the directory,
//! misspelling the directive) turns CI RED instead of shipping a binary that
//! silently omits or mis-embeds a migration.
//!
//! It needs no Postgres, no Docker and no network: it is a filesystem walk
//! plus an iteration over an embedded static. That is why it is wired into the
//! light `rust-lint` job (suite 4) rather than the Docker-bound
//! `explorer-indexer-fast` job (suite 8) — the guard is about the build, so it
//! must run on every Rust change, including drafts.

use explorer_indexer::db::MIGRATOR;
use std::collections::BTreeMap;
use std::path::PathBuf;

/// The directory `sqlx::migrate!("./migrations")` read at compile time,
/// resolved relative to the crate root exactly as the macro resolves it.
fn migrations_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations")
}

/// One migration file as read off disk here and now.
struct OnDisk {
    description: String,
    sql: String,
}

/// Read `migrations/*.sql` off disk and derive `version -> (description, sql)`
/// the same way sqlx's `resolve_blocking` does: split the file stem on the
/// first `_`, parse the left half as the version, turn the right half's
/// underscores into spaces for the description, and keep the file's text
/// verbatim (sqlx embeds `fs::read_to_string` output unmodified and derives
/// its checksum from exactly those bytes).
fn on_disk_migrations() -> BTreeMap<i64, OnDisk> {
    let dir = migrations_dir();
    let entries = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("read migrations directory {}: {e}", dir.display()));

    let mut found = BTreeMap::new();
    for entry in entries {
        let path = entry.expect("read a migrations directory entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("sql") {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_else(|| panic!("non-UTF-8 migration filename: {}", path.display()));
        let (version, description) = stem.split_once('_').unwrap_or_else(|| {
            panic!("migration filename {stem:?} is not `<version>_<description>.sql`")
        });
        let version: i64 = version
            .parse()
            .unwrap_or_else(|e| panic!("migration filename {stem:?} has no numeric version: {e}"));
        let sql = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read migration {}: {e}", path.display()));
        let previous = found.insert(
            version,
            OnDisk {
                description: description.replace('_', " "),
                sql,
            },
        );
        assert!(
            previous.is_none(),
            "two migration files share version {version} in {}",
            dir.display()
        );
    }
    assert!(
        !found.is_empty(),
        "no .sql files under {} — the directory moved, and MIGRATOR would be silently empty",
        dir.display()
    );
    found
}

/// Printed on every failure so the red reads as "the rebuild trigger is
/// broken", not as "a migration is malformed".
const STALE_HINT: &str = "The compile-time embedded set (MIGRATOR) disagrees with the on-disk \
     migrations/ directory. Almost always this means cargo did not rebuild \
     explorer-indexer after a .sql-only change: check that \
     services/explorer-indexer/build.rs still emits \
     `cargo:rerun-if-changed` for the migrations directory (issue #1416). \
     `touch services/explorer-indexer/src/db.rs` forces the rebuild by hand.";

/// Issue #1416 AC — the embedded set matches the on-disk directory: count,
/// then max version, then the full `version -> description` map.
///
/// A failure here means the binary under test was NOT rebuilt after a
/// migration was added, deleted or renamed.
#[test]
fn embedded_migration_set_matches_the_migrations_directory() {
    let on_disk: BTreeMap<i64, String> = on_disk_migrations()
        .into_iter()
        .map(|(v, m)| (v, m.description))
        .collect();
    let embedded: BTreeMap<i64, String> = MIGRATOR
        .iter()
        .map(|m| (m.version, m.description.to_string()))
        .collect();

    assert_eq!(
        embedded.len(),
        on_disk.len(),
        "embedded migration COUNT {} != on-disk count {}.\nembedded: {:?}\non disk: {:?}\n{STALE_HINT}",
        embedded.len(),
        on_disk.len(),
        embedded.keys().collect::<Vec<_>>(),
        on_disk.keys().collect::<Vec<_>>(),
    );

    assert_eq!(
        embedded.keys().max(),
        on_disk.keys().max(),
        "embedded MAX VERSION {:?} != on-disk max version {:?}.\n{STALE_HINT}",
        embedded.keys().max(),
        on_disk.keys().max(),
    );

    assert_eq!(
        embedded, on_disk,
        "embedded migrations differ from the on-disk directory (version -> description).\n{STALE_HINT}"
    );
}

/// Issue #1416 behaviour — an IN-PLACE edit of an existing migration (same
/// filename, different SQL) is also reflected in the embedded set.
///
/// The version set cannot see that shape, and it is the common one when an
/// author fixes a migration they added earlier in the same PR. Today rustc
/// already rebuilds on it (sqlx expands each migration to `include_str!`) and
/// `build.rs` rebuilds on it again; this assertion is what would notice if
/// both stopped. sqlx derives each migration's `_sqlx_migrations` checksum
/// from exactly this text, so a stale embedded body would also be a stale
/// checksum.
#[test]
fn embedded_migration_sql_matches_the_file_contents() {
    let on_disk = on_disk_migrations();
    let mut stale = Vec::new();
    for m in MIGRATOR.iter() {
        let Some(file) = on_disk.get(&m.version) else {
            stale.push(format!("{} (embedded, no file on disk)", m.version));
            continue;
        };
        if m.sql.as_ref() != file.sql.as_str() {
            stale.push(format!(
                "{} {:?}: embedded {} bytes, on disk {} bytes",
                m.version,
                m.description,
                m.sql.len(),
                file.sql.len()
            ));
        }
    }
    assert!(
        stale.is_empty(),
        "embedded migration SQL differs from the file on disk for: {stale:?}\n{STALE_HINT}"
    );
}
