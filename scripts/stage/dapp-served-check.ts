// The run-day checks of what a deployed dapp serves (core issue 1731). Bun TypeScript, pure functions plus a
// small CLI: `bun scripts/stage/dapp-served-check.ts <dapp url>` prints one line per check and exits 1 on a fail.
//
// Why this exists: the runbook said "the served /config.json must not contain VITE_ENV_CLASS". On the stage
// host a missing /config.json is answered by the single page app fallback, which is index.html with HTTP 200.
// A text search of that HTML for VITE_ENV_CLASS finds nothing, so the check PASSES TRIVIALLY when no
// /config.json is served at all. The precise check parses the response as JSON, and reports the three cases
// apart. The real class check is the baked bundle (`VITE_ENV_CLASS` is build time only), checked here too.

export type ServedConfig =
  | { kind: "json-clean"; keys: string[] }
  | { kind: "json-has-env-class"; keys: string[] }
  | { kind: "not-served"; reason: string }
  | { kind: "json-not-an-object" };

/**
 * Classify the response of GET /config.json. `contentType` is the response header. A body that does not parse
 * as JSON (the SPA fallback is HTML) is `not-served`, never "clean": the check passes in that case only in
 * the sense that there is nothing to leak, and it says so.
 */
export function classifyServedConfig(body: string, contentType: string | null): ServedConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const html = /^\s*<(!doctype|html)/i.test(body) || /text\/html/i.test(contentType ?? "");
    return {
      kind: "not-served",
      reason: html
        ? "the response is HTML (the single page app fallback for a path that is not served), not JSON"
        : "the response is not JSON",
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { kind: "json-not-an-object" };
  const keys = Object.keys(parsed as Record<string, unknown>);
  return keys.includes("VITE_ENV_CLASS") ? { kind: "json-has-env-class", keys } : { kind: "json-clean", keys };
}

/** The class a built bundle carries, or undefined when it names none. `VITE_ENV_CLASS:"mainnet"` as minified. */
export function bundleEnvClass(bundleText: string): string | undefined {
  const m = /VITE_ENV_CLASS["']?\s*[:=]\s*["']([a-z]+)["']/.exec(bundleText);
  return m?.[1];
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** Turns the two served documents into the run-day verdicts. `expectedClass` is `mainnet` for the 8453 stack. */
export function judgeServed(args: {
  configBody: string;
  configContentType: string | null;
  bundleText: string;
  expectedClass: string;
}): Check[] {
  const cfg = classifyServedConfig(args.configBody, args.configContentType);
  const checks: Check[] = [];
  switch (cfg.kind) {
    case "json-clean":
      checks.push({ name: "served /config.json", ok: true, detail: `JSON object without VITE_ENV_CLASS (keys: ${cfg.keys.join(", ") || "none"})` });
      break;
    case "json-has-env-class":
      checks.push({ name: "served /config.json", ok: false, detail: "VITE_ENV_CLASS is in the served document: the class is build time only and must not be served" });
      break;
    case "json-not-an-object":
      checks.push({ name: "served /config.json", ok: false, detail: "the response is JSON but not an object" });
      break;
    case "not-served":
      checks.push({ name: "served /config.json", ok: true, detail: `no /config.json is served (${cfg.reason}); the dapp falls back to its build time values and logs a warning. This pass is trivial: only the bundle class check below proves the class` });
      break;
  }
  const cls = bundleEnvClass(args.bundleText);
  checks.push({
    name: "bundle class",
    ok: cls === args.expectedClass,
    detail: cls === undefined ? "the bundle names no VITE_ENV_CLASS" : `the bundle bakes VITE_ENV_CLASS=${cls}, expected ${args.expectedClass}`,
  });
  return checks;
}

/** What one HTTP fetch gave: a status, or null plus a message when the request itself failed (DNS, refused, timeout). */
export interface HttpResult {
  status: number | null;
  error?: string;
}

/**
 * A named failure for a fetch that did not return 2xx, or null when it did. `notFoundOk` is for /config.json,
 * where a real 404 means "no runtime config is served", which is a valid deployment (the dapp then uses its
 * build time values). Every other non-2xx and every failed request is a FAIL that names the URL path.
 */
export function httpFailure(name: string, r: HttpResult, notFoundOk = false): Check | null {
  if (r.status === null) {
    return { name, ok: false, detail: `the request failed: ${r.error ?? "no response"}` };
  }
  if (r.status >= 200 && r.status < 300) return null;
  if (notFoundOk && r.status === 404) return null;
  return { name, ok: false, detail: `HTTP ${r.status}, expected 2xx` };
}

async function get(url: string): Promise<{ res: HttpResult; text: string; contentType: string | null }> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    return { res: { status: r.status }, text: await r.text(), contentType: r.headers.get("content-type") };
  } catch (e) {
    return { res: { status: null, error: (e as Error).message }, text: "", contentType: null };
  }
}

async function main(argv: string[]): Promise<number> {
  const base = argv[0]?.replace(/\/+$/, "");
  const expectedClass = argv[1] ?? "mainnet";
  if (!base || !/^https?:\/\//.test(base)) {
    console.error("usage: bun scripts/stage/dapp-served-check.ts <dapp url> [expected class, default mainnet]");
    return 2;
  }
  const checks: Check[] = [];
  const cfg = await get(`${base}/config.json`);
  const cfgFail = httpFailure("fetch /config.json", cfg.res, true);
  if (cfgFail) checks.push(cfgFail);
  const page = await get(`${base}/`);
  const pageFail = httpFailure("fetch /", page.res);
  if (pageFail) checks.push(pageFail);
  const assets = [...page.text.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]!);
  if (!pageFail && assets.length === 0) checks.push({ name: "bundle class", ok: false, detail: "the page names no /assets/*.js bundle" });
  let bundleText = "";
  let bundleOk = !pageFail && assets.length > 0;
  for (const a of assets) {
    const b = await get(`${base}${a}`);
    const f = httpFailure(`fetch ${a}`, b.res);
    if (f) {
      checks.push(f);
      bundleOk = false;
    } else bundleText += b.text;
  }
  if (!cfgFail) {
    const body = cfg.res.status === 404 ? "" : cfg.text;
    checks.push(...judgeServed({ configBody: body, configContentType: cfg.contentType, bundleText, expectedClass }).slice(0, 1));
  }
  if (bundleOk) checks.push(...judgeServed({ configBody: "{}", configContentType: "application/json", bundleText, expectedClass }).slice(1));
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`);
  return checks.every((c) => c.ok) ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
