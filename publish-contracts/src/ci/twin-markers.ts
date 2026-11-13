#!/usr/bin/env bun
// The scenario markers of the Twin system rehearsals (issue 1892) and the guard that requires them. twin-publish.ts prints one marker line per scenario it ran; a workflow step runs
//   bun src/ci/twin-markers.ts check --log FILE --require vaultsOnly,receiptPath   (the fund run: --require fundFeeds,fundRun,fundFeedStaleRefusal)
// and fails when a required marker is missing, appears with a zero count, or the log holds none. A removed scenario therefore turns the job red instead of passing silently.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

export const MARKERS = {
  vaultsOnly: "TWIN-SCENARIO vaults-only:",
  receiptPath: "TWIN-SCENARIO receipt-path:",
  gatewayRefusals: "TWIN-SCENARIO gateway-refusals-before-broadcast:",
  gatewayRun: "TWIN-SCENARIO gateway-run:",
  // Deploy 4, the fund system's Twin run (twin-publish-fund.ts). Each names the fund in its own words, so no fund line can satisfy a vaults or gateway requirement.
  fundFeeds: "TWIN-SCENARIO fund-feeds:",
  fundRun: "TWIN-SCENARIO fund-run:",
  fundFeedStaleRefusal: "TWIN-SCENARIO fund-feed-stale-refusal:",
} as const;
export type MarkerName = keyof typeof MARKERS;
/** The markers of the vaults and gateway run (twin-publish.ts, the core-stages-twin-chain job) and of the fund run (twin-publish-fund.ts, the fund Twin pair). */
export const VAULTS_RUN_MARKERS: MarkerName[] = ["vaultsOnly", "receiptPath", "gatewayRefusals", "gatewayRun"];
export const FUND_RUN_MARKERS: MarkerName[] = ["fundFeeds", "fundRun", "fundFeedStaleRefusal"];

/** What the vaults system must not leave behind, and what the gateway system writes. */
export const GATEWAY_STAGES = ["gateway", "gateway-handover"];
export const GATEWAY_FILES = ["gateway.json", "gateway-handover.json"];
/** Verifier labels the gateway run must print (verify/gateway.ts): the handover and the chain-backed zero-agent checks. */
export const REQUIRED_GATEWAY_LABELS = [
  "gateway: ADMIN_ROLE held by the gateway admin",
  "gateway: ADMIN_ROLE not held by deployer",
  "agents: no AgentAuthorized log on the gateway up to the handover block",
  "agents: no AGENT_ROLE grant on the gateway up to the handover block",
];

/** Problems of a log against the required markers: missing, repeated with a zero count (`stages=0`, `scenarios=` empty), or no marker at all. */
export function markerProblems(log: string, required: MarkerName[]): string[] {
  const p: string[] = [];
  if (required.length === 0) p.push("no marker is required: the guard would pass an empty run");
  for (const name of required) {
    const lines = log.split("\n").filter((l) => l.startsWith(MARKERS[name]));
    if (lines.length === 0) { p.push(`required scenario marker '${MARKERS[name]}' is missing`); continue; }
    for (const l of lines) {
      if (/\b(stages|scenarios)=(0)?(\s|$)/.test(l)) p.push(`scenario marker '${MARKERS[name]}' reports a zero count: ${l}`);
    }
  }
  return p;
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { log: { type: "string" }, require: { type: "string" } } });
  if (positionals[0] !== "check" || !values.log || !values.require) { console.error("usage: twin-markers.ts check --log FILE --require name,name"); process.exit(2); }
  const required = values.require.split(",").map((s) => s.trim()).filter(Boolean) as MarkerName[];
  const unknown = required.filter((n) => !(n in MARKERS));
  if (unknown.length) { console.error(`unknown marker(s): ${unknown.join(", ")}`); process.exit(2); }
  const problems = markerProblems(readFileSync(values.log, "utf8"), required);
  if (problems.length) { for (const m of problems) console.error(`twin-markers: ${m}`); process.exit(1); }
  console.log(`twin-markers: ${required.length} required marker(s) present`);
}
