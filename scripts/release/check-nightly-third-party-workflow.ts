#!/usr/bin/env bun
/**
 * Exit 0 only when the nightly third-party drift workflow has no active schedule
 * trigger and declares workflow_dispatch (core 1497: ships disabled).
 *
 * Usage: bun scripts/release/check-nightly-third-party-workflow.ts [FILE]
 * Default FILE: .github/workflows/nightly-third-party-drift.yml
 * Exit: 0 disabled as required; 1 violation; 2 unreadable.
 */
import { existsSync, readFileSync } from "node:fs";

const file = process.argv[2] ?? ".github/workflows/nightly-third-party-drift.yml";
if (!existsSync(file)) {
  console.error(`missing ${file}`);
  process.exit(2);
}
const doc = Bun.YAML.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
// YAML 1.1 parsers may read the bare key `on` as boolean true.
const on = (doc.on ?? doc["true"]) as Record<string, unknown> | string | string[] | undefined;
const keys = on === undefined ? [] : typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on);
let bad = 0;
if (keys.includes("schedule")) { console.error("active schedule trigger present"); bad++; }
if (!keys.includes("workflow_dispatch")) { console.error("workflow_dispatch not declared"); bad++; }
for (const k of keys) if (k !== "workflow_dispatch" && k !== "schedule") { console.error(`unexpected trigger: ${k}`); bad++; }
if (bad) process.exit(1);
console.log("ok: workflow_dispatch only, no active schedule");
