// Strict Content Security Policy for the dapp.
//
// Canonical: docs/implementation-plan.md "Backend and dapp hardening" — the
// security model (PRD §11 / XSS) requires the dapp be deployed with a strict
// CSP that disallows inline scripts and eval, verified in CI before public
// launch (issue #665).
//
// The same directive string is used in two places so dev, preview, container,
// CDN, and IPFS deployments are all covered:
//   1. A `<meta http-equiv="Content-Security-Policy">` tag injected into
//      index.html at build time (works regardless of the serving layer).
//   2. A real `Content-Security-Policy` HTTP header set by the Vite dev and
//      preview servers (so the CI `curl -sI` header assertion passes and
//      header-only enforcement is exercised).
//
// Notes on directives:
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
  ["connect-src", ["'self'", "https:", "wss:", "ws:", "http://localhost:*"]],
  ["worker-src", ["'self'", "blob:"]],
  ["object-src", ["'none'"]],
  ["base-uri", ["'self'"]],
  ["frame-ancestors", ["'none'"]],
  ["form-action", ["'self'"]],
];

/** The strict CSP policy as a single header/meta-tag value string. */
export const CSP_POLICY: string = CSP_DIRECTIVES.map(
  ([name, sources]) => `${name} ${sources.join(" ")}`,
).join("; ");

/**
 * Vite plugin that enforces the strict CSP everywhere: it injects a
 * `<meta http-equiv="Content-Security-Policy">` tag into the HTML and sets a
 * real `Content-Security-Policy` response header on the dev and preview
 * servers. See module header for the rationale.
 */
export function cspPlugin(): Plugin {
  const setHeader = (
    _req: unknown,
    res: { setHeader: (name: string, value: string) => void },
    next: () => void,
  ): void => {
    res.setHeader("Content-Security-Policy", CSP_POLICY);
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
              content: CSP_POLICY,
            },
          },
        ],
      };
    },
    configureServer(server) {
      server.middlewares.use(setHeader);
    },
    configurePreviewServer(server) {
      server.middlewares.use(setHeader);
    },
  };
}
