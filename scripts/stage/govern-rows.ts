// Govern output parser. Reads the govern run's stdout (one JSON line per row:
// {"row":"set-quorum","txHash":"0x..","status":1}) and exits non-zero unless
// every row has a 32-byte tx hash and receipt status 1. Used by
// bun scripts/stage/core-stack.ts and asserted by govern-rows.test.ts.
// Canonical: robotmoney/devops issue 53 / core issue 1499 (stage 13 govern).

export interface GovernRow {
  row: string;
  txHash: string;
  status: number | string;
}

const HASH = /^0x[0-9a-fA-F]{64}$/;

export function parseRows(stdout: string): GovernRow[] {
  const rows: GovernRow[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const j = JSON.parse(t);
      if (typeof j.row === "string") rows.push(j as GovernRow);
    } catch {
      // not a row line
    }
  }
  return rows;
}

const statusOne = (s: number | string): boolean => s === 1 || s === "1" || s === "0x1" || s === "success";

/** Returns one problem string per bad row. Empty means every row is good. */
export function checkRows(rows: GovernRow[], minRows = 1): string[] {
  const problems: string[] = [];
  if (rows.length < minRows) problems.push(`want at least ${minRows} govern row(s), found ${rows.length}`);
  for (const r of rows) {
    if (!HASH.test(r.txHash ?? "")) problems.push(`row ${r.row}: no tx hash ('${r.txHash ?? ""}')`);
    if (!statusOne(r.status)) problems.push(`row ${r.row}: receipt status '${r.status}', want 1`);
  }
  return problems;
}

if (import.meta.main) {
  const text = await Bun.stdin.text();
  const problems = checkRows(parseRows(text));
  if (problems.length) {
    for (const p of problems) console.error(`govern-rows: ${p}`);
    process.exit(1);
  }
  console.error(`govern-rows: ${parseRows(text).length} row(s), every one has a tx hash and receipt status 1`);
}
