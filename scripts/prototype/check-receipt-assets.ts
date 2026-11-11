#!/usr/bin/env bun
// One-vault experiment (docs/technical/one-vault-rebalancer-proposal.md §4.1, §5.1 step 2, §7 RB-9).
//
// Checks the `assets` field of a consensus receipt 1.1 and prints the per-asset vector a govern row
// would submit to `RebalanceGovernance.applyReceipt(receiptId, digest, assets, bps)`.
//
//   bun scripts/prototype/check-receipt-assets.ts <receipt.json> [--map FILE] [--schema FILE] [--chain ID]
//                                                 [--adapter ROLE=0xADDR ...]
//   bun scripts/prototype/check-receipt-assets.ts --sim-vectors [--write]
//
// Default map and schema: contracts/test/prototype/fixtures/receipt/{asset-map.json,
// consensus-receipt-1.1.schema.json}. Default chain: 8453.
//
// Checks, in this order. The first failure is the refusal:
//   SCHEMA_VERSION_UNSUPPORTED  schema_version is not "1.1".
//   FIELD_ORDER_INVALID         a top-level key is not a schema property, or the keys are out of schema
//                               order (so `assets` must come last, after `weights`).
//   WEIGHTS_MISSING             `assets` is present but `weights` is not (schema 1.1 dependencies).
//   WEIGHTS_INVALID             `weights` is not the four canonical buckets in order, integer bps, sum 10,000.
//   ASSETS_MISSING              no `assets`, or an empty list. The govern row has nothing to submit.
//   ASSET_ENTRY_INVALID         an entry is not exactly {asset, sleeve, weight_bps} in that order.
//   ASSET_KEY_MALFORMED         an asset key fails the schema pattern.
//   UNKNOWN_BUCKET              a sleeve label is not a receipt bucket (schema enum).
//   ASSET_WEIGHT_OUT_OF_RANGE   weight_bps is not an integer in [0, 10,000].
//   DUPLICATE_ASSET             an asset key appears twice.
//   UNKNOWN_ASSET               an asset key has no row in the asset map for the chain.
//   ASSET_NOT_LISTED            an active asset in the map is not listed (RB-9: an omission never sells).
//   ASSET_ORDER_INVALID         the entries are not in the map's canonical_asset_order (canonical bytes).
//   ASSET_SUM_INVALID           the weight_bps values do not sum to 10,000.
//   LABEL_MISMATCH              an entry's sleeve label differs from its map row's fixed bucket.
//   BUCKET_HAS_NO_ASSETS        a nonzero bucket has no asset labelled with it.
//   BUCKET_SUM_MISMATCH         the bucket audit: labelled asset sums differ from the bucket weights.
//   LENDING_CAP_EXCEEDED        a lending asset's target is above its cap_bps.
//
// The vector is ordered by fund index. Each row carries the on-chain asset id the 3b contracts take
// (PlanMath.assetId): the token address for a Basket asset, the adapter address for a Lending asset.
// Adapter addresses are deploy-time, so a Lending id prints as its harness role ("aaveAdapter") unless
// --adapter aaveAdapter=0x... supplies the address. `asset_ids` is complete only when every role is given.
//
// Exit 0 and a JSON vector on stdout on success. Exit 1 and "REFUSE <REASON>: <detail>" on stderr on a
// refusal. Exit 2 on a usage or file error.
//
// --sim-vectors derives, for every receipt the rebalance sim uses, the per-asset vector the sleeve
// design produced (PlanMath.assetTargets with the harness's intra weights), and compares it with
// contracts/test/prototype/fixtures/receipt/sim-asset-vectors.json. --write rewrites that file.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../..");
export const FIXTURE_DIR = join(REPO, "contracts/test/prototype/fixtures/receipt");
export const DEFAULT_MAP = join(FIXTURE_DIR, "asset-map.json");
export const DEFAULT_SCHEMA = join(FIXTURE_DIR, "consensus-receipt-1.1.schema.json");
export const SIM_VECTORS = join(FIXTURE_DIR, "sim-asset-vectors.json");
export const BPS = 10_000;

export type Reason =
  | "SCHEMA_VERSION_UNSUPPORTED"
  | "FIELD_ORDER_INVALID"
  | "WEIGHTS_MISSING"
  | "WEIGHTS_INVALID"
  | "ASSETS_MISSING"
  | "ASSET_ENTRY_INVALID"
  | "ASSET_KEY_MALFORMED"
  | "UNKNOWN_BUCKET"
  | "ASSET_WEIGHT_OUT_OF_RANGE"
  | "DUPLICATE_ASSET"
  | "UNKNOWN_ASSET"
  | "ASSET_NOT_LISTED"
  | "ASSET_ORDER_INVALID"
  | "ASSET_SUM_INVALID"
  | "LABEL_MISMATCH"
  | "BUCKET_HAS_NO_ASSETS"
  | "BUCKET_SUM_MISMATCH"
  | "LENDING_CAP_EXCEEDED";

export class ReceiptRefused extends Error {
  constructor(
    readonly reason: Reason,
    readonly detail: string,
  ) {
    super(`REFUSE ${reason}: ${detail}`);
  }
}

export interface MapRow {
  asset: string;
  /** The receipt bucket this asset is always reported under. A receipt label must match it. */
  bucket: string;
  fund_index: number;
  active: boolean;
  kind: "Lending" | "Basket";
  cap_bps: number | null;
  asset_id: { source: "token" | "adapter"; address: string | null; adapter_role?: string };
}

export interface GovernRow {
  fund_index: number;
  asset: string;
  sleeve: string;
  weight_bps: number;
  /** On-chain asset id (address), or null when it is a deploy-time adapter address not supplied. */
  asset_id: string | null;
  /** Harness role of a Lending adapter. */
  adapter_role?: string;
}

export interface GovernVector {
  chain_id: number;
  /** Fund asset indices, ascending. One per active asset. */
  assets: number[];
  /** Target bps per entry of `assets`. Sums to 10,000. */
  bps: number[];
  /** Asset ids per entry of `assets`, the `address[]` the 3b `applyReceipt` takes. Null where unresolved. */
  asset_ids: (string | null)[];
  rows: GovernRow[];
}

/** The rules the 1.1 schema states for `assets` and `weights`, read from the schema file itself. */
export interface SchemaRules {
  version: string;
  /** Top-level property names in schema order. The canonical bytes follow this order. */
  fieldOrder: string[];
  buckets: string[];
  assetKeyPattern: RegExp;
  entryFields: string[];
  weightMax: number;
}

export function loadSchemaRules(path = DEFAULT_SCHEMA): SchemaRules {
  const s = JSON.parse(readFileSync(path, "utf8"));
  const aw = s.definitions.asset_weight;
  return {
    version: s.properties.schema_version.const,
    fieldOrder: Object.keys(s.properties),
    buckets: s.definitions.bucket_weight.properties.bucket.enum,
    assetKeyPattern: new RegExp(aw.properties.asset.pattern),
    entryFields: aw.required,
    weightMax: aw.properties.weight_bps.maximum,
  };
}

export function loadMapRows(chainId: number, path = DEFAULT_MAP): MapRow[] {
  const m = JSON.parse(readFileSync(path, "utf8"));
  const chain = m.chains?.[String(chainId)];
  if (!chain) throw new Error(`asset map has no chain ${chainId}`);
  return chain.assets;
}

/** The asset map's canonical_asset_order: the order an assembler emits `assets` entries in. */
export function loadCanonicalOrder(path = DEFAULT_MAP): string[] {
  const m = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(m.canonical_asset_order)) throw new Error("asset map has no canonical_asset_order");
  return m.canonical_asset_order;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

/** Check a parsed receipt. Returns the govern vector or throws `ReceiptRefused`. */
export function checkReceiptAssets(
  receipt: any,
  rows: MapRow[],
  rules: SchemaRules,
  chainId = 8453,
  adapters: Record<string, string> = {},
  order: string[] = loadCanonicalOrder(),
): GovernVector {
  const no = (reason: Reason, detail: string): never => {
    throw new ReceiptRefused(reason, detail);
  };

  if (receipt?.schema_version !== rules.version) {
    no("SCHEMA_VERSION_UNSUPPORTED", `schema_version is ${JSON.stringify(receipt?.schema_version)}, need "${rules.version}"`);
  }
  // Top-level keys: each a schema property, in schema order. Entry order is part of the canonical bytes.
  const top = Object.keys(receipt);
  let at = -1;
  for (const k of top) {
    const i = rules.fieldOrder.indexOf(k);
    if (i < 0) no("FIELD_ORDER_INVALID", `top-level key ${JSON.stringify(k)} is not a schema 1.1 property`);
    if (i <= at) no("FIELD_ORDER_INVALID", `top-level key ${k} is out of schema order (${rules.fieldOrder.join(", ")})`);
    at = i;
  }
  const hasAssets = receipt.assets !== undefined;
  if (hasAssets && receipt.weights === undefined) {
    no("WEIGHTS_MISSING", "assets needs weights for the bucket audit");
  }

  // weights: the four canonical buckets, in order, integer bps, sum 10,000.
  const w = receipt.weights;
  if (w !== undefined) {
    if (!Array.isArray(w) || w.length !== rules.buckets.length) {
      no("WEIGHTS_INVALID", `weights must list the ${rules.buckets.length} canonical buckets`);
    }
    let sum = 0;
    rules.buckets.forEach((b, i) => {
      const e = w[i];
      if (e?.bucket !== b) no("WEIGHTS_INVALID", `weights[${i}] must be bucket ${b}`);
      if (!isInt(e.weight_bps) || e.weight_bps < 0 || e.weight_bps > BPS) {
        no("WEIGHTS_INVALID", `weights[${i}].weight_bps is not an integer in [0, 10000]`);
      }
      sum += e.weight_bps;
    });
    if (sum !== BPS) no("WEIGHTS_INVALID", `weights sum to ${sum}, not 10000`);
  }

  const a = receipt.assets;
  if (!Array.isArray(a) || a.length === 0) {
    no("ASSETS_MISSING", "a 1.1 receipt the govern row applies must carry a non-empty assets list");
  }

  // Entry shape, key pattern, bucket label, weight range (the schema's own rules).
  a.forEach((e: any, i: number) => {
    if (e === null || typeof e !== "object" || Array.isArray(e)) no("ASSET_ENTRY_INVALID", `assets[${i}] is not an object`);
    const keys = Object.keys(e);
    if (keys.join(",") !== rules.entryFields.join(",")) {
      no("ASSET_ENTRY_INVALID", `assets[${i}] has fields [${keys.join(", ")}], need [${rules.entryFields.join(", ")}]`);
    }
    if (typeof e.asset !== "string" || !rules.assetKeyPattern.test(e.asset)) {
      no("ASSET_KEY_MALFORMED", `assets[${i}].asset ${JSON.stringify(e.asset)} fails ${rules.assetKeyPattern}`);
    }
    if (!rules.buckets.includes(e.sleeve)) {
      no("UNKNOWN_BUCKET", `assets[${i}] (${e.asset}) is labelled ${JSON.stringify(e.sleeve)}, not a receipt bucket`);
    }
    if (!isInt(e.weight_bps) || e.weight_bps < 0 || e.weight_bps > rules.weightMax) {
      no("ASSET_WEIGHT_OUT_OF_RANGE", `assets[${i}] (${e.asset}) weight_bps ${e.weight_bps} is not an integer in [0, ${rules.weightMax}]`);
    }
  });

  const seen = new Set<string>();
  for (const e of a) {
    if (seen.has(e.asset)) no("DUPLICATE_ASSET", `${e.asset} is listed twice`);
    seen.add(e.asset);
  }

  const byKey = new Map(rows.map((r) => [r.asset, r]));
  for (const e of a) {
    const r = byKey.get(e.asset);
    if (!r) no("UNKNOWN_ASSET", `${e.asset} has no asset map row for chain ${chainId}`);
    if (!r!.active) no("UNKNOWN_ASSET", `${e.asset} is not an active fund asset on chain ${chainId}`);
  }
  for (const r of rows) {
    if (r.active && !seen.has(r.asset)) {
      no("ASSET_NOT_LISTED", `active asset ${r.asset} (fund index ${r.fund_index}) is not listed. List it with 0 to sell it.`);
    }
  }

  // Entry order: the map's canonical_asset_order (part of the canonical bytes).
  let pos = -1;
  for (const e of a) {
    const i = order.indexOf(e.asset);
    if (i < 0) no("ASSET_ORDER_INVALID", `${e.asset} is not in the asset map's canonical_asset_order`);
    if (i <= pos) no("ASSET_ORDER_INVALID", `${e.asset} is out of canonical_asset_order (${order.join(", ")})`);
    pos = i;
  }

  const total = a.reduce((s: number, e: any) => s + e.weight_bps, 0);
  if (total !== BPS) no("ASSET_SUM_INVALID", `assets sum to ${total}, not 10000`);

  // Labels are fixed per asset by the map. Without this, relabelling assets could pass any bucket audit.
  for (const e of a) {
    const r = byKey.get(e.asset)!;
    if (e.sleeve !== r.bucket) {
      no("LABEL_MISMATCH", `${e.asset} is labelled ${e.sleeve} but the asset map reports it under ${r.bucket}`);
    }
  }

  // Bucket audit (§4.1). Nonzero buckets with no labelled asset first, then the sums.
  const labelled = new Map<string, number>();
  const count = new Map<string, number>();
  for (const e of a) {
    labelled.set(e.sleeve, (labelled.get(e.sleeve) ?? 0) + e.weight_bps);
    count.set(e.sleeve, (count.get(e.sleeve) ?? 0) + 1);
  }
  for (const b of w) {
    if (b.weight_bps > 0 && !count.get(b.bucket)) {
      no("BUCKET_HAS_NO_ASSETS", `bucket ${b.bucket} is ${b.weight_bps} bps but no asset is labelled with it`);
    }
  }
  for (const b of w) {
    const got = labelled.get(b.bucket) ?? 0;
    if (got !== b.weight_bps) {
      no("BUCKET_SUM_MISMATCH", `bucket ${b.bucket} is ${b.weight_bps} bps but its labelled assets sum to ${got}`);
    }
  }

  for (const e of a) {
    const r = byKey.get(e.asset)!;
    if (r.kind === "Lending" && r.cap_bps !== null && e.weight_bps > r.cap_bps) {
      no("LENDING_CAP_EXCEEDED", `${e.asset} target ${e.weight_bps} is above its cap_bps ${r.cap_bps}`);
    }
  }

  const out: GovernRow[] = a
    .map((e: any) => {
      const r = byKey.get(e.asset)!;
      const row: GovernRow = { fund_index: r.fund_index, asset: e.asset, sleeve: e.sleeve, weight_bps: e.weight_bps, asset_id: r.asset_id.address };
      if (r.asset_id.source === "adapter") {
        row.adapter_role = r.asset_id.adapter_role;
        row.asset_id = r.asset_id.address ?? adapters[r.asset_id.adapter_role!] ?? null;
      }
      return row;
    })
    .sort((x: GovernRow, y: GovernRow) => x.fund_index - y.fund_index);
  return {
    chain_id: chainId,
    assets: out.map((r) => r.fund_index),
    asset_ids: out.map((r) => r.asset_id),
    bps: out.map((r) => r.weight_bps),
    rows: out,
  };
}

// ─── Sleeve design reproduction (phase 3b sim port) ───────────────────────────────────────────────────

export interface SleeveDesignAsset {
  asset: string;
  fund_index: number;
  sleeve: number;
  intra_bps: number;
  cap_bps: number | null;
}

/**
 * PlanMath.assetTargets, exactly: for each sleeve s in id order with sleeveBps[s] > 0, each active asset
 * of s in fund index order gets floor(sleeveBps[s] * intra_bps / 10000). The sleeve's floor remainder
 * goes to its LAST active asset (highest fund index). Then FundAdminLib._endTargets refuses (does not
 * clamp) a lending target above cap_bps.
 */
export function sleeveDesignAssetBps(sleeveBps: number[], design: SleeveDesignAsset[]): number[] {
  const n = Math.max(...design.map((d) => d.fund_index)) + 1;
  const t = new Array<number>(n).fill(0);
  const ordered = [...design].sort((x, y) => x.fund_index - y.fund_index);
  sleeveBps.forEach((sw, s) => {
    if (sw === 0) return;
    const members = ordered.filter((d) => d.sleeve === s);
    if (members.length === 0) throw new Error(`SleeveHasNoAssets(${s})`);
    const intraSum = members.reduce((acc, d) => acc + d.intra_bps, 0);
    if (intraSum !== BPS) throw new Error(`IntraSleeveSumInvalid(${s}, ${intraSum})`);
    let given = 0;
    for (const d of members) {
      t[d.fund_index] = Math.floor((sw * d.intra_bps) / BPS);
      given += t[d.fund_index];
    }
    t[members[members.length - 1].fund_index] += sw - given;
  });
  for (const d of design) {
    if (d.cap_bps !== null && t[d.fund_index] > d.cap_bps) {
      throw new Error(`TargetExceedsCap(${d.fund_index}, ${t[d.fund_index]}, ${d.cap_bps})`);
    }
  }
  return t;
}

/** Recompute every `asset_bps` in the sim vectors file from its `sleeve_bps` and design. */
export function deriveSimVectors(file: any): any {
  const out = structuredClone(file);
  for (const r of Object.values<any>(out.receipts)) {
    r.asset_bps = sleeveDesignAssetBps(r.sleeve_bps, out.sleeve_design.assets);
  }
  return out;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────────────────────────────

function main(argv: string[]): number {
  const opt = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  if (argv.includes("--sim-vectors")) {
    const file = JSON.parse(readFileSync(SIM_VECTORS, "utf8"));
    const derived = deriveSimVectors(file);
    const text = JSON.stringify(derived, null, 2) + "\n";
    if (argv.includes("--write")) {
      writeFileSync(SIM_VECTORS, text);
      console.log(`wrote ${SIM_VECTORS}`);
      return 0;
    }
    if (text !== readFileSync(SIM_VECTORS, "utf8")) {
      console.error("sim-asset-vectors.json differs from the derivation. Run with --sim-vectors --write.");
      return 1;
    }
    for (const [label, r] of Object.entries<any>(derived.receipts)) {
      console.log(`${label.padEnd(4)} sleeves ${JSON.stringify(r.sleeve_bps)} -> assets ${JSON.stringify(r.asset_bps)}`);
    }
    return 0;
  }

  const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
  const adapters: Record<string, string> = {};
  for (let i = 0; i < argv.length; ++i) {
    if (argv[i] !== "--adapter") continue;
    const m = /^([A-Za-z0-9_]+)=(0x[0-9a-fA-F]{40})$/.exec(argv[i + 1] ?? "");
    if (!m) {
      console.error("usage: --adapter ROLE=0x<40 hex>");
      return 2;
    }
    adapters[m[1]] = m[2];
  }
  if (positional.length !== 1) {
    console.error("usage: check-receipt-assets.ts <receipt.json> [--map FILE] [--schema FILE] [--chain ID] [--adapter ROLE=0x...]");
    return 2;
  }
  const chainId = Number(opt("chain") ?? 8453);
  let receipt: unknown;
  let rows: MapRow[];
  let rules: SchemaRules;
  let order: string[];
  try {
    receipt = JSON.parse(readFileSync(positional[0], "utf8"));
    rows = loadMapRows(chainId, opt("map") ?? DEFAULT_MAP);
    order = loadCanonicalOrder(opt("map") ?? DEFAULT_MAP);
    rules = loadSchemaRules(opt("schema") ?? DEFAULT_SCHEMA);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 2;
  }
  try {
    const v = checkReceiptAssets(receipt, rows, rules, chainId, adapters, order);
    console.log(JSON.stringify(v, null, 2));
    return 0;
  } catch (e) {
    if (e instanceof ReceiptRefused) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
