// Issue 2047: structural test of docs/operations/governance-assurance-checks.md.
// Every check row has id, threat, timing, data source and RPC cost, and its verifier check is a label
// text found in src/verify/ or the word `deferred`.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SPEC = join(import.meta.dir, "..", "..", "..", "docs", "operations", "governance-assurance-checks.md");
const VERIFY_DIR = join(import.meta.dir, "..", "..", "src", "verify");
const COLUMNS = ["ID", "Threat", "Timing", "Data source", "RPC cost", "Verifier check"] as const;
const TIMINGS = new Set(["deploy", "run"]);
const COSTS = new Set(["calls", "receipts", "window", "scan"]);

type Row = Record<(typeof COLUMNS)[number], string>;

/** Parse the checks table: the one whose header equals COLUMNS. */
export function parseRows(md: string): Row[] {
  const lines = md.split("\n").map((l) => l.trim());
  const split = (l: string) => l.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const h = lines.findIndex((l) => l.startsWith("|") && split(l).join("|") === COLUMNS.join("|"));
  if (h < 0) throw new Error("checks table header not found");
  const rows: Row[] = [];
  for (const l of lines.slice(h + 2)) {
    if (!l.startsWith("|")) break;
    const cells = split(l);
    const row = {} as Row;
    COLUMNS.forEach((c, i) => { row[c] = cells[i] ?? ""; });
    rows.push(row);
  }
  return rows;
}

/** Problems of one row; empty when the row is well-formed and mapped. */
export function rowProblems(row: Row, verifySource: string): string[] {
  const p: string[] = [];
  for (const c of COLUMNS) if (!row[c]) p.push(`${row.ID || "?"}: missing ${c}`);
  if (row.ID && !/^GA-[A-Z]+-\d{2}$/.test(row.ID)) p.push(`${row.ID}: bad id`);
  if (row.Timing && !row.Timing.split(",").map((t) => t.trim()).every((t) => TIMINGS.has(t))) p.push(`${row.ID}: bad timing ${row.Timing}`);
  if (row["RPC cost"] && !COSTS.has(row["RPC cost"])) p.push(`${row.ID}: bad RPC cost ${row["RPC cost"]}`);
  if (row["RPC cost"] === "scan") p.push(`${row.ID}: a full log scan is not RPC-feasible`);
  const v = row["Verifier check"];
  if (v && v !== "deferred" && !verifySource.includes(v)) p.push(`${row.ID}: verifier check not found in src/verify: ${v}`);
  return p;
}

const verifySource = readdirSync(VERIFY_DIR).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(VERIFY_DIR, f), "utf8")).join("\n");

describe("governance-spec", () => {
  const rows = parseRows(readFileSync(SPEC, "utf8"));

  test("the spec has check rows covering Safe, timelock, roles and upgrades", () => {
    for (const area of ["SAFE", "TL", "ROLE", "UPG"]) expect(rows.some((r) => r.ID.startsWith(`GA-${area}-`))).toBe(true);
  });

  test("every row has the fields and maps to a verifier check or is deferred", () => {
    expect(rows.flatMap((r) => rowProblems(r, verifySource))).toEqual([]);
  });

  test("ids are unique", () => {
    expect(new Set(rows.map((r) => r.ID)).size).toBe(rows.length);
  });

  test("negative fixture: a row missing threat or timing fails", () => {
    const md = [
      "| ID | Threat | Timing | Data source | RPC cost | Verifier check |",
      "|----|--------|--------|-------------|----------|----------------|",
      "| GA-X-01 |  | deploy | `nonce()` | calls | deferred |",
      "| GA-X-02 | a threat |  | `nonce()` | calls | deferred |",
      "| GA-X-03 | a threat | run | `nonce()` | calls | no such verifier label |",
    ].join("\n");
    const [a, b, c] = parseRows(md).map((r) => rowProblems(r, verifySource));
    expect(a).toContain("GA-X-01: missing Threat");
    expect(b).toContain("GA-X-02: missing Timing");
    expect(c.some((m) => m.includes("verifier check not found"))).toBe(true);
  });
});
