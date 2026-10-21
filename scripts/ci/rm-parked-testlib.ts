// RM_PARKED test support (core issue 1903, owner decision 2026-10-21).
//
// config/agent-token-shortlist.json parks RM under `parked.entries` and ships an empty `shortlist`. The config-check rules for the V4 RM pool
// (pool key, pool id, managers, fee, depth, code hash) still need an RM entry to run against. These helpers apply the documented reactivation move
// (parked.entries[0] back into `shortlist`) to a COPY of the config, so those tests run in full with no skip, no lowered bound and no seeded pool.
// The committed parked state has its own tests (config-check.test.ts, "RM parked").
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AGENT = "agent-token-shortlist.json";

/** Moves the parked entries back into the shortlist, exactly as the reactivation steps in the config do. Mutates `files`. */
export function activateRm(files: Record<string, any>): void {
  const agent = files[AGENT];
  agent.shortlist = [...agent.shortlist, ...(agent.parked?.entries ?? [])];
  if (agent.parked) agent.parked.entries = [];
}

/** A temp copy of `config/` with RM reactivated, then mutated. Returns the directory. */
export function activatedConfigDir(realDir: string, mutate: (files: Record<string, any>) => void = () => {}, prefix = "cfg-rm-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cpSync(realDir, dir, { recursive: true });
  const files: Record<string, any> = {};
  for (const n of readdirSync(dir)) if (n.endsWith(".json")) files[n] = JSON.parse(readFileSync(join(dir, n), "utf8"));
  activateRm(files);
  mutate(files);
  for (const [n, j] of Object.entries(files)) writeFileSync(join(dir, n), JSON.stringify(j, null, 2));
  return dir;
}
