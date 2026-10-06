// Label diff: the verifier label set on stage must equal the verifier label set on mainnet.
// Usage: bun scripts/stage/label-diff.ts <stage-labels> <mainnet-labels>
// Each file is the verifier's `--json` output (one {"label":...} object per line)
// or a plain list with one label per line. Exits non-zero on ANY difference.
// Canonical: core issue 1499 (S8, S9; core 1488).
import { readFileSync } from "node:fs";

export function parseLabels(text: string): string[] {
  const out: string[] = [];
  // devops prints `[verify]` and then one label per line; the committed mainnet file has [verify], [canary] and [acceptance]. A plain label counts
  // only in the [verify] section (or when the text has no section header at all).
  let section: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const head = /^\[([a-z-]+)\]$/.exec(line);
    if (head) { section = head[1]!; continue; }
    if (line.startsWith("{")) {
      try {
        const j = JSON.parse(line);
        if (typeof j.label === "string") out.push(j.label);
      } catch {
        // not a label row
      }
    } else if (/^(PASS|FAIL)\s+/.test(line)) {
      out.push(line.replace(/^(PASS|FAIL)\s+/, "").replace(/:.*$/, "").trim());
    } else if (!line.startsWith("RESULT:") && !line.startsWith("#") && (section === null || section === "verify")) {
      out.push(line);
    }
  }
  return out;
}

export function labelDiff(stage: string[], mainnet: string[]): { onlyStage: string[]; onlyMainnet: string[] } {
  const s = new Set(stage);
  const m = new Set(mainnet);
  return {
    onlyStage: [...s].filter((l) => !m.has(l)).sort(),
    onlyMainnet: [...m].filter((l) => !s.has(l)).sort(),
  };
}

if (import.meta.main) {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) {
    console.error("usage: bun scripts/stage/label-diff.ts <stage-labels> <mainnet-labels>");
    process.exit(64);
  }
  const stage = parseLabels(readFileSync(a, "utf8"));
  const mainnet = parseLabels(readFileSync(b, "utf8"));
  if (stage.length === 0 || mainnet.length === 0) {
    console.error(`label-diff: an empty label set (stage ${stage.length}, mainnet ${mainnet.length}) proves nothing`);
    process.exit(1);
  }
  const d = labelDiff(stage, mainnet);
  for (const l of d.onlyStage) console.error(`label-diff: only on stage: ${l}`);
  for (const l of d.onlyMainnet) console.error(`label-diff: only on mainnet: ${l}`);
  if (d.onlyStage.length || d.onlyMainnet.length) process.exit(1);
  console.log(`label-diff: ${new Set(stage).size} labels, identical on stage and mainnet`);
}
