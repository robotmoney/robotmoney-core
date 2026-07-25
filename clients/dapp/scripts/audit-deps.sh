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
  # esbuild (build-time only, transitive via vite 5, which pins esbuild ^0.21;
  # the fixed 0.28.1 requires a major vite upgrade). The advisory affects only
  # esbuild's Deno install path, which downloads its binary without integrity
  # verification; this repo installs via bun/npm, never Deno.
  "GHSA-gv7w-rqvm-qjhr" # esbuild: Deno-path binary integrity RCE. expires: 2026-12-01
  # ws (transitive via viem > isows, wagmi's WalletConnect connector, jsdom, and
  # @vitest/browser). The memory-exhaustion DoS requires a malicious WebSocket peer
  # sending crafted tiny fragments; the dApp only opens WS connections to known RPC /
  # WalletConnect endpoints, and the test-only consumers (jsdom, vitest) never listen.
  "GHSA-96hv-2xvq-fx4p" # ws: memory exhaustion DoS from tiny fragments/chunks. expires: 2026-12-01
  # vite (build-time / dev-server only, transitive via @tailwindcss/vite,
  # @vitejs/plugin-react, and vitest). The server.fs.deny bypass affects only the dev
  # server on Windows alternate-path forms; production serves a static prebuilt bundle
  # and CI runs on Linux. Fixed in vite >6.4.2, which is a major-version upgrade.
  "GHSA-fx2h-pf6j-xcff" # vite: server.fs.deny bypass on Windows alternate paths. expires: 2026-12-01
  # form-data (transitive, via the axios/wallet-connector SDK chain already noted
  # above). The CRLF injection requires the app to build a multipart form with
  # attacker-controlled field/file names; the dApp never constructs multipart
  # requests itself — form-data is only reachable through the pinned wallet SDK.
  "GHSA-hmw2-7cc7-3qxx" # form-data: CRLF injection via unescaped multipart field names. expires: 2026-12-01
  # hono (transitive via wagmi > @wagmi/connectors > porto). The CORS-middleware
  # advisory only triggers when an app mounts hono's CORS middleware with the
  # origin left at its wildcard default while sending credentials; the dApp never
  # runs hono itself — hono is only reachable through the pinned porto wallet SDK.
  "GHSA-88fw-hqm2-52qc" # hono: CORS middleware reflects any Origin with credentials on wildcard default. expires: 2026-12-01
  # brace-expansion (build-time dev tooling only, transitive via minimatch under
  # eslint's @eslint/eslintrc, eslint-plugin-react, and @typescript-eslint's
  # typescript-estree). The DoS requires attacker-controlled glob patterns; eslint
  # and tsc only ever expand the repo's own committed config/source globs, never
  # untrusted input, and none of this ships in the production bundle. No patched
  # 1.x exists (1.1.16 is the newest 1.x line, which eslint 8's minimatch@3 pins),
  # and brace-expansion 5.x's CJS export shape breaks that minimatch@3.
  "GHSA-mh99-v99m-4gvg" # brace-expansion: DoS via unbounded expansion length. expires: 2026-12-01
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
