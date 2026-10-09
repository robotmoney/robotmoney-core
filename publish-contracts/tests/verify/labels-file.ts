// Reads and rewrites the committed verifier-labels.txt. Its [verify] section is derived from fixtures/expected-labels.json by the label drift test
// in verify.test.ts (core 1604). The [canary] and [acceptance] sections come from the post-deploy checks and are kept as they are.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LABELS_TXT = join(import.meta.dir, "..", "fixtures", "verifier-labels.txt");

/** The labels under [verify]: no comments, no other section. */
export function verifySection(text: string): string[] {
  const out: string[] = [];
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const head = /^\[([a-z-]+)\]$/.exec(line);
    if (head) { section = head[1]!; continue; }
    if (section === "verify") out.push(line);
  }
  return out;
}

/** The file text with its [verify] section replaced by `labels`. */
export function withVerifySection(text: string, labels: string[]): string {
  const lines = text.split("\n");
  const start = lines.indexOf("[verify]");
  let end = lines.findIndex((l, i) => i > start && /^\[[a-z-]+\]$/.test(l.trim()));
  if (start < 0 || end < 0) throw new Error("verifier-labels.txt needs a [verify] section followed by another section");
  return [...lines.slice(0, start + 1), ...labels, ...lines.slice(end)].join("\n");
}

export function rewriteLabelsTxt(labels: string[]): void {
  writeFileSync(LABELS_TXT, withVerifySection(readFileSync(LABELS_TXT, "utf8"), labels));
}
