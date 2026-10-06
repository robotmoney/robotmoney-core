#!/usr/bin/env bun
// Asserts the verifier label set of a rehearsal run: reads the JSON log lines of the verify stage (stderr of the CLI) and the sheet
// fragment, and fails on any label that is not ok, on a missing required label, or on a verifier that did not run.
// The Safe owners and threshold come from the fragment (the throwaway keys), so the check is "the real Safe has the sheet's owners
// and threshold", read back by the one verifier.
// bun src/ci/assert-verify-labels.ts --log FILE --fragment FILE
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

export const REQUIRED_SAFE_LABELS = [
  "safe: has code",
  "safe: owners equal sheet",
  "safe: threshold equals sheet",
  "safe: threshold at least 2",
  "safe: threshold below owner count",
  "safe: owner count at least 3",
] as const;

export interface LabelRow { label: string; ok: boolean }

export function verifyLabels(logText: string): LabelRow[] {
  const rows: LabelRow[] = [];
  for (const l of logText.split("\n")) {
    if (!l.trim().startsWith("{")) continue;
    let j: { event?: string; label?: string; ok?: boolean };
    try { j = JSON.parse(l); } catch { continue; }
    if (j.event === "verify.check" && typeof j.label === "string") rows.push({ label: j.label, ok: j.ok === true });
  }
  return rows;
}

export function fragmentSafe(fragment: string): { owners: string[]; threshold: number } {
  const val = (n: string) => new RegExp(`^${n}=(.*)$`, "m").exec(fragment)?.[1]?.trim();
  const owners = (val("SAFE_OWNERS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const threshold = Number(val("SAFE_THRESHOLD"));
  if (owners.length < 3) throw new Error("the sheet fragment has fewer than 3 SAFE_OWNERS");
  if (!Number.isInteger(threshold) || threshold < 2 || threshold >= owners.length) throw new Error(`the sheet fragment SAFE_THRESHOLD '${threshold}' is not 2 <= t < owners`);
  return { owners, threshold };
}

/** Returns the problems. Empty means the verifier ran, every label is ok and the Safe labels are all present. */
export function assertLabels(logText: string, fragment: string): string[] {
  const problems: string[] = [];
  try { fragmentSafe(fragment); } catch (e) { problems.push((e as Error).message); }
  const rows = verifyLabels(logText);
  if (rows.length === 0) problems.push("no verify.check line in the log: the verify stage did not run");
  for (const r of rows) if (!r.ok) problems.push(`label not ok: ${r.label}`);
  for (const need of REQUIRED_SAFE_LABELS) if (!rows.some((r) => r.label === need)) problems.push(`label missing: ${need}`);
  return problems;
}

if (import.meta.main) {
  const { values: v } = parseArgs({ args: process.argv.slice(2), strict: true, options: { log: { type: "string" }, fragment: { type: "string" } } });
  if (!v.log || !v.fragment) { console.error("usage: assert-verify-labels --log FILE --fragment FILE"); process.exit(2); }
  const problems = assertLabels(readFileSync(v.log, "utf8"), readFileSync(v.fragment, "utf8"));
  if (problems.length) { for (const p of problems) console.error(`verify labels: ${p}`); process.exit(1); }
  console.log("verify labels: all ok");
}
