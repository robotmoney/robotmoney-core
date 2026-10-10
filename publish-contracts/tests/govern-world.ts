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
import { RECEIPT_ABI, VAULT_ABI, type GovernApi } from "../src/govern.ts";
import { GOVERNANCE_WEIGHTS_ABI } from "../src/apply-receipt.ts";
import { GATEWAY_REGISTER_ABI } from "../src/committee-register.ts";
import { SHA, sheetText, tmp } from "./fixtures.ts";

export const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
export const A = { icPolicy: addr(0x1007), timelock: addr(0x2001), safe: addr(0x2002), router: addr(0x1003), registry: addr(0x1002), gateway: addr(0x1004), governance: addr(0x1005), receipt: addr(0x1006), vaults: { USDC: addr(0x3001), PROTO: addr(0x3002), AGENT: addr(0x3003), RWA: addr(0x3004) } };

/** Writes the manifests govern reads (timelock, safe, router, registry, gateway, governance, ic-policy's receipt, one per vault) into `dir`. */
export function writeGovernManifests(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const w = (f: string, o: object) => writeFileSync(join(dir, `${f}.json`), JSON.stringify(o));
  const t = getStageTable();
  const n = (stage: string) => stageManifestName(t, stage);
  w(n("timelock"), { timelock: A.timelock }); w("safe", { safe: A.safe }); w(n("router"), { router: A.router }); w(n("registry"), { registry: A.registry });
  w(n("recorder"), { recorder: "0x00000000000000000000000000000000000c0c0c" });
  w(n("gateway"), { gateway: A.gateway }); w(n("governance"), { governance: A.governance }); w(n("ic-policy"), { consensus_receipt: A.receipt, policy: A.icPolicy });
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
    /** The scheduled calls per row, with the timelock predecessor each operation carries (undefined: none). */
    scheduled: new Map<string, { form: string; calls: { target: string; data: string }[]; predecessor?: string }>(),
    /** The timelock operation id of each scheduled row. */
    ids: new Map<string, Hex>(),
    /** Every transaction hash the fake Safe sent, per timelock operation id: a Safe transaction shared by two operations would show here. */
    safeTxs: new Map<string, string[]>(),
    /** Overrides for a read: `functionName` to the value the chain returns. */
    reads: {} as Record<string, unknown>,
    /** Receipt ids recordReceipt has anchored (the test seeds it) and releaseReceipt has released (an executed timelock call adds to it). */
    recorded: new Set<string>(), released: new Set<string>(),
    /** The vaults that read depositsPaused true. All four vaults deploy paused (issue 1710); an executed unpauseDeposits opens a vault, a test pauses one by adding it. */
    paused: new Set<string>([A.vaults.USDC, A.vaults.PROTO, A.vaults.AGENT, A.vaults.RWA]),
    /** Registry order, the vaults that are NOT router-eligible, the digest each recorded receipt stored, and the router's default weights (an executed setDefaultWeights sets them). */
    listed: [A.vaults.USDC, A.vaults.PROTO, A.vaults.AGENT, A.vaults.RWA] as Address[], ineligible: new Set<string>(),
    digests: new Map<string, Hex>(),
    weights: { vaults: [] as Address[], bps: [] as bigint[] },
    /** The chain clock at each Safe transaction hash: getTransactionReceipt answers with it as the block number, getBlock({blockNumber}) as the timestamp. */
    txClock: new Map<string, bigint>(),
    /** Issue 1727: the gateway's agents (AGENT_ROLE), the IC policy's committee agents (label) and the owner each agent has. An executed authorizeAgent / committeeRegister fills them. */
    agentRole: new Set<string>(), committee: new Map<string, string>(), agentOwner: new Map<string, string>(), gatewayAdmins: new Set<string>(),
  };
  const rowOf = (d?: string) => (d ?? "").split(/[ :]/)[0]!;
  const idOf = (p: { calls: { target: string; data: string }[]; salt: string; form?: string; predecessor?: string }): Hex => keccak256(toBytes(JSON.stringify([p.calls.map((c) => [c.target, c.data]), p.salt, p.form ?? "batch", p.predecessor ?? null])));
  const handle: any = {
    address: A.safe, owners: sheet.safeOwners, threshold: sheet.safeThreshold, chain: { rpcUrl: "x", chainId: 918453 },
    client: {
      getBlock: async (a?: { blockNumber?: bigint }) => ({ timestamp: a?.blockNumber ?? s.clock }),
      getTransactionReceipt: async ({ hash }: { hash: string }) => ({ blockNumber: s.txClock.get(hash) ?? s.clock, status: "success" }),
      readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: unknown[] }) => {
        const key = Object.entries(A.vaults).find(([, v]) => v === address)?.[0] as "USDC" | undefined;
        if (functionName in s.reads) return s.reads[functionName];
        switch (functionName) {
          case "votingPower": return sheet.voterPower;
          case "quorumThreshold": return sheet.quorum;
          case "tvlCap": return sheet.vaults[key!].tvlCap;
          case "perDepositCap": return sheet.vaults[key!].perDepositCap;
          case "exitFeeBps": return sheet.vaults[key!].exitFeeBps;
          case "isRouterEligible": return !s.ineligible.has(String(args?.[0]));
          case "listVaults": return s.listed;
          case "getReceiptById": return { payloadDigest: s.digests.get(String(args?.[0]).toLowerCase()) };
          case "getDefaultWeights": return [s.weights.vaults, s.weights.bps];
          case "depositsPaused": return s.paused.has(address);
          case "votingPeriod": return sheet.votingPeriod;
          case "executionDelay": return sheet.executionDelay;
          case "feeRecipient": return sheet.feeRecipient === "@safe" ? A.safe : sheet.feeRecipient;
          case "agents": return [true, 0n];
          case "hasRole": return address === A.icPolicy ? s.committee.has(String(args?.[1]).toLowerCase()) : s.agentRole.has(String(args?.[1]).toLowerCase()) || s.gatewayAdmins.has(String(args?.[1]).toLowerCase());
          case "agentOwner": return s.agentOwner.get(String(args?.[0]).toLowerCase()) ?? addr(0);
          case "icPolicy": return A.icPolicy;
          case "agentId": return s.committee.get(String(args?.[0]).toLowerCase()) ?? "";
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
    scheduleOnTimelock: (async (_h: unknown, p: { form?: string; description?: string; predecessor?: string; calls: { target: string; data: string }[] }) => {
      const id = idOf(p as never); const k = p.form === "single" ? "schedule" : "scheduleBatch";
      s.log.push(k); s.events.push(`${k}:${rowOf(p.description)}`); s.scheduled.set(rowOf(p.description), { form: p.form ?? "batch", calls: p.calls, predecessor: p.predecessor });
      s.ids.set(rowOf(p.description), id);
      return { ...bundle("schedule", id), predecessor: p.predecessor };
    }) as never,
    executeOnTimelock: (async (_h: unknown, p: { form?: string; description?: string; predecessor?: string; calls: { target: string; data: Hex }[] }) => {
      const k = p.form === "single" ? "execute" : "executeBatch";
      s.log.push(k); s.events.push(`${k}:${rowOf(p.description)}`);
      return { ...bundle("execute", idOf(p as never)), calls: p.calls, predecessor: p.predecessor };
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
        // a TimelockController refuses an operation whose predecessor is not done
        if (b.predecessor && !s.ops.get(b.predecessor)?.done) throw new Error("TimelockController: missing dependency");
        s.ops.set(id, { exists: true, pending: false, done: true, readyAt: 1n });
        for (const c of (b.calls ?? []) as { target: string; data: Hex }[]) {
          if (c.target === A.governance) {
            const w = decodeFunctionData({ abi: GOVERNANCE_WEIGHTS_ABI, data: c.data });
            s.weights = { vaults: [...(w.args[0] as Address[])], bps: [...(w.args[1] as bigint[])] };
            continue;
          }
          if (c.target === A.gateway) {
            let d: ReturnType<typeof decodeFunctionData<typeof GATEWAY_REGISTER_ABI>>;
            try { d = decodeFunctionData({ abi: GATEWAY_REGISTER_ABI, data: c.data }); } catch { continue; } // a generic test call with junk calldata changes nothing here
            const who = String(d.args[0]).toLowerCase();
            if (d.functionName === "authorizeAgent") { s.agentRole.add(who); s.agentOwner.set(who, A.timelock); }
            if (d.functionName === "committeeRegister") s.committee.set(who, String(d.args[1]));
            continue;
          }
          if (c.target !== A.receipt) {
            if (Object.values(A.vaults).includes(c.target as Address) && decodeFunctionData({ abi: VAULT_ABI, data: c.data }).functionName === "unpauseDeposits") s.paused.delete(c.target);
            continue;
          }
          const d = decodeFunctionData({ abi: RECEIPT_ABI, data: c.data });
          if (d.functionName === "releaseReceipt") s.released.add(String(d.args[0]).toLowerCase());
        }
      }
      else if (b.action === "updateDelay.schedule") s.ops.set(id, { exists: true, pending: true, done: false, readyAt: s.clock + s.minDelay });
      else if (b.action === "updateDelay.execute") { s.ops.set(id, { exists: true, pending: false, done: true, readyAt: 1n }); s.minDelay = b.newDelay; }
      s.nonce++;
      const hash = `0x${s.nonce.toString(16).padStart(64, "0")}`;
      s.txClock.set(hash, s.clock);
      s.safeTxs.set(id, [...(s.safeTxs.get(id) ?? []), hash]);
      return { txHash: `0x${s.nonce.toString(16).padStart(64, "0")}` as Hex, bundle: { ...b, executed: { tx_hash: `0x${s.nonce.toString(16).padStart(64, "0")}`, status: 1 } } };
    }) as never,
    verifyTimelockEffect: (async () => ({ ok: true, detail: "", state: {} })) as never,
  };
  return { s, api, handle };
}
export const decodeKey = (d: bigint) => encodeFunctionData({ abi: parseAbi(["function updateDelay(uint256 newDelay)"]), functionName: "updateDelay", args: [d] });

export const signers = (sheet: ReturnType<typeof parseSheet>, n = 3): Signer[] => sheet.safeOwners.slice(0, n).map((o) => ({ kind: "keystore", modes: ["raw"], address: async () => o }) as unknown as Signer);
export const sender = { kind: "keystore", modes: ["raw"], address: async () => addr(0xa001) } as unknown as Signer;

