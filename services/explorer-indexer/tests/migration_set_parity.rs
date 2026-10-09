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
//! here and now): by version and checksum through `db::compare_schema`
//! (issue #1441; catches an added, deleted or edited-in-place migration), then
//! each migration's SQL text byte for byte (rustc's `include_str!` tracking
//! covers in-place edits today, and this assertion keeps it covered if a future
//! sqlx stops expanding to `include_str!`). The two sides can only
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

use explorer_indexer::db::{compare_schema, AppliedMigration, SchemaDivergence, MIGRATOR};
use sqlx::migrate::{Migration, MigrationType};
use std::borrow::Cow;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

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
    on_disk_migrations_in(&migrations_dir())
}

/// [`on_disk_migrations`] over an arbitrary directory, so a test can mutate a
/// COPY of the migrations and never the checked-in files.
fn on_disk_migrations_in(dir: &Path) -> BTreeMap<i64, OnDisk> {
    let entries = std::fs::read_dir(dir)
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

/// Render a [`SchemaDivergence`] for the DISK-parity context.
///
/// `Display` on `SchemaDivergence` is written for the indexer boot path and
/// tells the reader to run `--migrate-only` or deploy a matching binary; both
/// are wrong here. The comparison is `compare_schema(on_disk, MIGRATOR)`, so
/// "applied" means "present as a file under `migrations/`".
fn render_disk_divergence(d: &SchemaDivergence) -> String {
    match d {
        SchemaDivergence::NeverMigrated { embedded } => format!(
            "migrations/ holds no .sql files, but the embedded set (MIGRATOR) \
             goes up to version {embedded}."
        ),
        SchemaDivergence::MissingVersion {
            version,
            description,
            ..
        } => format!(
            "migration {version} ({description:?}) is in the embedded set but has \
             no file under migrations/: it was deleted or renamed on disk after \
             the binary was built."
        ),
        SchemaDivergence::ChecksumMismatch {
            version,
            description,
        } => format!(
            "migration {version} ({description:?}) has a different checksum on \
             disk than in the embedded set: the file was edited in place. If the \
             migration was already applied anywhere, restore it and add a new \
             migration instead."
        ),
        SchemaDivergence::UnknownAppliedVersion { version, embedded } => format!(
            "migration {version} is a file under migrations/ but is not in the \
             embedded set (which goes up to version {embedded}): it was added \
             after the binary was built."
        ),
    }
}

/// Compare the migrations in `dir` against `MIGRATOR` with the SAME function
/// the indexer boot guard uses (issue #1441), returning the first divergence
/// rendered for the disk context.
///
/// Each file is rebuilt with `sqlx::migrate::Migration::new` — the constructor
/// `sqlx::migrate!` itself uses — so the checksum is sqlx-identical by
/// construction and nothing here reimplements the hash.
fn disk_divergence(dir: &Path) -> Result<(), String> {
    let on_disk: Vec<AppliedMigration> = on_disk_migrations_in(dir)
        .into_iter()
        .map(|(version, file)| {
            let rebuilt = Migration::new(
                version,
                Cow::Owned(file.description),
                MigrationType::Simple,
                Cow::Owned(file.sql),
                false,
            );
            AppliedMigration {
                version: rebuilt.version,
                checksum: rebuilt.checksum.to_vec(),
            }
        })
        .collect();
    compare_schema(&on_disk, &MIGRATOR.migrations)
        .map(|_| ())
        .map_err(|d| format!("{}\n{STALE_HINT}", render_disk_divergence(&d)))
}

/// Copy `migrations/` into a scratch directory the test may mutate.
fn scratch_copy() -> tempfile::TempDir {
    let tmp = tempfile::tempdir().expect("create scratch dir");
    for entry in std::fs::read_dir(migrations_dir()).expect("read migrations dir") {
        let path = entry.expect("dir entry").path();
        std::fs::copy(&path, tmp.path().join(path.file_name().unwrap())).expect("copy migration");
    }
    tmp
}

fn first_sql(dir: &Path) -> PathBuf {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("sql"))
        .collect();
    files.sort();
    files.remove(0)
}

/// Issue #1416 AC, widened by #1441 — the embedded set matches the on-disk
/// directory by version AND checksum.
///
/// A failure here means the binary under test was NOT rebuilt after a
/// migration was added, deleted, renamed or edited.
#[test]
fn embedded_migration_set_matches_the_migrations_directory() {
    if let Err(msg) = disk_divergence(&migrations_dir()) {
        panic!("{msg}");
    }
}

/// Issue #1441 AC — an in-place edit (same filename, different SQL) is caught,
/// naming the migration, and the message carries no boot-path advice.
#[test]
fn in_place_edit_of_a_migration_is_detected() {
    let tmp = scratch_copy();
    let target = first_sql(tmp.path());
    let mut sql = std::fs::read_to_string(&target).unwrap();
    sql.push_str("\n-- edited in place\n");
    std::fs::write(&target, sql).unwrap();

    let msg = disk_divergence(tmp.path()).expect_err("an in-place edit must diverge");
    assert!(
        msg.contains("migration 1 "),
        "names the first divergence: {msg}"
    );
    assert!(msg.contains("edited in place"), "{msg}");
    assert_boot_advice_absent(&msg);
}

/// Issue #1441 AC — a file missing from disk (embedded, no file) and a file
/// extra on disk (file, not embedded) are each detected and named.
#[test]
fn missing_and_extra_migrations_are_detected() {
    let tmp = scratch_copy();
    let removed = first_sql(tmp.path());
    std::fs::remove_file(&removed).unwrap();
    let msg = disk_divergence(tmp.path()).expect_err("a deleted file must diverge");
    assert!(msg.contains("migration 1 "), "{msg}");
    assert!(msg.contains("no file under migrations/"), "{msg}");
    assert_boot_advice_absent(&msg);

    let tmp = scratch_copy();
    let extra_version = MIGRATOR.iter().map(|m| m.version).max().unwrap() + 1;
    std::fs::write(
        tmp.path().join(format!("{extra_version:04}_extra.sql")),
        "SELECT 1;\n",
    )
    .unwrap();
    let msg = disk_divergence(tmp.path()).expect_err("an extra file must diverge");
    assert!(
        msg.contains(&format!("migration {extra_version} ")),
        "{msg}"
    );
    assert!(msg.contains("not in the embedded set"), "{msg}");
    assert_boot_advice_absent(&msg);
}

/// The boot guard's remedies are wrong for a disk comparison.
fn assert_boot_advice_absent(msg: &str) {
    assert!(!msg.contains("--migrate-only"), "boot advice leaked: {msg}");
    assert!(
        !msg.contains("matching binary"),
        "boot advice leaked: {msg}"
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
