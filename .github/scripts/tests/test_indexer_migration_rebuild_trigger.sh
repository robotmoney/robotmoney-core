#!/usr/bin/env bash
# Behavioural test of the explorer-indexer migration rebuild trigger.
#
# Canonical: services/explorer-indexer/build.rs
# Issue: #1416
#
# WHY THIS EXISTS
# `services/explorer-indexer/src/db.rs` embeds the migration set at compile
# time with `sqlx::migrate!("./migrations")`. On stable Rust that macro
# registers no build dependency on the directory it read, so before #1416 a
# `.sql`-only change left cargo believing the crate was fresh. With
# `Swatinem/rust-cache` restoring `target/`, a PR that only added a migration
# could go green with that migration never compiled in. `build.rs` now emits
# `cargo:rerun-if-changed=migrations`.
#
# `tests/migration_set_parity.rs` compares the embedded set with the files on
# disk, but on a COLD build the two always agree, so that target alone cannot
# tell whether the trigger exists. This script is the half that can: it warms
# `target/`, then changes ONLY files under `migrations/` and asserts, after
# each change, that
#   (a) explorer-indexer's OWN build script re-ran (its `output` file under
#       target/<profile>/build/ was rewritten) -- the direct evidence that the
#       migrations directory is a tracked build input,
#   (b) cargo recompiled `explorer-indexer`, and
#   (c) the parity target passes against the new tree.
# Delete `build.rs` and step 2 fails on (a), and on a clean checkout on (b)
# and (c) as well: that ADD is the defect. For the edit, revert and delete
# steps only (a) fails, because sqlx expands every migration it found to
# `include_str!`, so rustc's dep-info already recompiles on those; (a) is
# what shows the directory directive covers them too. Point the directive at
# a wrong path and the control step fails instead (cargo re-runs a build
# script whose watched path is missing on every build).
#
# WHY (a) AND NOT ONLY (b)
# `Compiling explorer-indexer` can also be caused by a dirty dependency. In a
# linked `git worktree`, `clients/rust-payment-client/build.rs` watches
# `../../.git/HEAD`, which is not a file there, so that crate -- and everything
# that depends on it, including explorer-indexer -- recompiles on every build.
# (b) and (c) would then pass with or without the fix. (a) is specific to this
# crate's build script and is not moved by a dependency, so the test is
# truthful in a worktree as well as on a CI checkout.
#
# STEPS
#   1. warm baseline, then control: an unchanged tree does NOT re-run the
#      build script (a trigger that fires unconditionally would defeat
#      incremental builds and is also a failure)
#   2. ADD a probe migration                    -> (a) (b) (c)
#   3. EDIT an existing migration in place       -> (a) (b) (c); only the SQL
#      byte compare in the parity target can see this shape, because the
#      version set does not change
#   4. REVERT that edit                          -> (a) (b) (c)
#   5. DELETE the probe                          -> (a) (b) (c)
#   6. touch an existing migration               -> the `indexer` BINARY
#      recompiles too, not only the test build
#   7. move `migrations/` away                   -> build.rs fails loudly,
#      naming #1416, instead of emitting a directive cargo would ignore
#   8. restore                                   -> parity green again
#
# It mutates the real checkout (it has to: the subject is cargo's view of this
# crate) and restores it on every exit path via the EXIT trap. No Postgres, no
# Docker, no network.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CRATE_DIR="${REPO_ROOT}/services/explorer-indexer"
MIGRATIONS="${CRATE_DIR}/migrations"
MOVED="${CRATE_DIR}/migrations.moved-by-issue-1416-test"
PROBE="${MIGRATIONS}/99916_issue_1416_rebuild_probe.sql"

export CARGO_TERM_COLOR=never

if [[ ! -d "$MIGRATIONS" ]]; then
  echo "FATAL: migrations directory not found at $MIGRATIONS" >&2
  exit 2
fi
if [[ -e "$PROBE" || -e "$MOVED" ]]; then
  echo "FATAL: leftover from an earlier run: $PROBE or $MOVED exists" >&2
  exit 2
fi

# The highest-numbered real migration: the one an author is most likely to be
# editing in place.
EDITED="$(find "$MIGRATIONS" -maxdepth 1 -name '*.sql' | sort | tail -1)"

TARGET_DIR="$(cd "$REPO_ROOT" && cargo metadata --format-version 1 --no-deps \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')"
BUILD_DIR="${TARGET_DIR}/debug/build"

LOG="$(mktemp)"
BACKUP="$(mktemp)"
cp "$EDITED" "$BACKUP"
restore() {
  if [[ -d "$MOVED" && ! -e "$MIGRATIONS" ]]; then
    mv "$MOVED" "$MIGRATIONS"
  fi
  if ! cmp -s "$BACKUP" "$EDITED"; then
    cp "$BACKUP" "$EDITED"
  fi
  rm -f "$PROBE" "$LOG" "$BACKUP"
}
trap restore EXIT

FAILURES=0
fail() {
  echo "FAIL: $*" >&2
  FAILURES=$((FAILURES + 1))
}

# Newest mtime of any explorer-indexer build-script `output` file, or 0 when
# the crate has no build script at all. Cargo rewrites that file every time
# the build script runs, and only then.
build_script_stamp() {
  local newest
  newest="$(find "$BUILD_DIR" -maxdepth 2 -path "${BUILD_DIR}/explorer-indexer-*/output" \
    -printf '%T@\n' 2>/dev/null | sort -n | tail -1)"
  echo "${newest:-0}"
}

# Run a cargo command from the repo root with its output in $LOG (and echoed).
# Records whether explorer-indexer's build script re-ran in BUILD_SCRIPT_RAN.
BUILD_SCRIPT_RAN=no
run_cargo() {
  local before after status
  before="$(build_script_stamp)"
  set +e
  (cd "$REPO_ROOT" && cargo "$@") >"$LOG" 2>&1
  status=$?
  set -e
  cat "$LOG"
  after="$(build_script_stamp)"
  if [[ "$after" != "0" && "$after" != "$before" ]]; then
    BUILD_SCRIPT_RAN=yes
  else
    BUILD_SCRIPT_RAN=no
  fi
  echo "[rebuild-trigger] explorer-indexer build script re-ran: ${BUILD_SCRIPT_RAN}"
  return "$status"
}

run_parity() {
  run_cargo test -p explorer-indexer --test migration_set_parity
}

recompiled() {
  grep -qE '^[[:space:]]*Compiling explorer-indexer v' "$LOG"
}

# Did any OTHER workspace crate recompile in the last run? Used only to
# excuse an explorer-indexer recompile in the control step.
other_workspace_crate_recompiled() {
  grep -E '^[[:space:]]*Compiling [^ ]+ v[^ ]+ \(' "$LOG" \
    | grep -vqE '^[[:space:]]*Compiling explorer-indexer v'
}

# Every parity run must execute both tests: a run that collected zero tests
# would otherwise read as green.
parity_green() {
  grep -qE '^test result: ok\. 2 passed; 0 failed' "$LOG"
}

expect_rebuild_and_green() {
  local label="$1"
  if ! run_parity; then
    fail "$label: parity target failed -- the embedded MIGRATOR is stale or the build broke"
  fi
  [[ "$BUILD_SCRIPT_RAN" == yes ]] \
    || fail "$label: explorer-indexer's build script did NOT re-run after a migrations-only change (is build.rs still emitting cargo:rerun-if-changed=migrations?)"
  recompiled || fail "$label: cargo did NOT recompile explorer-indexer after a migrations-only change"
  parity_green || fail "$label: parity target did not report 2 passed"
}

echo "=== STEP 1: warm baseline ==="
run_parity || { echo "FATAL: parity target is red on the unmodified tree" >&2; exit 1; }
[[ "$(build_script_stamp)" != "0" ]] \
  || fail "baseline: explorer-indexer has no build-script output under ${BUILD_DIR} (build.rs missing?)"

echo "=== STEP 1b: control, unchanged tree must NOT re-run the build script ==="
run_parity || fail "control: parity target failed on an unchanged tree"
[[ "$BUILD_SCRIPT_RAN" == no ]] \
  || fail "control: explorer-indexer's build script re-ran with nothing changed (rebuild trigger fires unconditionally)"
if recompiled && ! other_workspace_crate_recompiled; then
  fail "control: explorer-indexer recompiled with nothing changed and no dependency rebuilt"
fi
parity_green || fail "control: parity target did not report 2 passed"

echo "=== STEP 2: ADD a migration, no .rs change ==="
printf -- '-- issue #1416 rebuild-trigger probe. Never applied to a database.\nSELECT 1;\n' >"$PROBE"
expect_rebuild_and_green "add"

echo "=== STEP 3: EDIT $(basename "$EDITED") in place, no .rs change ==="
printf -- '\n-- issue #1416 rebuild-trigger probe: in-place edit.\n' >>"$EDITED"
expect_rebuild_and_green "edit"

echo "=== STEP 4: REVERT that edit, no .rs change ==="
cp "$BACKUP" "$EDITED"
expect_rebuild_and_green "revert"

echo "=== STEP 5: DELETE the probe migration, no .rs change ==="
rm -f "$PROBE"
expect_rebuild_and_green "delete"

echo "=== STEP 6: the indexer BINARY recompiles on a migrations-only change ==="
run_cargo build -p explorer-indexer --bin indexer >/dev/null || fail "binary: warm build of the indexer binary failed"
touch "${MIGRATIONS}/0001_minimum_tables.sql"
run_cargo build -p explorer-indexer --bin indexer || fail "binary: build of the indexer binary failed"
[[ "$BUILD_SCRIPT_RAN" == yes ]] \
  || fail "binary: explorer-indexer's build script did NOT re-run for --bin indexer after a migrations-only change"
recompiled || fail "binary: cargo did NOT recompile explorer-indexer for --bin indexer after a migrations-only change"

echo "=== STEP 7: a missing migrations/ fails the build loudly ==="
mv "$MIGRATIONS" "$MOVED"
if run_cargo build -p explorer-indexer --lib; then
  fail "missing dir: build SUCCEEDED with no migrations/ directory"
fi
grep -q 'expected a migrations directory' "$LOG" \
  || fail "missing dir: build.rs did not name the missing migrations directory"
mv "$MOVED" "$MIGRATIONS"

echo "=== STEP 8: restored tree is green ==="
run_parity || fail "restore: parity target failed after restoring migrations/"
parity_green || fail "restore: parity target did not report 2 passed"

if [[ $FAILURES -ne 0 ]]; then
  echo "test_indexer_migration_rebuild_trigger: ${FAILURES} failure(s)" >&2
  exit 1
fi
echo "test_indexer_migration_rebuild_trigger: all 8 steps passed"
