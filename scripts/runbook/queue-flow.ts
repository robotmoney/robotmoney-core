#!/usr/bin/env bun
// scripts/runbook/queue-flow.ts: the reads of the v0.9.0 FlowQueue that the flow test of releases/v0.9.0-onevault-upgrade.yaml makes (P6.88 to P6.99).
// It decodes with viem against the built ABI ({runDir}/v090/out/FlowQueue.sol/FlowQueue.json), by field name, so a struct change fails loudly
// instead of shifting a cut position. Sends stay in the runbook (scripts/runbook/cast-send.sh with {cast}); this script only reads.
//   quote         --kind deposit|redeem --amount N               prints quoteDeposit / quoteRedeem by field (no price bound in v0.9.0)
//   request       --kind deposit|redeem --owner A --out-id FILE --out-epoch FILE
//                                                                the newest request is the owner's, of that kind, Pending; writes its id and epoch
//   deposit-state --request ID --marker FILE                      writes the marker unless the deposit request has Expired (P6.89 then replaces it)
//   find-claim    --request ID [--hold SECONDS]                   prints the id of the one claim of the request; with --hold its unlockAt is the
//                                                                settlement's time plus SECONDS and equals the settlement's holdEndsAt
// Every subcommand takes --rpc URL --queue A --abi FILE. Exit 0 pass, 1 a failed check or call, 2 a usage error.
import { readFileSync, rmSync } from "node:fs";
import { createPublicClient, http, type Abi, type Address } from "../../publish-contracts/node_modules/viem";
import { UsageError, check, need, options, runMain, writeState } from "./cast-io.ts";

/** RequestStatus of FlowTypes.sol. */
export const STATUS = ["None", "Pending", "Expired", "Closed"] as const;
/** RequestKind of FlowTypes.sol. */
export const KIND = { deposit: 0, redeem: 1 } as const;

export interface QueueReader {
  read(functionName: string, args?: readonly unknown[]): Promise<unknown>;
}

export function loadAbi(path: string): Abi {
  const j = JSON.parse(readFileSync(path, "utf8")) as { abi?: Abi };
  if (!Array.isArray(j.abi)) throw new Error(`${path} has no abi`);
  return j.abi;
}

export function viemReader(rpc: string, queue: string, abi: Abi): QueueReader {
  const client = createPublicClient({ transport: http(rpc) });
  return { read: (functionName, args = []) => client.readContract({ address: queue as Address, abi, functionName, args } as never) };
}

/** A struct return by field name: viem gives an object for a named tuple. Refuses a positional array, which means the ABI has no names. */
export function field(v: unknown, name: string): unknown {
  if (v === null || typeof v !== "object" || Array.isArray(v) || !(name in v)) throw new Error(`the return has no field ${name}: is the ABI the v0.9.0 build's?`);
  return (v as Record<string, unknown>)[name];
}
const str = (x: unknown): string => String(x);

export async function quote(q: QueueReader, kind: "deposit" | "redeem", amount: bigint): Promise<Record<string, string>> {
  const r = await q.read(kind === "deposit" ? "quoteDeposit" : "quoteRedeem", [amount]);
  const names = ["feeBps", "cancelCutoff", "earliestSettle", "holdEnds", "refBandBps", "legBandBps"];
  return Object.fromEntries(names.map((n) => [n, str(field(r, n))]));
}

export async function newestRequest(q: QueueReader, kind: "deposit" | "redeem", owner: string): Promise<{ id: bigint; epoch: string }> {
  const id = (await q.read("requestCount")) as bigint;
  const r = await q.read("getRequest", [id]);
  check(str(field(r, "owner")).toLowerCase() === owner.toLowerCase(), `request ${id} is owned by ${str(field(r, "owner"))}, not ${owner}`);
  check(Number(field(r, "kind")) === KIND[kind], `request ${id} is not a ${kind}`);
  const st = Number(await q.read("requestStatus", [id]));
  check(st === 1, `request ${id} is ${STATUS[st] ?? st}, not Pending`);
  return { id, epoch: str(field(r, "epoch")) };
}

/** P6.88: Pending (waiting for its settle) or Closed (already filled) keeps the request; Expired means P6.89 withdraws it and requests again. */
export async function depositState(q: QueueReader, id: bigint): Promise<{ status: string; keep: boolean }> {
  const r = await q.read("getRequest", [id]);
  check(Number(field(r, "kind")) === KIND.deposit, `request ${id} is not a deposit`);
  const status = STATUS[Number(await q.read("requestStatus", [id]))] ?? "unknown";
  check(status !== "None", `request ${id} does not exist`);
  return { status, keep: status !== "Expired" };
}

export async function findClaim(q: QueueReader, requestId: bigint, hold?: bigint): Promise<bigint> {
  const n = (await q.read("claimCount")) as bigint;
  const found: { id: bigint; c: unknown }[] = [];
  for (let id = 1n; id <= n; id++) {
    const c = await q.read("getClaim", [id]);
    if ((field(c, "requestId") as bigint) === requestId) found.push({ id, c });
  }
  check(found.length === 1, `request ${requestId} has ${found.length} claims, not one`);
  const { id, c } = found[0]!;
  if (hold !== undefined) {
    const s = await q.read("getSettlement", [field(c, "settlementId")]);
    const unlockAt = BigInt(field(c, "unlockAt") as bigint), time = BigInt(field(s, "time") as bigint), ends = BigInt(field(s, "holdEndsAt") as bigint);
    check(unlockAt === time + hold && ends === unlockAt, `claim ${id}: unlockAt ${unlockAt}, settlement time ${time} holdEndsAt ${ends}: the hold is not ${hold} s`);
  }
  return id;
}

const kindOf = (k: string | undefined): "deposit" | "redeem" => {
  if (k !== "deposit" && k !== "redeem") throw new UsageError("--kind is deposit or redeem");
  return k;
};

export async function main(q: QueueReader, verb: string | undefined, o: Record<string, string>): Promise<void> {
  if (verb === "quote") {
    const [amount] = need(o, "amount");
    const r = await quote(q, kindOf(o.kind), BigInt(amount!));
    console.log(Object.entries(r).map(([k, v]) => `${k} ${v}`).join(" "));
  } else if (verb === "request") {
    const [owner, outId, outEpoch] = need(o, "owner", "out-id", "out-epoch");
    const { id, epoch } = await newestRequest(q, kindOf(o.kind), owner!);
    writeState(outId!, String(id));
    writeState(outEpoch!, epoch);
    console.log(`request ${id} (${o.kind}) pending in epoch ${epoch}`);
  } else if (verb === "deposit-state") {
    const [request, marker] = need(o, "request", "marker");
    const { status, keep } = await depositState(q, BigInt(request!));
    rmSync(marker!, { force: true });
    if (keep) { writeState(marker!, status); console.log(`request ${request} is ${status}: it stays, P6.89 skips`); }
    else console.log(`request ${request} is ${status}: P6.89 withdraws it and requests again`);
  } else if (verb === "find-claim") {
    const [request] = need(o, "request");
    console.log(String(await findClaim(q, BigInt(request!), o.hold === undefined ? undefined : BigInt(o.hold))));
  } else throw new UsageError(`unknown subcommand ${verb ?? "(none)"}`);
}

if (import.meta.main) {
  await runMain("usage: queue-flow.ts quote|request|deposit-state|find-claim --rpc URL --queue A --abi FILE ... (see the header)", async () => {
    const [verb, ...argv] = process.argv.slice(2);
    let o;
    try { o = options(argv).opts; } catch (e) { throw new UsageError((e as Error).message); }
    const [rpc, queue, abi] = need(o, "rpc", "queue", "abi");
    await main(viemReader(rpc!, queue!, loadAbi(abi!)), verb, o);
  });
}
