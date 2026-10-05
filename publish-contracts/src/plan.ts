// The stage plan: the part of a run that depends on the core DEPLOY_SHA and nothing else. Two invocations that differ only in
// chain, RPC, sheet, signer and environment produce the same plan for the same DEPLOY_SHA.
import type { FrozenCounts } from "./counts.ts";
import { STAGES, expectedStartNonce } from "./stages.ts";

export interface PlanRow { stage: string; kind: string; script: string | null; countKey: string | null; expectedCount: number | null; startNonce: number | null; manifest: string | null; vault: string | null }

export function stagePlan(counts: FrozenCounts): PlanRow[] {
  return STAGES.map((s) => ({
    stage: s.name, kind: s.kind, script: s.script ?? null, countKey: s.countKey,
    expectedCount: s.countKey === null ? null : counts[s.countKey] ?? null,
    startNonce: s.countKey === null ? null : expectedStartNonce(s.name, counts),
    manifest: s.manifest ?? null, vault: s.vault ?? null,
  }));
}

export interface OwnerException { text: string; recorded_at: string }

/**
 * Owner exceptions are recorded BEFORE the plan is approved. Each entry needs text and a recorded_at time earlier than plan_approved_at.
 * A placeholder (<...>) or an entry recorded at or after approval is refused. An empty list is valid: no exception was granted.
 */
export function assertOwnerExceptions(exceptions: unknown, planApprovedAt: string | undefined): void {
  if (!Array.isArray(exceptions)) throw new Error("owner_exceptions must be a list (empty when none was granted)");
  if (!planApprovedAt || Number.isNaN(Date.parse(planApprovedAt))) throw new Error("plan_approved_at must be an ISO time");
  const approved = Date.parse(planApprovedAt);
  exceptions.forEach((e, i) => {
    const x = e as Partial<OwnerException>;
    if (!x || typeof x.text !== "string" || x.text.trim() === "" || /^<.*>$/.test(x.text.trim())) throw new Error(`owner_exceptions[${i}] has no real text`);
    if (typeof x.recorded_at !== "string" || Number.isNaN(Date.parse(x.recorded_at))) throw new Error(`owner_exceptions[${i}] has no recorded_at time`);
    if (Date.parse(x.recorded_at) >= approved) throw new Error(`owner_exceptions[${i}] was recorded at ${x.recorded_at}, not before the plan approval at ${planApprovedAt}`);
  });
}
