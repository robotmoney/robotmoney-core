// RM_PARKED test support (core issue 1903, ADR-0015, owner decision 2026-10-21).
//
// The committed config/agent-token-shortlist.json parks RM under `parked.entries` and ships an empty `shortlist`. The publish-contracts tests that
// need RM and its V4 pool (the recorder wait, the verifier's V4 expectations, the config-check of the V4 pool) run on a COPY of the committed
// config with RM moved back into the shortlist, which is exactly the reactivation move. They are not skipped, no bound is lowered and no pool is
// seeded. `RM_PARKED` is true exactly while the committed config parks RM.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG = join(import.meta.dir, "..", "..", "config", "agent-token-shortlist.json");

type AgentJson = { shortlist: Record<string, unknown>[]; parked?: { entries?: Record<string, unknown>[] }; [k: string]: unknown };
const committed = (): AgentJson => JSON.parse(readFileSync(CONFIG, "utf8")) as AgentJson;

/** RM_PARKED: the committed config holds RM under parked.entries. */
export const RM_PARKED: boolean = (committed().parked?.entries ?? []).length > 0;

/** The committed config with parked.entries moved back into the shortlist (the reactivated config). */
export function activatedAgentConfig(): AgentJson {
  const j = committed();
  return { ...j, shortlist: [...j.shortlist, ...(j.parked?.entries ?? [])], parked: { ...j.parked, entries: [] } };
}

/** The RM entry, wherever the committed config keeps it. */
export function rmEntry(): Record<string, any> {
  return activatedAgentConfig().shortlist[0] as Record<string, any>;
}

/** Writes the reactivated agent config to `dest` (a file path). */
export function writeActivatedAgentConfig(dest: string): void {
  writeFileSync(dest, JSON.stringify(activatedAgentConfig(), null, 2));
}
