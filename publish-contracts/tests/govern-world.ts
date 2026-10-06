// Shared by the govern tests: the manifest fixtures and the in-memory fake of the Safe tool's entry points (a timelock that checks order and delay).
// The real Safe, the real signers and the real delay are exercised on the Twin chain run and on 8453 (runbook Q2), never here.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFunctionData, encodeFunctionData, keccak256, parseAbi, toBytes, type Address, type Hex } from "viem";
import { publishLogger } from "../src/log.ts";
import type { RunContext } from "../src/runner.ts";
import { parseSheet } from "../src/sheet.ts";
import { getStageTable } from "../src/stages.ts";
import { manifestBase } from "../src/stage-table.ts";
import { stageManifestName } from "../src/verify/constants.ts";
import type { Signer } from "../src/safe/index.ts";
import { RECEIPT_ABI, type GovernApi } from "../src/govern.ts";
import { SHA, sheetText, tmp } from "./fixtures.ts";

export const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
export const A = { timelock: addr(0x2001), safe: addr(0x2002), router: addr(0x1003), registry: addr(0x1002), gateway: addr(0x1004), governance: addr(0x1005), receipt: addr(0x1006), vaults: { USDC: addr(0x3001), PROTO: addr(0x3002), AGENT: addr(0x3003), RWA: addr(0x3004) } };

/** Writes the manifests govern reads (timelock, safe, router, registry, gateway, governance, ic-policy's receipt, one per vault) into `dir`. */
export function writeGovernManifests(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const w = (f: string, o: object) => writeFileSync(join(dir, `${f}.json`), JSON.stringify(o));
  const t = getStageTable();
  const n = (stage: string) => stageManifestName(t, stage);
  w(n("timelock"), { timelock: A.timelock }); w("safe", { safe: A.safe }); w(n("router"), { router: A.router }); w(n("registry"), { registry: A.registry });
  w(n("gateway"), { gateway: A.gateway }); w(n("governance"), { governance: A.governance }); w(n("ic-policy"), { consensus_receipt: A.receipt });
  for (const v of t.vaults) w(manifestBase(v.manifest), { vault: A.vaults[v.key] });
}

export function setup(sheetOver: Record<string, string | null> = {}, chainId = 918453) {
  const coreDir = tmp("pc-govern-");
  writeGovernManifests(join(coreDir, "deployments", String(chainId)));
  const sheet = parseSheet(sheetText(sheetOver));
  const lines: string[] = [];
  const ctx = { coreDir, chainId, sheet, coreSha: SHA, rpc: "http://x", evidenceDir: join(coreDir, "evidence"), log: publishLogger((l) => lines.push(l)) } as unknown as RunContext;
  return { ctx, sheet, lines };
}

export type Op = { exists: boolean; pending: boolean; done: boolean; readyAt: bigint };
export function fakeTimelock(sheet: ReturnType<typeof parseSheet>, startMinDelay = 60n) {
  const s = {
    clock: 1000n, minDelay: startMinDelay, ops: new Map<string, Op>(), log: [] as string[], signed: [] as string[], nonce: 0,
    /** `kind:row` per timelock bundle built, in order: the row is the first word of the description. */
    events: [] as string[],
    /** The scheduled calls per row. */
    scheduled: new Map<string, { form: string; calls: { target: string; data: string }[] }>(),
    /** Overrides for a read: `functionName` to the value the chain returns. */
    reads: {} as Record<string, unknown>,
    /** Receipt ids recordReceipt has anchored (the test seeds it) and releaseReceipt has released (an executed timelock call adds to it). */
    recorded: new Set<string>(), released: new Set<string>(),
  };
  const rowOf = (d?: string) => (d ?? "").split(/[ :]/)[0]!;
  const idOf = (p: { calls: { target: string; data: string }[]; salt: string; form?: string }): Hex => keccak256(toBytes(JSON.stringify([p.calls.map((c) => [c.target, c.data]), p.salt, p.form ?? "batch"])));
  const handle: any = {
    address: A.safe, owners: sheet.safeOwners, threshold: sheet.safeThreshold, chain: { rpcUrl: "x", chainId: 918453 },
    client: {
      getBlock: async () => ({ timestamp: s.clock }),
      readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: unknown[] }) => {
        const key = Object.entries(A.vaults).find(([, v]) => v === address)?.[0] as "USDC" | undefined;
        if (functionName in s.reads) return s.reads[functionName];
        switch (functionName) {
          case "votingPower": return sheet.voterPower;
          case "quorumThreshold": return sheet.quorum;
          case "tvlCap": return sheet.vaults[key!].tvlCap;
          case "perDepositCap": return sheet.vaults[key!].perDepositCap;
          case "exitFeeBps": return sheet.vaults[key!].exitFeeBps;
          case "isRouterEligible": return true;
          case "paused": return false;
          case "votingPeriod": return sheet.votingPeriod;
          case "executionDelay": return sheet.executionDelay;
          case "feeRecipient": return sheet.feeRecipient === "@safe" ? A.safe : sheet.feeRecipient;
          case "agents": return [true, 0n];
          case "defaultWeightsLength": return BigInt(1 + sheet.govern.eligibleVaults.length);
          case "isRecorded": return s.recorded.has(String(args?.[0]).toLowerCase());
          case "isReleased": return s.released.has(String(args?.[0]).toLowerCase());
        }
        throw new Error(`fake: ${functionName}`);
      },
    },
    nonce: async () => s.nonce,
  };
  const bundle = (action: string, id: Hex) => ({ safe_tx_hash: keccak256(toBytes(`${action}${id}${s.nonce}`)), nonce: s.nonce, action, signatures: [] as unknown[], timelock_operation_id: id });
  const api: GovernApi = {
    connectSafe: (async () => handle) as never,
    timelockMinDelay: (async () => s.minDelay) as never,
    operationId: (async (_h: unknown, p: never) => idOf(p)) as never,
    operationState: (async (_h: unknown, _t: unknown, id: string) => { const o = s.ops.get(id); return o ? { exists: true, pending: o.pending, done: o.done, ready: o.pending && s.clock >= o.readyAt, readyAt: o.readyAt } : { exists: false, pending: false, done: false, ready: false, readyAt: 0n }; }) as never,
    scheduleOnTimelock: (async (_h: unknown, p: { form?: string; description?: string; calls: { target: string; data: string }[] }) => {
      const id = idOf(p as never); const k = p.form === "single" ? "schedule" : "scheduleBatch";
      s.log.push(k); s.events.push(`${k}:${rowOf(p.description)}`); s.scheduled.set(rowOf(p.description), { form: p.form ?? "batch", calls: p.calls });
      return bundle("schedule", id);
    }) as never,
    executeOnTimelock: (async (_h: unknown, p: { form?: string; description?: string; calls: { target: string; data: Hex }[] }) => {
      const k = p.form === "single" ? "execute" : "executeBatch";
      s.log.push(k); s.events.push(`${k}:${rowOf(p.description)}`);
      return { ...bundle("execute", idOf(p as never)), calls: p.calls };
    }) as never,
    cancelOnTimelock: (async (_h: unknown, p: { id: Hex; description?: string }) => { s.log.push("cancel"); s.events.push(`cancel:${rowOf(p.description)}`); return bundle("cancel", p.id); }) as never,
    updateTimelockDelay: (async (_h: unknown, p: { newDelay: bigint; phase: string; salt: Hex }) => {
      s.log.push(`updateDelay.${p.phase}`); s.events.push(`updateDelay.${p.phase}:update-delay`);
      const id = idOf({ calls: [{ target: A.timelock, data: decodeKey(p.newDelay) }], salt: p.salt, form: "single" });
      return { ...bundle(`updateDelay.${p.phase}`, id), newDelay: p.newDelay };
    }) as never,
    signTx: (async (_h: unknown, b: { signatures: unknown[] }, signer: Signer) => { s.signed.push(await signer.address()); return { ...b, signatures: [...b.signatures, await signer.address()] }; }) as never,
    executeTx: (async (_h: unknown, b: any) => {
      if (b.signatures.length < handle.threshold) throw new Error("below threshold");
      const id: string = b.timelock_operation_id;
      if (b.action === "schedule") s.ops.set(id, { exists: true, pending: true, done: false, readyAt: s.clock + s.minDelay });
      else if (b.action === "cancel") s.ops.delete(id);
      else if (b.action === "execute") {
        s.ops.set(id, { exists: true, pending: false, done: true, readyAt: 1n });
        for (const c of (b.calls ?? []) as { target: string; data: Hex }[]) {
          if (c.target !== A.receipt) continue;
          const d = decodeFunctionData({ abi: RECEIPT_ABI, data: c.data });
          if (d.functionName === "releaseReceipt") s.released.add(String(d.args[0]).toLowerCase());
        }
      }
      else if (b.action === "updateDelay.schedule") s.ops.set(id, { exists: true, pending: true, done: false, readyAt: s.clock + s.minDelay });
      else if (b.action === "updateDelay.execute") { s.ops.set(id, { exists: true, pending: false, done: true, readyAt: 1n }); s.minDelay = b.newDelay; }
      s.nonce++;
      return { txHash: `0x${s.nonce.toString(16).padStart(64, "0")}` as Hex, bundle: { ...b, executed: { tx_hash: `0x${s.nonce.toString(16).padStart(64, "0")}`, status: 1 } } };
    }) as never,
    verifyTimelockEffect: (async () => ({ ok: true, detail: "", state: {} })) as never,
  };
  return { s, api, handle };
}
export const decodeKey = (d: bigint) => encodeFunctionData({ abi: parseAbi(["function updateDelay(uint256 newDelay)"]), functionName: "updateDelay", args: [d] });

export const signers = (sheet: ReturnType<typeof parseSheet>, n = 3): Signer[] => sheet.safeOwners.slice(0, n).map((o) => ({ kind: "keystore", modes: ["raw"], address: async () => o }) as unknown as Signer);
export const sender = { kind: "keystore", modes: ["raw"], address: async () => addr(0xa001) } as unknown as Signer;

