// scripts/runbook/queue-flow.test.ts: the v0.9.0 FlowQueue reads of the flow test (P6.88 to P6.99). Each return is ABI-encoded and decoded with viem,
// so the field names are exercised as the script reads them on chain. The struct layouts are checked against contracts/FlowTypes.sol.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunctionResult, encodeFunctionResult, parseAbi, type Abi } from "../../publish-contracts/node_modules/viem";
import { depositState, findClaim, held, loadAbi, main, matured, newestRequest, quote, refresh, type ClaimRow, type QueueReader } from "./queue-flow.ts";

const ROOT = join(import.meta.dir, "..", "..");
const REQUEST = "address owner; uint8 kind; uint64 epoch; uint256 amount; uint256 remaining; bool closed; uint16 exitFeeBps; uint32 minHold; uint16 maxRoll; uint64 createdAt; uint64 expiryEpoch; uint64 expiresAt; uint64 noticeRound; uint64 era; bool enrolled; uint256 matchCycle; uint256 normBasis; uint256 entryCumScaled; uint256 entryUnmatchedFactor; uint256 nextMatchId";
const QUOTE = "uint256 feeBps; uint64 cancelCutoff; uint64 earliestSettle; uint64 holdEnds; uint16 refBandBps; uint16 legBandBps";
const CLAIM = "uint256 requestId; address owner; uint8 kind; uint64 settlementId; uint64 unlockAt; uint256 shares; uint256 usdc; uint256 claimed; uint256 sharesClaimed";
const SETTLEMENT = "uint64 time; address settler; uint256 matchedShares; uint256 matchedUsdc; uint256 matchSharePrice; uint256 usdcIn; uint256 sharesMinted; uint256 sharesBurned; uint256 usdcOut; uint64 frozenUntil; uint64 freezeSetAt; uint64 holdEndsAt";
const ABI: Abi = parseAbi([
  `struct Request { ${REQUEST}; }`, `struct Quote { ${QUOTE}; }`, `struct Claim { ${CLAIM}; }`, `struct Settlement { ${SETTLEMENT}; }`,
  "function requestCount() view returns (uint256)", "function claimCount() view returns (uint256)",
  "function getRequest(uint256) view returns (Request)", "function requestStatus(uint256) view returns (uint8)",
  "function getClaim(uint256) view returns (Claim)", "function getSettlement(uint256) view returns (Settlement)",
  "function claimableDepositRequest(uint256,address) view returns (uint256)",
  "function quoteDeposit(uint256) view returns (Quote)", "function quoteRedeem(uint256) view returns (Quote)",
]);

/** PURE. `type name` of a struct in FlowTypes.sol, comments dropped. */
function solStruct(name: string): string {
  const sol = readFileSync(join(ROOT, "contracts", "FlowTypes.sol"), "utf8");
  const body = new RegExp(`struct ${name} \\{([^}]*)\\}`).exec(sol)![1]!;
  return body.split("\n").map((l) => l.replace(/\/\/.*$/, "").trim()).filter(Boolean).join(" ").split(";").map((x) => x.trim()).filter(Boolean)
    .map((x) => x.replace(/^(RequestKind|RequestStatus)\b/, "uint8")).join("; ");
}

test("the test ABI's structs are FlowTypes.sol's (Request 20 fields, Quote 6, Claim 9, Settlement 12)", () => {
  expect(solStruct("Request")).toBe(REQUEST);
  expect(solStruct("Quote")).toBe(QUOTE);
  expect(solStruct("Claim")).toBe(CLAIM);
  expect(solStruct("Settlement")).toBe(SETTLEMENT);
  const built = join(ROOT, "out", "FlowQueue.sol", "FlowQueue.json");
  if (existsSync(built)) {
    const fn = loadAbi(built).find((x) => x.type === "function" && x.name === "getRequest") as { outputs: { components: { name: string }[] }[] };
    expect(fn.outputs[0]!.components.map((c) => c.name).join(",")).toBe(REQUEST.split("; ").map((x) => x.split(" ")[1]).join(","));
  }
});

const OWNER = "0x00000000000000000000000000000000000000a1";
const req = (o: Partial<Record<string, unknown>> = {}) => ({
  owner: OWNER, kind: 0, epoch: 7n, amount: 1_000_000n, remaining: 1_000_000n, closed: false, exitFeeBps: 0, minHold: 3600, maxRoll: 3, createdAt: 1n, expiryEpoch: 10n,
  expiresAt: 0n, noticeRound: 0n, era: 0n, enrolled: true, matchCycle: 0n, normBasis: 0n, entryCumScaled: 0n, entryUnmatchedFactor: 0n, nextMatchId: 0n, ...o,
});
const claim = (requestId: bigint, settlementId: bigint, unlockAt: bigint) => ({ requestId, owner: OWNER, kind: 0, settlementId, unlockAt, shares: 1n, usdc: 1n, claimed: 0n, sharesClaimed: 0n });
const settlement = (time: bigint, holdEndsAt: bigint) => ({ time, settler: OWNER, matchedShares: 0n, matchedUsdc: 0n, matchSharePrice: 0n, usdcIn: 0n, sharesMinted: 0n, sharesBurned: 0n, usdcOut: 0n, frozenUntil: 0n, freezeSetAt: 0n, holdEndsAt });

/** A reader whose answers go through the ABI encoder and decoder, as on chain. */
function reader(answers: (fn: string, args: readonly unknown[]) => unknown, now = 0n): QueueReader {
  return {
    now: async () => now,
    read: async (functionName, args = []) => {
      const result = answers(functionName, args);
      const data = encodeFunctionResult({ abi: ABI, functionName, result } as never);
      return decodeFunctionResult({ abi: ABI, functionName, data } as never);
    },
  };
}

test("quote: the six v0.9.0 fields by name", async () => {
  const q = reader(() => ({ feeBps: 0n, cancelCutoff: 100n, earliestSettle: 200n, holdEnds: 300n, refBandBps: 50, legBandBps: 75 }));
  expect(await quote(q, "deposit", 1_000_000n)).toEqual({ feeBps: "0", cancelCutoff: "100", earliestSettle: "200", holdEnds: "300", refBandBps: "50", legBandBps: "75" });
});

test("request: the newest is the owner's, of the kind, Pending; its epoch is the struct's", async () => {
  const q = (r: object, st = 1) => reader((fn) => (fn === "requestCount" ? 9n : fn === "requestStatus" ? st : r));
  expect(await newestRequest(q(req()), "deposit", OWNER.toUpperCase().replace("0X", "0x"))).toEqual({ id: 9n, epoch: "7" });
  await expect(newestRequest(q(req({ owner: "0x00000000000000000000000000000000000000b2" })), "deposit", OWNER)).rejects.toThrow("owned by");
  await expect(newestRequest(q(req()), "redeem", OWNER)).rejects.toThrow("not a redeem");
  await expect(newestRequest(q(req(), 3), "deposit", OWNER)).rejects.toThrow("Closed, not Pending");
});

test("deposit-state: Pending and Closed keep the request, Expired is replaced; the marker follows", async () => {
  const at = (st: number) => reader((fn) => (fn === "requestStatus" ? st : req()));
  expect(await depositState(at(1), 4n)).toEqual({ status: "Pending", keep: true });
  expect(await depositState(at(3), 4n)).toEqual({ status: "Closed", keep: true });
  expect(await depositState(at(2), 4n)).toEqual({ status: "Expired", keep: false });
  await expect(depositState(at(0), 4n)).rejects.toThrow("does not exist");
  const marker = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "queue-flow-")), "upg-deposit-admitted");
  writeFileSync(marker, "old");
  await main(at(2), "deposit-state", { request: "4", marker });
  expect(existsSync(marker)).toBe(false);
  await main(at(1), "deposit-state", { request: "4", marker });
  expect(readFileSync(marker, "utf8")).toBe("Pending\n");
});

test("find-claim: the one claim of the request, its hold from the v0.9.0 Settlement's holdEndsAt", async () => {
  const claims = [claim(3n, 1n, 1000n), claim(5n, 2n, 5600n), claim(6n, 2n, 5600n)];
  const q = (hold: bigint) => reader((fn, args) => {
    if (fn === "claimCount") return BigInt(claims.length);
    if (fn === "getClaim") return claims[Number(args[0]) - 1];
    return settlement(2000n, hold);
  });
  expect(await findClaim(q(5600n), 5n, 3600n)).toBe(2n);
  expect(await findClaim(q(0n), 5n)).toBe(2n);
  await expect(findClaim(q(5601n), 5n, 3600n)).rejects.toThrow("the hold is not 3600 s");
  await expect(findClaim(q(5600n), 9n)).rejects.toThrow("has 0 claims");
});

// ─── P6.87 (decision D4-18): the Deploy 4 deposit claims whose hold has ended ───
const ADMIN = "0xf3F582464De7BD2cBf9d2ad40429e31D0F4724A3";
const row = (id: number, requestId: string, kind: number, unlockAt: number, claimed = "0", owner = ADMIN): ClaimRow =>
  ({ id, requestId, owner, kind, settlementId: "1", unlockAt, shares: "1000", usdc: "998592", claimed, sharesClaimed: "0" });
/** The shape of the live claims-before.json: three open deposit claims at one unlockAt, a delivered one, a redemption, one still held, another owner's. */
const SNAP = [row(1, "1", 0, 1794704415), row(2, "2", 0, 1794704415), row(3, "3", 0, 1794704415), row(4, "5", 0, 1794643971, "1000"), row(5, "6", 1, 1794647572), row(6, "7", 0, 1900000000), row(7, "8", 0, 1, "0", "0x00000000000000000000000000000000000000b2")];

test("held: only the owner's open deposit claims out of their hold; the sum of their requests' claimable", async () => {
  expect(matured(SNAP, ADMIN.toLowerCase(), 1794704415n).map((c) => c.id)).toEqual([1, 2, 3]);
  expect(matured(SNAP, ADMIN, 1794704414n)).toEqual([]);
  const q = reader((fn, args) => (fn === "claimableDepositRequest" ? (args[0] === 1n ? 998592n : 998591n) : 0n), 1800000000n);
  const r = await held(q, SNAP, ADMIN);
  expect(r.claims.map((c) => c.id)).toEqual([1, 2, 3]);
  expect(r.sum).toBe(998592n + 998591n + 998591n);
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "queue-flow-held-"));
  const snap = join(dir, "claims-before.json");
  writeFileSync(snap, JSON.stringify(SNAP, null, 2) + "\n");
  await main(q, "held", { snapshot: snap, owner: ADMIN, "out-sum": join(dir, "sum"), "out-claims": join(dir, "claims") });
  expect(readFileSync(join(dir, "sum"), "utf8")).toBe(`${998592n + 998591n * 2n}\n`);
  expect(readFileSync(join(dir, "claims"), "utf8")).toBe("1,2,3\n");
});

test("refresh rewrites only the claimed entries from the chain, refuses one still claimable, and a rerun claims 0", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "queue-flow-refresh-"));
  const snap = join(dir, "claims-before.json"), ids = join(dir, "claims");
  writeFileSync(snap, JSON.stringify(SNAP, null, 2) + "\n");
  writeFileSync(ids, "1,2,3\n");
  const chain = (left: bigint) => reader((fn, args) => {
    if (fn === "claimableDepositRequest") return left;
    const id = Number(args[0]);
    return { requestId: BigInt(id), owner: ADMIN, kind: 0, settlementId: 1n, unlockAt: 1794704415n, shares: 1000n, usdc: 998592n, claimed: 1000n, sharesClaimed: 0n };
  }, 1800000000n);
  await expect(refresh(chain(5n), SNAP, ADMIN, [1])).rejects.toThrow("still has 5 claimable");
  await main(chain(0n), "refresh", { snapshot: snap, owner: ADMIN, "claims-file": ids });
  const after = JSON.parse(readFileSync(snap, "utf8")) as ClaimRow[];
  expect(after.filter((c) => [1, 2, 3].includes(c.id)).map((c) => c.claimed)).toEqual(["1000", "1000", "1000"]);
  expect(after.filter((c) => ![1, 2, 3].includes(c.id))).toEqual(SNAP.filter((c) => ![1, 2, 3].includes(c.id)));
  expect(Object.keys(after[0]!)).toEqual(Object.keys(SNAP[0]!));
  // the rerun: nothing matured is open any more, so the sum is 0 and no claim is listed
  await main(chain(0n), "held", { snapshot: snap, owner: ADMIN, "out-sum": join(dir, "sum"), "out-claims": ids });
  expect(readFileSync(join(dir, "sum"), "utf8")).toBe("0\n");
  expect(readFileSync(ids, "utf8")).toBe("\n");
  await main(chain(0n), "refresh", { snapshot: snap, owner: ADMIN, "claims-file": ids });
  expect(JSON.parse(readFileSync(snap, "utf8"))).toEqual(after);
});
