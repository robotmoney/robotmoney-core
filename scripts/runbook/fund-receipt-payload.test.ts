// Tests for scripts/runbook/fund-receipt-payload.ts: the fund system's schema 1.1 receipt payload (Deploy 4), its deployment asset map, and the digest and id from the one shared
// definition. Every payload built here passes scripts/prototype/check-receipt-assets.ts, and every bad input is refused before anything is written.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { DEFAULT_SCHEMA, checkReceiptAssets, loadSchemaRules, type MapRow } from "../prototype/check-receipt-assets.ts";
import { ADAPTER_FIELDS, assetsFromFlags, build, deploymentMap, fundPayloadOf, loadCanonicalMap, matchAssets, parseBps, type FundAsset } from "./fund-receipt-payload.ts";
import { ENVELOPE } from "./receipt-payload.ts";

const ROOT = resolve(import.meta.dir, "../..");
const digestLib = await import(join(ROOT, "publish-contracts", "src", "receipt-digest.ts"));
const viem = await import(join(ROOT, "publish-contracts", "node_modules", "viem"));
const canonical = loadCanonicalMap();
const rules = loadSchemaRules(DEFAULT_SCHEMA);
const envelope = JSON.parse(readFileSync(ENVELOPE, "utf8")) as Record<string, unknown>;
const ZERO = "0x0000000000000000000000000000000000000000";
const WETH = "0x4200000000000000000000000000000000000006", CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const AAVE = "0x00000000000000000000000000000000000a0001", MOON = "0x00000000000000000000000000000000000a0002", COMET = "0x00000000000000000000000000000000000a0003", SWAP = "0x00000000000000000000000000000000000a0004";
/** The deployed fund, as contracts/script/DeployFund.s.sol adds it: aave 0, moonwell 1, weth 2, cbbtc 3, comet 4 (assetConfigs()). */
const DEPLOYED: FundAsset[] = [
  { kind: "Lending", active: true, capBps: 6000, adapter: AAVE, token: ZERO },
  { kind: "Lending", active: true, capBps: 6000, adapter: MOON, token: ZERO },
  { kind: "Basket", active: true, capBps: 0, adapter: SWAP, token: WETH },
  { kind: "Basket", active: true, capBps: 0, adapter: SWAP, token: CBBTC },
  { kind: "Lending", active: true, capBps: 6000, adapter: COMET, token: ZERO },
];
/** The fund manifest's adapter fields, as the runbook reads them from fund.json. */
const ROLES = { [AAVE]: ADAPTER_FIELDS.aave_adapter!, [COMET]: ADAPTER_FIELDS.compound_adapter!, [MOON]: ADAPTER_FIELDS.moonwell_adapter! };
const BPS = "[2000,2500,1200,1300,3000]";

describe("the fund payload from the deployed fund's assets", () => {
  test("the payload passes check-receipt-assets against the deployment map, and its vector is --bps with every on-chain id resolved", async () => {
    const r = await build({ assets: DEPLOYED, roles: ROLES, bps: BPS, chainId: 918453 });
    const rows = (r.map as { chains: Record<string, { assets: MapRow[] }> }).chains["918453"]!.assets;
    const v = checkReceiptAssets(JSON.parse(r.payload), rows, rules, 918453, {}, canonical.canonical_asset_order);
    expect(v.assets).toEqual([0, 1, 2, 3, 4]);
    expect(v.bps).toEqual([2000, 2500, 1200, 1300, 3000]);
    expect(v.asset_ids).toEqual([AAVE, MOON, WETH, CBBTC, COMET]); // the ids RebalanceGovernance.applyReceipt takes: adapter for Lending, token for Basket
    expect(r.keys).toEqual(["aave-v3-usdc", "morpho-usdc", "weth", "cbbtc", "compound-v3-usdc"]);
  });

  test("the canonical bytes: schema 1.1, the envelope's fields in schema order, weights the bucket sums, assets in canonical_asset_order, one trailing newline", async () => {
    const r = await build({ assets: DEPLOYED, roles: ROLES, bps: BPS, chainId: 8453 });
    expect(r.payload.endsWith("}\n") && !r.payload.endsWith("}\n\n")).toBe(true);
    const doc = JSON.parse(r.payload) as Record<string, any>;
    expect(Object.keys(doc)).toEqual(rules.fieldOrder);
    expect(doc.schema_version).toBe("1.1");
    expect(doc.session_id).toBe(envelope.session_id);
    expect(doc.analyst_signatures).toEqual(envelope.analyst_signatures);
    expect(doc.weights).toEqual([
      { bucket: "agent_tokens", weight_bps: 0 }, { bucket: "conservative_defi_yield", weight_bps: 7500 }, { bucket: "protocol_tokens", weight_bps: 2500 }, { bucket: "real_world_assets", weight_bps: 0 },
    ]);
    expect(doc.assets.map((a: any) => a.asset)).toEqual(["morpho-usdc", "aave-v3-usdc", "compound-v3-usdc", "weth", "cbbtc"]);
    expect(r.payload).toBe(`${JSON.stringify(doc)}\n`);
  });

  test("the receipt id and payload digest are the shared definition: keccak256(domain line + canonical bytes), never a plain keccak256 of the file", async () => {
    const r = await build({ assets: DEPLOYED, roles: ROLES, bps: BPS, chainId: 8453 });
    const bytes = new TextEncoder().encode(r.payload);
    expect(r.payloadDigest).toBe(viem.keccak256(viem.toBytes(`robotmoney:consensus-receipt:v1\n${r.payload}`)));
    expect(r.payloadDigest).toBe(digestLib.receiptPayloadDigest(bytes));
    expect(r.payloadDigest).not.toBe(viem.keccak256(bytes));
    const doc = JSON.parse(r.payload);
    expect(r.receiptId).toBe(digestLib.deriveReceiptId(doc.session_id, doc.subject_id));
    expect(r.receiptId).toBe(digestLib.receiptIdOfBytes(bytes)); // what qa-assert receipt-id prints
    // the fund's record-receipt rule accepts it; the vaults path (schema 1.0) does not
    expect(digestLib.supportedReceiptPayload(bytes, digestLib.FUND_RECEIPT_SCHEMA_VERSION).digest).toBe(r.payloadDigest);
    expect(() => digestLib.supportedReceiptPayload(bytes)).toThrow('only "1.0"');
  });

  test("--session-id replaces only the session, and the receipt id changes with it", async () => {
    const a = await build({ assets: DEPLOYED, roles: ROLES, bps: BPS, chainId: 8453 });
    const b = await build({ assets: DEPLOYED, roles: ROLES, bps: BPS, chainId: 8453, sessionId: "00000000-0000-4000-8000-000000000d04" });
    expect(JSON.parse(b.payload).session_id).toBe("00000000-0000-4000-8000-000000000d04");
    expect({ ...JSON.parse(b.payload), session_id: envelope.session_id }).toEqual(JSON.parse(a.payload));
    expect(b.receiptId).not.toBe(a.receiptId);
    await expect(build({ assets: DEPLOYED, roles: ROLES, bps: BPS, chainId: 8453, sessionId: "nope" })).rejects.toThrow("version 4 UUID");
  });

  test("the deployment map keeps the canonical keys and buckets and takes the fund index, active flag, cap and id from the chain", () => {
    const rows = matchAssets(DEPLOYED, canonical, ROLES);
    const m = deploymentMap(rows, DEPLOYED, canonical, 8453) as any;
    expect(m.canonical_asset_order).toEqual(canonical.canonical_asset_order);
    expect(m.chains["8453"].assets.map((r: any) => [r.asset, r.bucket, r.fund_index, r.kind, r.cap_bps, r.asset_id.address])).toEqual([
      ["aave-v3-usdc", "conservative_defi_yield", 0, "Lending", 6000, AAVE],
      ["morpho-usdc", "conservative_defi_yield", 1, "Lending", 6000, MOON],
      ["weth", "protocol_tokens", 2, "Basket", null, WETH],
      ["cbbtc", "protocol_tokens", 3, "Basket", null, CBBTC],
      ["compound-v3-usdc", "conservative_defi_yield", 4, "Lending", 6000, COMET],
    ]);
  });
});

describe("refusals: nothing is built", () => {
  test("--bps must be one integer per asset in [0, 10000], summing to exactly 10000", () => {
    expect(parseBps("[2000,2500,1200,1300,3000]", 5)).toEqual([2000, 2500, 1200, 1300, 3000]);
    expect(parseBps("2000,2500,1200,1300,3000", 5)).toEqual([2000, 2500, 1200, 1300, 3000]);
    expect(() => parseBps("[2000,2500,1200,1300,2999]", 5)).toThrow("not 10000");
    expect(() => parseBps("[5000,5000]", 5)).toThrow("one weight per asset");
    expect(() => parseBps("[2000,2500,1200,1300,-1]", 5)).toThrow("integers");
    expect(() => parseBps("[2000,2500,1200,1300,3000.5]", 5)).toThrow("integers");
    expect(() => parseBps("[10001,0,0,0,0]", 5)).toThrow("above 10000");
  });
  test("an on-chain asset no map row matches, an unknown adapter, or a kind that differs from its row is refused", () => {
    expect(() => matchAssets([{ ...DEPLOYED[2]!, token: "0x00000000000000000000000000000000000000ff" }], canonical, ROLES)).toThrow("matches 0 rows");
    expect(() => matchAssets([{ ...DEPLOYED[0]!, adapter: "0x00000000000000000000000000000000000000ee" }], canonical, ROLES)).toThrow("matches 0 rows");
    const lying = JSON.parse(JSON.stringify(canonical));
    lying.chains["8453"].assets.find((r: any) => r.asset === "weth").kind = "Lending";
    expect(() => matchAssets([DEPLOYED[2]!], lying, ROLES)).toThrow("is Basket on chain but its map row weth is Lending");
  });
  test("the same map row twice is refused; an inactive asset with a nonzero weight is refused", () => {
    const twice = [DEPLOYED[2]!, DEPLOYED[2]!];
    expect(() => deploymentMap(matchAssets(twice, canonical, ROLES), twice, canonical, 8453)).toThrow("two fund assets are the map's weth");
    const inactive = DEPLOYED.map((a, i) => (i === 3 ? { ...a, active: false } : a));
    expect(() => fundPayloadOf(envelope, matchAssets(inactive, canonical, ROLES), inactive, [2000, 2500, 1200, 1300, 3000], canonical.canonical_asset_order, rules.buckets)).toThrow("is inactive: its weight must be 0");
  });
  test("a lending target above its cap is refused by check-receipt-assets (the payload is checked before it is written)", async () => {
    await expect(build({ assets: DEPLOYED, roles: ROLES, bps: "[6500,500,1200,1300,500]", chainId: 8453 })).rejects.toMatchObject({ reason: "LENDING_CAP_EXCEEDED" });
  });
});

describe("assets from flags", () => {
  test("--assets names the keys in fund index order; Lending ids stay unresolved unless --asset-ids gives them", async () => {
    const { assets, roles } = assetsFromFlags("aave-v3-usdc,morpho-usdc,weth,cbbtc,compound-v3-usdc", undefined);
    const r = await build({ assets, roles, bps: BPS, chainId: 8453 });
    expect(r.vector.asset_ids).toEqual([null, null, WETH, CBBTC, null]);
    const withIds = assetsFromFlags("aave-v3-usdc,morpho-usdc,weth,cbbtc,compound-v3-usdc", [AAVE, MOON, WETH, CBBTC, COMET].join(","));
    const r2 = await build({ ...withIds, bps: BPS, chainId: 8453 });
    expect(r2.vector.asset_ids).toEqual([AAVE, MOON, WETH, CBBTC, COMET]);
    expect(r2.payload).toBe(r.payload); // the ids live in the map, never in the payload
    expect(() => assetsFromFlags("weth,nope", undefined)).toThrow("no row in the canonical asset map");
    expect(() => assetsFromFlags("weth", CBBTC)).toThrow("whose token is");
    expect(() => assetsFromFlags("weth,cbbtc", WETH)).toThrow("names 1 ids for 2");
  });
  test("the CLI writes the payload and the map, prints the id, digest and vector, and refuses a bad --bps with exit 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "fund-receipt-payload-test-"));
    try {
      const out = join(dir, "p.json"), map = join(dir, "m.json");
      const ok = spawnSync("bun", [join(import.meta.dir, "fund-receipt-payload.ts"), "--assets", "aave-v3-usdc,morpho-usdc,weth,cbbtc,compound-v3-usdc", "--bps", BPS, "--chain", "918453", "--out", out, "--map-out", map], { encoding: "utf8" });
      expect(ok.status).toBe(0);
      const line = JSON.parse(ok.stdout.trim());
      expect(line.receipt_id).toBe(digestLib.receiptIdOfBytes(new Uint8Array(readFileSync(out))));
      expect(line.payload_digest).toBe(digestLib.receiptPayloadDigest(new Uint8Array(readFileSync(out))));
      const check = spawnSync("bun", [join(ROOT, "scripts", "prototype", "check-receipt-assets.ts"), out, "--map", map, "--chain", "918453"], { encoding: "utf8" });
      expect(check.status).toBe(0);
      expect(JSON.parse(check.stdout).bps).toEqual([2000, 2500, 1200, 1300, 3000]);
      const bad = spawnSync("bun", [join(import.meta.dir, "fund-receipt-payload.ts"), "--assets", "weth,cbbtc", "--bps", "[1,2]", "--out", join(dir, "q.json")], { encoding: "utf8" });
      expect(bad.status).toBe(2);
      expect(bad.stderr).toContain("not 10000");
      const both = spawnSync("bun", [join(import.meta.dir, "fund-receipt-payload.ts"), "--assets", "weth", "--rpc", "http://127.0.0.1:1", "--bps", "[10000]", "--out", join(dir, "r.json")], { encoding: "utf8" });
      expect(both.status).toBe(2);
      expect(both.stderr).toContain("one way");
    } finally { require("node:fs").rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("the v0.8.0-onevault fund flow runs the tools", () => {
  const y = readFileSync(join(ROOT, "docs", "runbooks", "contract-qa", "releases", "v0.8.0-onevault.yaml"), "utf8");
  const step = (id: string, next: string) => y.slice(y.indexOf(`id: "${id}`), y.indexOf(`id: "${next}`));
  test("P6.70 builds the fund payload from the chain; P6.71 checks it and derives the vector; P6.72 records it through the submitter Safe; P6.73 applies that vector", () => {
    expect(step("P6.70-", "P6.71-")).toContain("bun scripts/runbook/fund-receipt-payload.ts --rpc {rpcUrl} --fund-manifest {manifestDir}/fund.json");
    expect(step("P6.71-", "P6.72-")).toContain("scripts/prototype/check-receipt-assets.ts");
    expect(step("P6.72-", "P6.73-")).toContain('"record-receipt", "{common}", "--system", "fund"');
    expect(step("P6.73-", "P6.74-")).toContain("{state:fund-target-assets}");
    expect(step("P6.73-", "P6.74-")).not.toContain("{fundTargetAssets}");
  });
});
