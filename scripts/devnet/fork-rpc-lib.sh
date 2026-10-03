# shellcheck shell=bash
# Shared Base fork-RPC helpers (issue #1239). Source it; do not execute it.
#
# Canonical: docs/development/ci-suites.md §1–2 ("Live-RPC fork steps").
#
# One place owns three things every live-RPC caller used to repeat:
#
#   1. The public fallback endpoints used when the RMPC_FORK_RPC_URL Actions
#      variable is unset. Workflows pass the raw variable and let a script
#      resolve the fallback, so the list is not copied into YAML expressions.
#   2. Reducing an endpoint to its origin (scheme://host[:port]) for logs and
#      manifests, so a keyed provider URL never lands in either.
#   3. Redacting a configured endpoint out of tool output. forge prints the full
#      request URL on a transport failure ("HTTP request to <url> failed"), and
#      a keyed provider embeds its API key in that URL.
#
# ORDER OF THE PUBLIC ENDPOINTS
# mainnet.base.org comes first because it serves historical state for a
# numeric block tag. base-rpc.publicnode.com refuses any numeric-block state
# read with "Archive requests require a personal token" (measured 2026-09-28:
# refused even at tip-100 by number, served at tip-5000 by block hash). forge
# forks by block hash, so publicnode still works for the merge-gating fork
# steps. `cast storage --block N` and snapshot-fork.ts do not, which is why the
# old publicnode default could never complete a fixture capture. publicnode
# stays second as a fallback with a separate rate-limit budget.

FORK_RPC_PUBLIC_ENDPOINTS_DEFAULT="https://mainnet.base.org https://base-rpc.publicnode.com"

# Prints the public fallback endpoints, one per line. FORK_RPC_PUBLIC_ENDPOINTS
# (space-separated) overrides the default; the offline tests use it to point
# at stubs.
fork_rpc_public_endpoints() {
  local list="${FORK_RPC_PUBLIC_ENDPOINTS:-$FORK_RPC_PUBLIC_ENDPOINTS_DEFAULT}"
  local ep
  for ep in $list; do
    printf '%s\n' "$ep"
  done
}

# The first public fallback endpoint.
fork_rpc_default_endpoint() {
  fork_rpc_public_endpoints | head -n 1
}

# Prints scheme://host[:port] for a URL, dropping userinfo, path, query and
# fragment. Anything that does not parse as scheme://authority prints
# "<unparseable RPC URL>" rather than echoing the input.
fork_rpc_origin() {
  local url="${1:-}" scheme rest authority
  case "$url" in
    *://*) ;;
    *) printf '%s\n' '<unparseable RPC URL>'; return 0 ;;
  esac
  scheme="${url%%://*}"
  rest="${url#*://}"
  authority="${rest%%[/?#]*}"
  authority="${authority##*@}"
  if [ -z "$scheme" ] || [ -z "$authority" ]; then
    printf '%s\n' '<unparseable RPC URL>'
    return 0
  fi
  printf '%s://%s\n' "$scheme" "$authority"
}

# Filters stdin to stdout, replacing every occurrence of the URL given as $1
# with "<redacted:ORIGIN>". It also redacts the URL's path+query on its own,
# because a client may print a normalised form of the URL (added trailing
# slash, re-encoded characters) in which the full string no longer matches but
# the key-bearing path still does. An empty $1 passes stdin through unchanged.
fork_rpc_redact() {
  local url="${1:-}"
  if [ -z "$url" ]; then
    cat
    return 0
  fi
  local origin rest tail=""
  origin="$(fork_rpc_origin "$url")"
  rest="${url#*://}"
  case "$rest" in
    */*|*\?*) tail="${rest#"${rest%%[/?]*}"}" ;;
  esac
  # A bare "/" or empty tail carries no key; redacting it would mangle output.
  case "$tail" in
    ''|/) tail="" ;;
  esac
  FORK_RPC_REDACT_URL="${url%/}" FORK_RPC_REDACT_TAIL="${tail%/}" \
    FORK_RPC_REDACT_LABEL="<redacted:${origin}>" \
    perl -pe '
      BEGIN { $u = $ENV{FORK_RPC_REDACT_URL}; $t = $ENV{FORK_RPC_REDACT_TAIL}; $l = $ENV{FORK_RPC_REDACT_LABEL}; }
      s/\Q$u\E/$l/g if length $u;
      s/\Q$t\E/<redacted>/g if length $t;
    '
}

# fork_rpc_retry <command...>   (nightly fresh snapshot, issue #1496)
#
# Runs a command that reads from a public Base endpoint and retries it when the
# endpoint rate-limits (HTTP 429, "Too Many Requests", "rate limit"). The public
# endpoints above are shared and 429 under a burst of reads. Any other failure
# is returned at once: a retry must never hide a real error. stdout of the
# successful attempt is passed through; stderr of every attempt goes to stderr.
#
#   FORK_RPC_RETRY_MAX      attempts (default 8)
#   FORK_RPC_RETRY_SLEEP    first back-off in seconds, doubled each attempt,
#                           capped at 60 (default 2)
fork_rpc_retry() {
  local max="${FORK_RPC_RETRY_MAX:-8}" delay="${FORK_RPC_RETRY_SLEEP:-2}"
  local attempt=1 out err_file rc
  err_file="$(mktemp)"
  while :; do
    rc=0
    out="$("$@" 2>"$err_file")" || rc=$?
    if [ "$rc" -eq 0 ]; then
      cat "$err_file" >&2
      rm -f "$err_file"
      printf '%s' "$out"
      [ -z "$out" ] || printf '\n'
      return 0
    fi
    cat "$err_file" >&2
    if [ "$attempt" -ge "$max" ] || \
       ! { grep -qiE '429|too many requests|rate.?limit' "$err_file" || \
           printf '%s' "$out" | grep -qiE '429|too many requests|rate.?limit'; }; then
      rm -f "$err_file"
      printf '%s' "$out"
      return "$rc"
    fi
    echo "[fork-rpc] rate limited (attempt $attempt/$max); retrying in ${delay}s" >&2
    sleep "$delay"
    delay=$((delay * 2))
    [ "$delay" -le 60 ] || delay=60
    attempt=$((attempt + 1))
  done
}
