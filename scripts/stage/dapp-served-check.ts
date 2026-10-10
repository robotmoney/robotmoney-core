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

async function main(argv: string[]): Promise<number> {
  const base = argv[0]?.replace(/\/+$/, "");
  const expectedClass = argv[1] ?? "mainnet";
  if (!base || !/^https?:\/\//.test(base)) {
    console.error("usage: bun scripts/stage/dapp-served-check.ts <dapp url> [expected class, default mainnet]");
    return 2;
  }
  const cfg = await fetch(`${base}/config.json`);
  const html = await (await fetch(`${base}/`)).text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]!);
  let bundleText = "";
  for (const a of assets) bundleText += await (await fetch(`${base}${a}`)).text();
  const checks = judgeServed({ configBody: await cfg.text(), configContentType: cfg.headers.get("content-type"), bundleText, expectedClass });
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`);
  return checks.every((c) => c.ok) ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
