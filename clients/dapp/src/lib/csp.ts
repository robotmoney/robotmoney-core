// Strict Content Security Policy and HSTS header enforcement for the dapp.
//
// Canonical: Plan tracking issue #109 "Backend and dapp hardening" — the
// security model (PRD §11 / XSS) requires the dapp be deployed with a strict
// CSP that disallows inline scripts and eval, verified in CI before public
// launch (issue #665). PRD §11 / TLS also requires HSTS preload on all dapp
// domains (issue #671).
//
// The CSP directive string is used in two places so dev, preview, container,
// CDN, and IPFS deployments are all covered:
//   1. A `<meta http-equiv="Content-Security-Policy">` tag injected into
//      index.html at build time (works regardless of the serving layer).
//   2. A real `Content-Security-Policy` HTTP header set by the Vite dev and
//      preview servers (so the CI `curl -sI` header assertion passes and
//      header-only enforcement is exercised).
//
// The HSTS header is set only on the Vite dev and preview servers so that:
//   - CI can assert the header value is correct on the containerised image.
//   - Production CDN/nginx operators copy the same directive verbatim.
// HSTS cannot be set via a <meta> tag — browsers ignore it there.
//
// Notes on CSP directives:
// - `script-src 'self'` only. Vite's production bundle emits external module
//   scripts, never inline `<script>` blocks, so no nonce/hash or
//   'unsafe-inline'/'unsafe-eval' is required.
// - `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com` — Tailwind
//   ships static CSS, but injected style attributes and the Google Fonts
//   stylesheet require inline styles. 'unsafe-inline' for *styles* does not
//   relax the script policy and is not what the security requirement forbids.
// - `connect-src` allows the wallet RPC / explorer / arbitrary https + ws so
//   the dapp can reach user-configured chains and the indexer.
import type { Plugin } from "vite";

// Ordered directive list. Keep `script-src` free of 'unsafe-inline' and
// 'unsafe-eval' — the CI guard (scripts/check-csp.mjs) and tests assert this.
const CSP_DIRECTIVES: Array<[string, string[]]> = [
  ["default-src", ["'self'"]],
  ["script-src", ["'self'"]],
  ["style-src", ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"]],
  ["font-src", ["'self'", "https://fonts.gstatic.com", "data:"]],
  ["img-src", ["'self'", "data:", "blob:"]],
  // `http://127.0.0.1:*` mirrors the `localhost` loopback allowance: the
  // smoke-test devnet exposes the Geth RPC and explorer-api on 127.0.0.1:<port>
  // (testing/smoke-test emits http://127.0.0.1 URLs), and without this the dapp's
  // own CSP blocks every devnet connection in suite-10 dapp-e2e (issue #665 CSP).
  ["connect-src", ["'self'", "https:", "wss:", "ws:", "http://localhost:*", "http://127.0.0.1:*", "http://receipt-fixtures:8097"]],
  ["worker-src", ["'self'", "blob:"]],
  ["object-src", ["'none'"]],
  ["base-uri", ["'self'"]],
  ["frame-ancestors", ["'none'"]],
  ["form-action", ["'self'"]],
];

/** The strict CSP policy as a single value string for the HTTP header. */
export const CSP_POLICY: string = CSP_DIRECTIVES.map(
  ([name, sources]) => `${name} ${sources.join(" ")}`,
).join("; ");

/**
 * Directives the HTML spec says are ignored when a CSP is delivered via a
 * `<meta>` element. Browsers also log a `console.error` for them, which fails
 * the suite-10 dapp-e2e console-error gate. They are enforced via the real HTTP
 * header instead (see `cspPlugin`), so excluding them from the meta tag loses no
 * enforcement — `frame-ancestors` in particular is a no-op in `<meta>` anyway.
 */
const META_IGNORED_DIRECTIVES = new Set(["frame-ancestors", "report-uri", "sandbox"]);

/** CSP value safe for a `<meta>` tag: the header policy minus meta-ignored directives. */
export const CSP_META_POLICY: string = CSP_DIRECTIVES.filter(
  ([name]) => !META_IGNORED_DIRECTIVES.has(name),
)
  .map(([name, sources]) => `${name} ${sources.join(" ")}`)
  .join("; ");

/**
 * HSTS header value required by the security model (PRD §11 / TLS).
 * max-age=31536000 (1 year), includeSubDomains, and preload are all required
 * for eligibility on the HSTS preload list (hstspreload.org).
 * Browsers cache this policy for one year after the first HTTPS response.
 */
export const HSTS_HEADER_VALUE = "max-age=31536000; includeSubDomains; preload";

/**
 * Vite plugin that enforces the strict CSP and HSTS header everywhere: it
 * injects a `<meta http-equiv="Content-Security-Policy">` tag into the HTML
 * and sets real `Content-Security-Policy` and `Strict-Transport-Security`
 * response headers on the dev and preview servers. See module header for the
 * rationale.
 */
export function cspPlugin(): Plugin {
  const setHeaders = (
    _req: unknown,
    res: { setHeader: (name: string, value: string) => void },
    next: () => void,
  ): void => {
    res.setHeader("Content-Security-Policy", CSP_POLICY);
    // HSTS: instruct browsers to use HTTPS only, include subdomains, and
    // register for the preload list. This header must come from the server;
    // browsers ignore HSTS in <meta> tags (RFC 6797 §8.5).
    res.setHeader("Strict-Transport-Security", HSTS_HEADER_VALUE);
    next();
  };

  return {
    name: "robotmoney-csp",
    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: "meta",
            injectTo: "head-prepend",
            attrs: {
              "http-equiv": "Content-Security-Policy",
              content: CSP_META_POLICY,
            },
          },
        ],
      };
    },
    configureServer(server) {
      server.middlewares.use(setHeaders);
    },
    configurePreviewServer(server) {
      server.middlewares.use(setHeaders);
    },
  };
}
