import type { Check, VerifyReport } from "./types.ts";

/** Accumulates checks. A thrown error inside a check becomes a failed check with the same stable label. */
export class Collector {
  readonly checks: Check[] = [];
  private seen = new Set<string>();

  push(label: string, ok: boolean, detail: string): void {
    if (this.seen.has(label)) throw new Error(`verifier bug: duplicate check label "${label}"`);
    this.seen.add(label);
    this.checks.push({ label, ok, detail });
  }

  pass(label: string, detail = "ok"): void { this.push(label, true, detail); }
  fail(label: string, detail: string): void { this.push(label, false, detail); }

  eq(label: string, got: unknown, want: unknown): void {
    const g = norm(got), w = norm(want);
    this.push(label, g === w, g === w ? `${g}` : `got ${g}, want ${w}`);
  }

  async run(label: string, fn: () => Promise<boolean | { ok: boolean; detail: string }>): Promise<void> {
    try {
      const r = await fn();
      if (typeof r === "boolean") this.push(label, r, r ? "ok" : "condition false");
      else this.push(label, r.ok, r.detail);
    } catch (e: any) {
      this.push(label, false, `error: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 300)}`);
    }
  }

  /** Read a value then compare it with eq semantics. */
  async runEq(label: string, get: () => Promise<unknown>, want: unknown): Promise<void> {
    try { this.eq(label, await get(), want); }
    catch (e: any) { this.push(label, false, `error: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 300)}`); }
  }

  report(): VerifyReport {
    return { ok: this.checks.length > 0 && this.checks.every((c) => c.ok), checks: this.checks };
  }
}

export function norm(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return v.toLowerCase();
  if (Array.isArray(v)) return v.map(norm).join(",");
  return String(v).toLowerCase();
}
