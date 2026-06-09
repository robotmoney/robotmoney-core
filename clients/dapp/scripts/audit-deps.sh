#!/usr/bin/env bash
# Dependency vulnerability gate for the dApp.
# Canonical: docs/technical/security-model.md §8
#
# Runs `bun audit --audit-level=high`, which exits non-zero on any high or
# critical (CVSS >= 7.0) advisory in the resolved dependency tree. This matches
# the threshold used by the Rust `cargo audit` gate in suite-04.
#
# We use `bun audit` (not `npm audit`) because the dApp's lockfile is bun.lock;
# `npm audit` requires a package-lock.json and fails with ENOLOCK here.
#
# ACCEPTED ADVISORIES
# Each id below is a pre-existing high/critical advisory in a transitive
# dependency that cannot yet be upgraded without a breaking change. They are
# suppressed so the gate has a green baseline and blocks merges on any NEW
# high/critical advisory. Every entry MUST carry a dated justification.
# Re-evaluate on or before each expiry; remove once the upstream fix lands.
set -euo pipefail

# Format: "<GHSA-id> # <package>: <reason>. expires: <YYYY-MM-DD>"
ACCEPTED_ADVISORIES=(
  # axios (transitive via wagmi > @wagmi/connectors > @base-org/account >
  # @coinbase/cdp-sdk). The dApp does not issue axios HTTP requests itself;
  # axios is only reachable through the wallet-connector SDK. Pinned upstream.
  "GHSA-q8qp-cvcw-x6jj" # axios: prototype pollution read-side gadgets. expires: 2026-12-01
  "GHSA-pjwm-pj3p-43mv" # axios: NO_PROXY bypass via IPv4-mapped IPv6. expires: 2026-12-01
  "GHSA-3g43-6gmg-66jw" # axios: credential theft via config-merge gadget. expires: 2026-12-01
  "GHSA-35jp-ww65-95wh" # axios: MITM via config.proxy gadget. expires: 2026-12-01
  "GHSA-hfxv-24rg-xrqf" # axios: ReDoS via cookie name injection. expires: 2026-12-01
  "GHSA-777c-7fjr-54vf" # axios: unbounded resource allocation. expires: 2026-12-01
  "GHSA-p92q-9vqr-4j8v" # axios: proxy-auth leak across http->https redirect. expires: 2026-12-01
  "GHSA-j5f8-grm9-p9fc" # axios: proxy-auth header leak on direct re-eval. expires: 2026-12-01
  "GHSA-pmwg-cvhr-8vh7" # axios: NO_PROXY 127.0.0.0/8 bypass. expires: 2026-12-01
  "GHSA-pf86-5x62-jrwf" # axios: prototype pollution gadgets. expires: 2026-12-01
  "GHSA-6chq-wfr3-2hj9" # axios: header injection via prototype pollution. expires: 2026-12-01
  # vitest (dev/test dependency, never shipped to users). The advisory only
  # applies when the Vitest UI server is listening, which CI never enables.
  "GHSA-5xrq-8626-4rwp" # vitest: arbitrary file read via UI server. expires: 2026-12-01
)

ignore_args=()
for entry in "${ACCEPTED_ADVISORIES[@]}"; do
  # Each array entry is "<id> # <comment>"; keep only the leading id.
  id="${entry%%#*}"
  id="${id// /}"
  [ -n "$id" ] || continue
  ignore_args+=(--ignore "$id")
done

echo "Running bun audit --audit-level=high (${#ACCEPTED_ADVISORIES[@]} accepted advisories suppressed)"
exec bun audit --audit-level=high "${ignore_args[@]}"
