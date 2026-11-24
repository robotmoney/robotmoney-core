#!/usr/bin/env bun
// The deployer ETH a release run needs on a target, from the release yaml itself: every step that runs there and sends from the deployer is counted
// (an implementation deploy: deploy-implementation or adapter-swap.ts upgrade deploy; a Safe execute: safe/cli.ts execute), at a gas bound per kind,
// priced at the run's max fee (--gas-price, cast's EIP-1559 max fee: the {safefee} list, which the runner takes from {cast}). Prints the need in wei.
//
//   bun scripts/runbook/eth-need.ts --release v0.10.0-onevault-upgrade --target twin [--from-step ID] --gas-price WEI [--priority-gas-price WEI]
//
// --from-step counts only that step and the ones after it (a resumed run). It only reads the yaml.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { QA_DIR, ROOT, applicableSteps, expandArgv, parseRelease, type RunbookStep } from "./validate-contract-qa.ts";

/** Gas bound of one implementation CREATE: an EIP-170-sized runtime (24,576 B at 200 gas a byte) plus its initcode and execution, rounded up. */
export const DEPLOY_GAS = 6_000_000n;
/** Gas bound of one Safe execTransaction carrying a timelock schedule or execute of an upgrade batch, rounded up. */
export const EXECUTE_GAS = 500_000n;

export type SendKind = "deploy" | "execute";

/** PURE. The deployer sends of one step, by kind. */
export function sendsOf(s: Pick<RunbookStep, "cmds">): SendKind[] {
  const out: SendKind[] = [];
  for (const c of s.cmds) {
    const j = expandArgv(c).join(" ");
    if (j.includes("publish-contracts/src/cli.ts deploy-implementation") || j.includes("scripts/runbook/adapter-swap.ts upgrade deploy")) out.push("deploy");
    else if (j.includes("publish-contracts/src/safe/cli.ts execute")) out.push("execute");
  }
  return out;
}

/** PURE. The wei a list of steps needs at a max fee. An adapter upgrade deploy that a later step reuses (same --state-dir) is counted once. */
export function ethNeed(steps: Pick<RunbookStep, "id" | "cmds">[], maxFee: bigint): { deploys: number; executes: number; wei: bigint } {
  let deploys = 0, executes = 0;
  const adapterSeen = new Set<string>();
  for (const s of steps) for (const k of sendsOf(s)) {
    if (k === "execute") { executes++; continue; }
    const adapter = s.cmds.map((c) => expandArgv(c).join(" ")).find((j) => j.includes("adapter-swap.ts upgrade deploy"));
    if (adapter) { if (adapterSeen.has("adapter")) continue; adapterSeen.add("adapter"); }
    deploys++;
  }
  return { deploys, executes, wei: (BigInt(deploys) * DEPLOY_GAS + BigInt(executes) * EXECUTE_GAS) * maxFee };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k: string): string | undefined => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
  const release = opt("release"), target = opt("target"), fee = opt("gas-price");
  if (!release || !target || !fee || !/^\d+$/.test(fee)) { console.error("usage: eth-need.ts --release R --target T --gas-price WEI [--priority-gas-price WEI] [--from-step ID]"); process.exit(2); }
  const r = parseRelease(readFileSync(join(ROOT, QA_DIR, "releases", `${release}.yaml`), "utf8"), release);
  let steps = applicableSteps(r, target);
  const from = opt("from-step");
  if (from) { const i = steps.findIndex((s) => s.id === from); if (i < 0) { console.error(`no step ${from} on ${target}`); process.exit(2); } steps = steps.slice(i); }
  const n = ethNeed(steps, BigInt(fee));
  console.error(`${n.deploys} deploys x ${DEPLOY_GAS} gas + ${n.executes} Safe executes x ${EXECUTE_GAS} gas at ${fee} wei max fee`);
  console.log(n.wei.toString());
  const out = opt("out");
  if (out) writeFileSync(out, `${n.wei}\n`);
}
