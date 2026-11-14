#!/usr/bin/env bun
// publish-contracts/src/ci/fund-claims.ts: the fund queue's claims, read for the fund-upgrade flow (releases/v0.8.0-onevault-upgrade.yaml). The live Deploy 4 queue holds deposit claims
// in their hold (settled before the upgrade at the 24 h minHold: unlockAt was fixed at settlement). The upgrade must leave them as they were, and the flow's own claim must not
// take them: the queue delivers a receiver's deposit claims oldest first (FlowClaimLib.deliver) and pays its redemption claims oldest first (redeemClaims). It only reads.
//   bun publish-contracts/src/ci/fund-claims.ts snapshot --rpc URL --queue A --out FILE
//       every claim (id 1 to claimCount) to FILE as JSON.
//   bun publish-contracts/src/ci/fund-claims.ts same --rpc URL --queue A --snapshot FILE
//       every claim of FILE reads the same now (owner, kind, settlement, unlockAt, shares, usdc, claimed, sharesClaimed): exit 1 on any difference.
//   bun publish-contracts/src/ci/fund-claims.ts find --rpc URL --queue A --request ID [--hold SECONDS]
//       prints the id of the one claim of request ID; with --hold, its unlockAt must be its settlement's time plus SECONDS (and the settlement's holdEndsAt).
//   bun publish-contracts/src/ci/fund-claims.ts guard --rpc URL --queue A --owner A --claim ID --kind deposit|redeem [--margin SECONDS]
//       before the owner claims claim ID: no OTHER claim of the owner of that kind can be taken first. A deposit claim of the owner that is not fully delivered must stay in
//       its hold for --margin seconds more (default 300); a redemption claim of the owner must be fully paid. Exit 1 names each claim that would be taken first.
// Exit 0 ok, 1 a check failed, 2 usage.
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http, parseAbi, type Address } from "viem";

const ABI = parseAbi([
  "struct Claim { uint256 requestId; address owner; uint8 kind; uint64 settlementId; uint64 unlockAt; uint256 shares; uint256 usdc; uint256 claimed; uint256 sharesClaimed; }",
  "struct Settlement { uint64 time; address settler; uint256 depositBoundPrice; uint256 redeemBoundPrice; uint256 usdcIn; uint256 sharesMinted; uint256 sharesBurned; uint256 usdcOut; uint64 frozenUntil; bool returnAllowed; uint64 holdEndsAt; }",
  "function claimCount() view returns (uint256)",
  "function getClaim(uint256 claimId) view returns (Claim)",
  "function getSettlement(uint256 settlementId) view returns (Settlement)",
]);
export const VERBS = ["snapshot", "same", "find", "guard"] as const;
export const FLAGS = ["rpc", "queue", "out", "snapshot", "request", "hold", "owner", "claim", "kind", "margin"] as const;

export interface ClaimRow { id: number; requestId: string; owner: string; kind: number; settlementId: string; unlockAt: number; shares: string; usdc: string; claimed: string; sharesClaimed: string }
const DEPOSIT = 0, REDEEM = 1;
const lc = (s: string): string => s.toLowerCase();

/** PURE. A deposit claim is open while not every share is delivered; a redemption claim while not every burned share is paid (FlowClaimLib.deliver, redeemClaims). */
export const isOpen = (c: ClaimRow): boolean => (c.kind === DEPOSIT ? BigInt(c.claimed) < BigInt(c.shares) : BigInt(c.sharesClaimed) < BigInt(c.shares));

/** PURE. The claims of `owner` the queue would take before claim `mine` when the owner claims `kind` at time `now`: every other open claim of that kind which is (deposit) out of its hold within `margin` s, or (redeem) unpaid. */
export function takenFirst(claims: ClaimRow[], owner: string, mine: number, kind: "deposit" | "redeem", now: number, margin: number): string[] {
  const k = kind === "deposit" ? DEPOSIT : REDEEM;
  return claims.filter((c) => c.id !== mine && lc(c.owner) === lc(owner) && c.kind === k && isOpen(c) && (k === REDEEM || c.unlockAt <= now + margin))
    .map((c) => `claim ${c.id} (request ${c.requestId}) of ${owner} is an open ${kind} claim${k === DEPOSIT ? ` whose hold ends at ${c.unlockAt}, within ${margin} s of now (${now})` : ""}: the queue would take it before claim ${mine}`);
}

/** PURE. The differences between two snapshots of the same claims. */
export function changes(before: ClaimRow[], now: ClaimRow[]): string[] {
  const out: string[] = [];
  for (const b of before) {
    const n = now.find((c) => c.id === b.id);
    if (!n) { out.push(`claim ${b.id} no longer reads`); continue; }
    for (const k of Object.keys(b) as (keyof ClaimRow)[]) if (String(b[k]).toLowerCase() !== String(n[k]).toLowerCase()) out.push(`claim ${b.id}: ${k} was ${b[k]}, is ${n[k]}`);
  }
  return out;
}

async function readClaims(rpc: string, queue: Address): Promise<ClaimRow[]> {
  const c = createPublicClient({ transport: http(rpc) });
  const n = Number(await c.readContract({ address: queue, abi: ABI, functionName: "claimCount" }));
  const out: ClaimRow[] = [];
  for (let id = 1; id <= n; id++) {
    const r = (await c.readContract({ address: queue, abi: ABI, functionName: "getClaim", args: [BigInt(id)] })) as any;
    out.push({ id, requestId: String(r.requestId), owner: r.owner, kind: Number(r.kind), settlementId: String(r.settlementId), unlockAt: Number(r.unlockAt), shares: String(r.shares), usdc: String(r.usdc), claimed: String(r.claimed), sharesClaimed: String(r.sharesClaimed) });
  }
  return out;
}

async function main(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
  const f: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i]?.replace(/^--/, "");
    if (!k || !(FLAGS as readonly string[]).includes(k) || rest[i + 1] === undefined) { console.error(`usage: unknown or empty argument ${rest[i]}`); return 2; }
    f[k] = rest[i + 1]!;
  }
  if (!(VERBS as readonly string[]).includes(verb ?? "") || !f.rpc || !f.queue) { console.error(`usage: fund-claims.ts ${VERBS.join("|")} --rpc URL --queue A ...`); return 2; }
  const claims = await readClaims(f.rpc, f.queue as Address);
  if (verb === "snapshot") {
    if (!f.out) { console.error("usage: snapshot needs --out"); return 2; }
    writeFileSync(f.out, JSON.stringify(claims, null, 2) + "\n");
    for (const c of claims) console.log(JSON.stringify(c));
    return 0;
  }
  if (verb === "same") {
    if (!f.snapshot) { console.error("usage: same needs --snapshot"); return 2; }
    const before = JSON.parse(readFileSync(f.snapshot, "utf8")) as ClaimRow[];
    const d = changes(before, claims);
    for (const x of d) console.error(x);
    if (d.length) return 1;
    console.log(`the ${before.length} claim(s) of ${f.snapshot} read the same`);
    return 0;
  }
  if (verb === "find") {
    const mine = claims.filter((c) => c.requestId === f.request);
    if (mine.length !== 1) { console.error(`request ${f.request} has ${mine.length} claims, expected one`); return 1; }
    const c = mine[0]!;
    if (f.hold !== undefined) {
      const s = (await createPublicClient({ transport: http(f.rpc) }).readContract({ address: f.queue as Address, abi: ABI, functionName: "getSettlement", args: [BigInt(c.settlementId)] })) as any;
      const time = Number(s.time), ends = Number(s.holdEndsAt);
      if (c.unlockAt !== time + Number(f.hold) || ends !== c.unlockAt) { console.error(`claim ${c.id}: unlockAt ${c.unlockAt}, settlement ${c.settlementId} time ${time} holdEndsAt ${ends}: the hold is not ${f.hold} s`); return 1; }
      console.error(`claim ${c.id}: settled at ${time}, held until ${c.unlockAt} (${f.hold} s)`);
    }
    console.log(c.id);
    return 0;
  }
  if (!f.owner || !f.claim || (f.kind !== "deposit" && f.kind !== "redeem")) { console.error("usage: guard needs --owner, --claim and --kind deposit|redeem"); return 2; }
  const now = Number((await createPublicClient({ transport: http(f.rpc) }).getBlock()).timestamp);
  const bad = takenFirst(claims, f.owner, Number(f.claim), f.kind, now, Number(f.margin ?? 300));
  for (const x of bad) console.error(x);
  if (bad.length) { console.error("finish those claims first (the v0.7.0-onevault run's own claim steps), then run this step again"); return 1; }
  console.log(`no other ${f.kind} claim of ${f.owner} comes before claim ${f.claim}`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
