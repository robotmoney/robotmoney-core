#!/usr/bin/env bash
# check-restricted-paths.sh — suite 17 assertion (f), the swarm plugin's
# restricted-path coupling guard.
#
# Canonical docs: .github/workflows/suite-17-swarm-plugin.yml (header, item (f))
# Feature work:   issue #1232
#
# ============================================================================
# WHAT THIS GUARD ASSERTS
# ============================================================================
# The robotmoney-swarm plugin is a pure agent-skill bundle: it must have NO
# contract, Rust-crate, Rust-client or service dependencies. This guard proves
# that by failing when a branch changes `plugins/robotmoney-swarm/**` AND one of
# the restricted trees in the same change set.
#
# Note the AND. A PR that only touches `clients/rust-payment-client/` (or
# `contracts/`, `crates/`, `services/`) for unrelated reasons is NOT a coupling
# violation and must PASS — otherwise this one plugin's suite becomes a veto
# over every Rust-client change in the repo.
#
# ============================================================================
# WHY IT IS A SEPARATE, SELF-TESTED SCRIPT (issue #1232)
# ============================================================================
# The previous implementation lived inline in run-tests.sh as:
#
#   git diff --name-only "$(git merge-base HEAD origin/dev 2>/dev/null \
#     || echo HEAD~1)" HEAD 2>/dev/null | grep -qE '^(contracts/|...)' \
#     && fail ... || pass ...
#
# suite-17's checkout was depth-1, so there was no `origin/dev` and no `HEAD~1`:
# `merge-base` failed, the `|| echo HEAD~1` fallback failed, `git diff` failed,
# every error was swallowed by `2>/dev/null`, the pipeline emitted nothing,
# `grep -q` matched nothing, and the `else` branch printed PASS. The guard could
# never fail — merged PR #1196 changed three `clients/rust-payment-client/`
# files and still got `PASS: no restricted paths modified`. The executed-
# assertion floor did not catch it: the assertion ran, its input was just
# silently empty.
#
# So: nothing here is silenced. An unresolvable base commit exits 2 with a named
# reason (loud-skip policy: a guard that cannot determine its input goes RED, it
# never prints PASS), and `--self-test` proves on every CI run that the guard
# still fires on a synthetic violation — the same shape as
# `scripts/validate-seam-map --self-test`.
#
# Usage:
#   check-restricted-paths.sh                 diff this branch against its base
#                                             and evaluate the changed paths
#   check-restricted-paths.sh --paths-from F  evaluate the newline-separated path
#                                             list in F (no git involved)
#   check-restricted-paths.sh --self-test     prove the guard fires on a
#                                             violation, accepts the two
#                                             non-violating shapes, and goes red
#                                             on an unresolvable base
#
# Exit codes:
#   0  no coupling violation
#   1  coupling violation (restricted path + swarm plugin in the same diff)
#   2  the guard could not run (base commit unresolvable, bad usage)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# The trees the swarm plugin must not couple to.
RESTRICTED_RE='^(contracts/|crates/|clients/rust-payment-client/|services/)'
# The plugin tree whose coupling is being guarded.
PLUGIN_RE='^plugins/robotmoney-swarm/'

# evaluate_paths — reads a newline-separated list of changed paths on stdin.
# Returns 0 when there is no coupling violation, 1 when there is one.
evaluate_paths() {
  local list restricted plugin
  list="$(cat)"

  restricted="$(printf '%s\n' "$list" | grep -E "$RESTRICTED_RE" || true)"
  plugin="$(printf '%s\n' "$list" | grep -E "$PLUGIN_RE" || true)"

  if [[ -n "$restricted" && -n "$plugin" ]]; then
    echo "ERROR: plugins/robotmoney-swarm/** was changed together with a restricted path." >&2
    echo "       The swarm plugin must have no contract/crate/rust-client/service dependency." >&2
    echo "       Restricted paths in this change set:" >&2
    printf '%s\n' "$restricted" | sed 's/^/         /' >&2
    echo "       Swarm plugin paths in this change set:" >&2
    printf '%s\n' "$plugin" | sed 's/^/         /' >&2
    return 1
  fi

  return 0
}

# resolve_base — print the commit this branch should be diffed against, or exit
# 2 with a named reason. Nothing is swallowed and there is no silent fallback.
resolve_base() {
  local base

  # CI passes github.event.pull_request.base.sha, which beats guessing a ref.
  if [[ -n "${SWARM_RESTRICTED_BASE_SHA:-}" ]]; then
    if ! git -C "$REPO_ROOT" rev-parse --verify --quiet \
        "${SWARM_RESTRICTED_BASE_SHA}^{commit}" >/dev/null; then
      echo "ERROR: SWARM_RESTRICTED_BASE_SHA=${SWARM_RESTRICTED_BASE_SHA} is not a commit in this clone." >&2
      echo "       The restricted-path guard cannot determine what changed, so it fails" >&2
      echo "       rather than reporting a PASS it cannot justify (issue #1232)." >&2
      echo "       Fix: check out with fetch-depth: 0 so the base commit is present." >&2
      exit 2
    fi
    if ! base="$(git -C "$REPO_ROOT" merge-base HEAD "$SWARM_RESTRICTED_BASE_SHA")"; then
      echo "ERROR: no merge-base between HEAD and SWARM_RESTRICTED_BASE_SHA=${SWARM_RESTRICTED_BASE_SHA}." >&2
      echo "       The restricted-path guard cannot determine what changed — failing loudly." >&2
      exit 2
    fi
    printf '%s\n' "$base"
    return 0
  fi

  # Local runs (and push events) fall back to the default base branch, dev.
  local ref
  for ref in origin/dev dev; do
    if git -C "$REPO_ROOT" rev-parse --verify --quiet "${ref}^{commit}" >/dev/null; then
      if ! base="$(git -C "$REPO_ROOT" merge-base HEAD "$ref")"; then
        echo "ERROR: no merge-base between HEAD and ${ref}." >&2
        echo "       The restricted-path guard cannot determine what changed — failing loudly." >&2
        exit 2
      fi
      printf '%s\n' "$base"
      return 0
    fi
  done

  echo "ERROR: cannot resolve a base commit for the restricted-path guard." >&2
  echo "       Neither SWARM_RESTRICTED_BASE_SHA nor origin/dev nor dev is available." >&2
  echo "       This is exactly the depth-1-clone condition that made this guard a" >&2
  echo "       permanent PASS before issue #1232 — it now fails instead." >&2
  exit 2
}

# check_branch — the real check: diff HEAD against the resolved base.
check_branch() {
  local base
  base="$(resolve_base)"
  echo "restricted-path guard: diffing ${base}..HEAD"
  git -C "$REPO_ROOT" diff --name-only "$base" HEAD | evaluate_paths
}

# self_test — prove the guard can fail before trusting a green from it.
self_test() {
  local ok=0 tmp rc
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand $tmp now, at trap-install time
  trap "rm -rf '$tmp'" EXIT

  # (1) NEGATIVE FIXTURE: a restricted path AND the plugin — must FAIL.
  cat >"$tmp/violation" <<'EOF'
plugins/robotmoney-swarm/scripts/form-vote.sh
clients/rust-payment-client/src/cli.rs
EOF
  echo "[self-test] negative fixture (restricted path + swarm plugin) must FAIL"
  rc=0
  evaluate_paths <"$tmp/violation" >/dev/null 2>&1 || rc=$?
  if [[ $rc -eq 1 ]]; then
    echo "[self-test] OK: coupling violation correctly rejected."
  else
    echo "[self-test] FAIL: coupling violation was accepted (exit $rc) — the guard cannot fail." >&2
    ok=1
  fi

  # (2) A restricted path with no plugin change — must PASS (issue #1232's
  #     second defect: this guard is not a veto over rust-client PRs).
  cat >"$tmp/restricted-only" <<'EOF'
clients/rust-payment-client/src/cli.rs
contracts/RobotMoneyVault.sol
EOF
  echo "[self-test] restricted paths alone (no plugin change) must PASS"
  rc=0
  evaluate_paths <"$tmp/restricted-only" >/dev/null 2>&1 || rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "[self-test] OK: rust-client-only change correctly accepted."
  else
    echo "[self-test] FAIL: rust-client-only change was rejected (exit $rc) — the guard is out of scope." >&2
    ok=1
  fi

  # (3) A plugin-only change — must PASS.
  cat >"$tmp/plugin-only" <<'EOF'
plugins/robotmoney-swarm/tests/run-tests.sh
plugins/robotmoney-swarm/skills/robotmoney-swarm/SKILL.md
EOF
  echo "[self-test] swarm-plugin-only change must PASS"
  rc=0
  evaluate_paths <"$tmp/plugin-only" >/dev/null 2>&1 || rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "[self-test] OK: plugin-only change correctly accepted."
  else
    echo "[self-test] FAIL: plugin-only change was rejected (exit $rc)." >&2
    ok=1
  fi

  # (4) LOUD-SKIP: an unresolvable base must exit 2, never PASS. This is the
  #     regression test for the depth-1 clone that made the guard a no-op.
  echo "[self-test] an unresolvable base commit must exit 2 (never PASS)"
  rc=0
  SWARM_RESTRICTED_BASE_SHA=0000000000000000000000000000000000000000 \
    bash "${BASH_SOURCE[0]}" >/dev/null 2>&1 || rc=$?
  if [[ $rc -eq 2 ]]; then
    echo "[self-test] OK: unresolvable base fails loudly."
  else
    echo "[self-test] FAIL: unresolvable base exited $rc, expected 2 — a guard that cannot" >&2
    echo "           determine its input must go red, not report success." >&2
    ok=1
  fi

  if [[ $ok -eq 0 ]]; then
    echo "[self-test] PASS: the guard fires on a coupling violation, accepts both non-violating shapes, and reds out on an unresolvable base."
  fi
  return "$ok"
}

main() {
  case "${1:-}" in
    --self-test)
      self_test
      ;;
    --paths-from)
      [[ -n "${2:-}" && -f "$2" ]] || {
        echo "ERROR: --paths-from needs a readable file." >&2
        exit 2
      }
      evaluate_paths <"$2"
      ;;
    "")
      check_branch
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      exit 2
      ;;
  esac
}

main "$@"
