#!/usr/bin/env bun
// scripts/runbook/fund-receipt-payload.ts: the consensus receipt payload of the FUND system (Deploy 4, the one-vault prototype): schema 1.1, the per-asset `assets` list.
//   bun scripts/runbook/fund-receipt-payload.ts --out FILE --bps "[B0,B1,...]" (--rpc URL --fund-manifest FILE | --assets KEY,KEY,... [--asset-ids 0x..,0x..])
//                                                [--chain ID] [--map-out FILE] [--session-id UUID]
//
// The fund's assets, in fund index order, come from the chain (--rpc, the fund named by --fund-manifest, its assetConfigs()) or from flags (--assets, stable asset keys of the
// canonical asset map, with --asset-ids their on-chain ids when known). On chain, a Basket asset is matched to its map row by token address and a Lending asset by its adapter
// address, through the fund manifest's aave_adapter, compound_adapter and moonwell_adapter (the map's adapter roles aaveAdapter, cometAdapter, moonwellAdapter); an asset no map
// row matches, or whose kind differs from its row's, is refused. The bucket every asset is reported under is its canonical map row's (never chosen here).
// --bps is the target vector in fund index order (cast array syntax or a comma list), integers summing to exactly 10000, one per asset; an inactive asset must be 0.
//
// The payload is the real production envelope (scripts/runbook/receipt-payload.ts ENVELOPE) at schema_version 1.1, with `weights` the bucket sums of the assets and `assets` the
// active assets in the map's canonical_asset_order, compact JSON and one trailing newline. --session-id replaces the envelope's session (a receipt id is recorded once per register).
// The Twin and the fund rehearsal never verify the analyst signatures: the register stores only the digest.
//
// --map-out writes the asset map of THIS deployment: the canonical rows (contracts/test/prototype/fixtures/receipt/asset-map.json, chain 8453; the Twin is a fork of it) with the
// fund index, active flag, cap and on-chain id the fund itself reports, under --chain (default: the RPC's chain id, else 8453). scripts/prototype/check-receipt-assets.ts
// --map FILE --chain ID then checks the payload against the deployed fund, and its vector (asset_ids, bps) is what the governing Safe applies.
//
// Before anything is written the payload is checked by check-receipt-assets (every schema 1.1 rule) and by publish-contracts/src/receipt-digest.ts (the canonical form and
// schema 1.1, the fund's record-receipt rule). stdout is one JSON line: chain_id, receipt_id and payload_digest (the one shared definition: payload_digest =
// keccak256("robotmoney:consensus-receipt:v1\n" + the canonical bytes), never a plain keccak256 of the file), the fund vector (asset_ids and bps in fund index order) and the keys.
// Exit 0 on success, 1 when the payload is refused (REFUSE <REASON>: ...), 2 on a usage, file or chain error.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAP, DEFAULT_SCHEMA, ReceiptRefused, checkReceiptAssets, loadSchemaRules, type GovernVector, type MapRow } from "../prototype/check-receipt-assets.ts";
import { ENVELOPE } from "./receipt-payload.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** The chain of the canonical map rows: Base. The Twin is a fork of it, so its tokens and venues are the same. */
export const CANONICAL_CHAIN = 8453;
export const BPS = 10_000;
/** The fund manifest's adapter fields (contracts/script/DeployFund.s.sol _writeDeploymentJson) and the map's adapter role each one is. */
export const ADAPTER_FIELDS: Readonly<Record<string, string>> = { aave_adapter: "aaveAdapter", compound_adapter: "cometAdapter", moonwell_adapter: "moonwellAdapter" };
/** contracts/test/prototype/src/FundTypes.sol AssetKind. */
const KINDS = ["Lending", "Basket"] as const;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const lc = (s: string) => s.toLowerCase();

/** One asset of the deployed fund, in fund index order (assetConfigs()). */
export interface FundAsset {
  kind: "Lending" | "Basket"; active: boolean; capBps: number; adapter: string; token: string;
  /** Flags only (--assets): the map row's adapter role of a Lending asset whose adapter address is not known. Never set for an asset read on chain. */
  role?: string;
}
interface CanonicalMap { canonical_asset_order: string[]; chains: Record<string, { assets: (MapRow & { token?: string | null })[] }> }

export const loadCanonicalMap = (path = DEFAULT_MAP): CanonicalMap => JSON.parse(readFileSync(path, "utf8"));

/** PURE. The --bps vector: `[a,b,c]` or `a,b,c`, integers in [0, 10000], `n` of them, summing to exactly 10000. */
export function parseBps(spec: string, n: number): number[] {
  const parts = spec.replace(/^\s*\[|\]\s*$/g, "").split(",").map((x) => x.trim());
  if (parts.some((p) => !/^\d+$/.test(p))) throw new Error(`--bps is a list of integers (cast array syntax [a,b,...] or a,b,...), got '${spec}'`);
  const v = parts.map(Number);
  if (v.length !== n) throw new Error(`--bps names ${v.length} weights and the fund has ${n} assets: one weight per asset, in fund index order`);
  if (v.some((x) => x > BPS)) throw new Error(`--bps has a weight above ${BPS}`);
  const sum = v.reduce((a, b) => a + b, 0);
  if (sum !== BPS) throw new Error(`--bps sums to ${sum}, not ${BPS}`);
  return v;
}

/**
 * PURE. The map row of every fund asset, in fund index order: a Basket by its token address, a Lending asset by its adapter's role (`roles`: adapter address -> role, from the fund
 * manifest). Throws when an asset matches no row, matches two, or its kind differs from its row's.
 */
export function matchAssets(assets: FundAsset[], canonical: CanonicalMap, roles: Record<string, string>): MapRow[] {
  const rows = canonical.chains[String(CANONICAL_CHAIN)]?.assets;
  if (!rows) throw new Error(`the canonical asset map has no chain ${CANONICAL_CHAIN}`);
  const byRole = Object.fromEntries(Object.entries(roles).map(([a, r]) => [lc(a), r]));
  return assets.map((a, i) => {
    const hits = a.kind === "Basket"
      ? rows.filter((r) => r.asset_id.source === "token" && r.asset_id.address !== null && lc(r.asset_id.address) === lc(a.token))
      : rows.filter((r) => r.asset_id.source === "adapter" && r.asset_id.adapter_role !== undefined && r.asset_id.adapter_role === (a.role ?? byRole[lc(a.adapter)]));
    if (hits.length !== 1) throw new Error(`fund asset ${i} (${a.kind}, ${a.kind === "Basket" ? `token ${a.token}` : `adapter ${a.adapter}`}) matches ${hits.length} rows of the canonical asset map, not one`);
    const row = hits[0]!;
    if (row.kind !== a.kind) throw new Error(`fund asset ${i} is ${a.kind} on chain but its map row ${row.asset} is ${row.kind}`);
    return row;
  });
}

/** PURE. The asset map of this deployment: each canonical row with the fund's own index, active flag, cap and on-chain id, under `chainId`. */
export function deploymentMap(rows: MapRow[], assets: FundAsset[], canonical: CanonicalMap, chainId: number): object {
  const seen = new Set<string>();
  for (const r of rows) { if (seen.has(r.asset)) throw new Error(`two fund assets are the map's ${r.asset}`); seen.add(r.asset); }
  return {
    schema_version: "1.1",
    description: "The asset map of one deployed fund (scripts/runbook/fund-receipt-payload.ts --map-out): the canonical rows of contracts/test/prototype/fixtures/receipt/asset-map.json (chain 8453) with the fund index, active flag, cap and on-chain asset id the deployed fund reports.",
    canonical_asset_order: canonical.canonical_asset_order,
    chains: {
      [String(chainId)]: {
        deployment: "the deployed fund (assetConfigs()) and its manifest",
        assets: rows.map((r, i) => {
          const a = assets[i]!;
          const id = a.kind === "Basket" ? { source: "token", address: a.token } : { source: "adapter", adapter_role: r.asset_id.adapter_role, address: ADDR.test(a.adapter) && !/^0x0{40}$/.test(a.adapter) ? a.adapter : null };
          return { asset: r.asset, bucket: r.bucket, fund_index: i, asset_id: id, active: a.active, kind: a.kind, cap_bps: a.kind === "Lending" ? a.capBps : null };
        }),
      },
    },
  };
}

/** PURE. The canonical payload: the envelope at schema 1.1, the bucket sums as `weights`, the active assets in canonical_asset_order as `assets`; compact, one trailing newline. */
export function fundPayloadOf(envelope: Record<string, unknown>, rows: MapRow[], assets: FundAsset[], bps: number[], canonicalOrder: string[], buckets: string[], sessionId?: string): string {
  if (sessionId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sessionId)) throw new Error(`--session-id is a lower-case version 4 UUID, got '${sessionId}'`);
  assets.forEach((a, i) => { if (!a.active && bps[i] !== 0) throw new Error(`fund asset ${i} (${rows[i]!.asset}) is inactive: its weight must be 0, got ${bps[i]}`); });
  const listed = rows.map((r, i) => ({ r, i })).filter(({ i }) => assets[i]!.active);
  for (const { r } of listed) if (!canonicalOrder.includes(r.asset)) throw new Error(`${r.asset} is not in the asset map's canonical_asset_order`);
  listed.sort((x, y) => canonicalOrder.indexOf(x.r.asset) - canonicalOrder.indexOf(y.r.asset));
  const weights = buckets.map((bucket) => ({ bucket, weight_bps: listed.filter(({ r }) => r.bucket === bucket).reduce((s, { i }) => s + bps[i]!, 0) }));
  const entries = listed.map(({ r, i }) => ({ asset: r.asset, sleeve: r.bucket, weight_bps: bps[i]! }));
  const { weights: _w, assets: _a, ...rest } = envelope;
  return `${JSON.stringify({ ...rest, schema_version: "1.1", ...(sessionId === undefined ? {} : { session_id: sessionId }), weights, assets: entries })}\n`;
}

/** The fund's assets read on chain: assetConfigs() of the fund. viem is publish-contracts' (the repository root has no package of its own). */
async function readFundAssets(rpc: string, fund: string): Promise<{ chainId: number; assets: FundAsset[] }> {
  const viem = await import(join(ROOT, "publish-contracts", "node_modules", "viem"));
  const client = viem.createPublicClient({ transport: viem.http(rpc) });
  const abi = viem.parseAbi(["function assetConfigs() view returns ((uint8 kind, bool active, uint16 capBps, address adapter, address token, address pool, uint24 poolFee, uint32 twapWindow, uint8 venue, address feed, uint32 maxFeedAge)[])"]);
  const raw = (await client.readContract({ address: fund, abi, functionName: "assetConfigs" })) as { kind: number; active: boolean; capBps: number; adapter: string; token: string }[];
  const chainId = await client.getChainId();
  return { chainId, assets: raw.map((c) => ({ kind: KINDS[c.kind] ?? (() => { throw new Error(`fund asset kind ${c.kind} is unknown`); })(), active: c.active, capBps: Number(c.capBps), adapter: c.adapter, token: c.token })) };
}

/** The payload digest and receipt id from the one shared definition (publish-contracts/src/receipt-digest.ts), with the fund's schema 1.1 rule. */
async function digestOf(bytes: Uint8Array): Promise<{ digest: string; receiptId: string }> {
  const lib = await import(join(ROOT, "publish-contracts", "src", "receipt-digest.ts"));
  return lib.supportedReceiptPayload(bytes, lib.FUND_RECEIPT_SCHEMA_VERSION);
}

export interface BuildResult { payload: string; map: object; vector: GovernVector; receiptId: string; payloadDigest: string; chainId: number; keys: string[] }

/** Build, check and return everything; writes nothing. Throws ReceiptRefused when check-receipt-assets refuses, Error otherwise. */
export async function build(o: { assets: FundAsset[]; roles: Record<string, string>; bps: string; chainId: number; sessionId?: string; canonical?: CanonicalMap; envelope?: Record<string, unknown> }): Promise<BuildResult> {
  const canonical = o.canonical ?? loadCanonicalMap();
  const rules = loadSchemaRules(DEFAULT_SCHEMA);
  const rows = matchAssets(o.assets, canonical, o.roles);
  const bps = parseBps(o.bps, o.assets.length);
  const map = deploymentMap(rows, o.assets, canonical, o.chainId);
  const payload = fundPayloadOf(o.envelope ?? (JSON.parse(readFileSync(ENVELOPE, "utf8")) as Record<string, unknown>), rows, o.assets, bps, canonical.canonical_asset_order, rules.buckets, o.sessionId);
  const mapRows = (map as { chains: Record<string, { assets: MapRow[] }> }).chains[String(o.chainId)]!.assets;
  const vector = checkReceiptAssets(JSON.parse(payload), mapRows, rules, o.chainId, {}, canonical.canonical_asset_order);
  // the vector check-receipt-assets derives from the payload must be the one asked for, asset by asset in fund index order
  const want = o.assets.map((a, i) => ({ i, a })).filter(({ a }) => a.active);
  if (vector.assets.join(",") !== want.map(({ i }) => i).join(",") || vector.bps.join(",") !== want.map(({ i }) => bps[i]).join(",")) throw new Error(`the payload's vector ${JSON.stringify(vector.bps)} is not --bps ${JSON.stringify(bps)}`);
  const d = await digestOf(new TextEncoder().encode(payload));
  return { payload, map, vector, receiptId: d.receiptId, payloadDigest: d.digest, chainId: o.chainId, keys: rows.map((r) => r.asset) };
}

/** The fund's assets from flags: stable keys in fund index order, their kind and cap from the canonical map, with on-chain ids when given (--asset-ids). */
export function assetsFromFlags(keys: string, ids: string | undefined, canonical: CanonicalMap = loadCanonicalMap()): { assets: FundAsset[]; roles: Record<string, string> } {
  const rows = canonical.chains[String(CANONICAL_CHAIN)]!.assets;
  const ks = keys.split(",").map((k) => k.trim());
  const idList = ids === undefined ? [] : ids.split(",").map((x) => x.trim());
  if (ids !== undefined && idList.length !== ks.length) throw new Error(`--asset-ids names ${idList.length} ids for ${ks.length} --assets`);
  for (const x of idList) if (!ADDR.test(x)) throw new Error(`--asset-ids entry '${x}' is not an address`);
  const ZERO = "0x0000000000000000000000000000000000000000";
  const roles: Record<string, string> = {};
  const assets = ks.map((k, i): FundAsset => {
    const r = rows.find((x) => x.asset === k);
    if (!r) throw new Error(`--assets names ${k}, which has no row in the canonical asset map`);
    if (r.kind === "Basket") {
      if (idList[i] !== undefined && lc(idList[i]!) !== lc(r.asset_id.address ?? "")) throw new Error(`--asset-ids gives ${idList[i]} for ${k}, whose token is ${r.asset_id.address}`);
      return { kind: "Basket", active: true, capBps: 0, adapter: ZERO, token: r.asset_id.address! };
    }
    // a Lending asset: its adapter address when given, else none (the map's asset_id stays null and check-receipt-assets prints its role)
    if (idList[i] !== undefined) roles[idList[i]!] = r.asset_id.adapter_role!;
    return { kind: "Lending", active: true, capBps: r.cap_bps ?? 0, adapter: idList[i] ?? ZERO, token: ZERO, role: r.asset_id.adapter_role! };
  });
  return { assets, roles };
}

async function main(argv: string[]): Promise<number> {
  try {
    const o: Record<string, string> = {};
    const FLAGS = new Set(["out", "bps", "rpc", "fund-manifest", "assets", "asset-ids", "chain", "map-out", "session-id"]);
    for (let i = 0; i < argv.length; i++) {
      const f = argv[i]!.startsWith("--") ? argv[i]!.slice(2) : "";
      if (!FLAGS.has(f) || argv[i + 1] === undefined) throw new Error(`unknown argument '${argv[i]}'`);
      o[f] = argv[++i]!;
    }
    if (!o.out) throw new Error("--out FILE is required");
    if (!o.bps) throw new Error("--bps is required: the target weights in fund index order, summing to 10000");
    if ((o.rpc === undefined) === (o.assets === undefined)) throw new Error("name the fund's assets one way: --rpc URL --fund-manifest FILE (read on chain), or --assets KEY,KEY,...");
    let assets: FundAsset[], roles: Record<string, string>, chainId = o.chain === undefined ? CANONICAL_CHAIN : Number(o.chain);
    if (o.chain !== undefined && !/^\d+$/.test(o.chain)) throw new Error(`--chain is a chain id, got '${o.chain}'`);
    if (o.rpc !== undefined) {
      if (!o["fund-manifest"]) throw new Error("--rpc needs --fund-manifest FILE (the fund stage's fund.json: the fund and its adapter addresses)");
      const m = JSON.parse(readFileSync(o["fund-manifest"], "utf8")) as Record<string, unknown>;
      if (typeof m.fund !== "string" || !ADDR.test(m.fund)) throw new Error(`${o["fund-manifest"]} has no fund address`);
      roles = {};
      for (const [field, role] of Object.entries(ADAPTER_FIELDS)) { const a = m[field]; if (typeof a !== "string" || !ADDR.test(a)) throw new Error(`${o["fund-manifest"]} has no ${field}`); roles[a] = role; }
      const r = await readFundAssets(o.rpc, m.fund);
      if (o.chain !== undefined && r.chainId !== chainId) throw new Error(`the RPC serves chain ${r.chainId}, not --chain ${chainId}`);
      chainId = r.chainId;
      assets = r.assets;
    } else {
      if (o["fund-manifest"] !== undefined) throw new Error("--fund-manifest goes with --rpc");
      ({ assets, roles } = assetsFromFlags(o.assets!, o["asset-ids"]));
    }
    const res = await build({ assets, roles, bps: o.bps, chainId, sessionId: o["session-id"] });
    writeFileSync(o.out, res.payload);
    if (o["map-out"]) writeFileSync(o["map-out"], `${JSON.stringify(res.map, null, 2)}\n`);
    console.log(JSON.stringify({ chain_id: res.chainId, receipt_id: res.receiptId, payload_digest: res.payloadDigest, asset_ids: res.vector.asset_ids, bps: res.vector.bps, keys: res.keys }));
    return 0;
  } catch (e) {
    if (e instanceof ReceiptRefused) { console.error(e.message); return 1; }
    console.error(`fund-receipt-payload: ${(e as Error).message}`);
    return 2;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
