// One-vault experiment (docs/technical/one-vault-rebalancer-proposal.md §4.1, §10 phase 3b).
// Run: bun test scripts/prototype/check-receipt-assets.test.ts

import { describe, expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  checkReceiptAssets,
  DEFAULT_SCHEMA,
  deriveSimVectors,
  FIXTURE_DIR,
  loadMapRows,
  loadSchemaRules,
  ReceiptRefused,
  SIM_VECTORS,
  sleeveDesignAssetBps,
} from "./check-receipt-assets";

const REPO = resolve(import.meta.dir, "../..");
const SCRIPT = join(import.meta.dir, "check-receipt-assets.ts");
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const fixture = (name: string) => read(join(FIXTURE_DIR, name));

const cases = fixture("cases.json");
const rows = loadMapRows(cases.chain_id);
const rules = loadSchemaRules();

function refusal(receipt: unknown): string {
  try {
    checkReceiptAssets(receipt, rows, rules, cases.chain_id);
  } catch (e) {
    if (e instanceof ReceiptRefused) return e.reason;
    throw e;
  }
  return "ACCEPTED";
}

function cli(...args: string[]) {
  const p = Bun.spawnSync(["bun", SCRIPT, ...args], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

describe("valid 1.1 receipt", () => {
  const valid = fixture(cases.valid.file);

  test("passes and yields the per-asset vector by fund index", () => {
    const v = checkReceiptAssets(valid, rows, rules, cases.chain_id);
    expect(v.assets).toEqual([0, 1, 2, 3, 4, 5]);
    expect(v.bps).toEqual(cases.valid.asset_bps_by_fund_index);
    expect(v.bps.reduce((a, b) => a + b, 0)).toBe(10_000);
  });

  test("basket ids are token addresses, lending ids resolve only from a supplied adapter address", () => {
    const addr = "0x00000000000000000000000000000000000000aa";
    const v = checkReceiptAssets(valid, rows, rules, cases.chain_id, { aaveAdapter: addr });
    expect(v.asset_ids).toEqual([
      addr,
      null,
      null,
      "0x4200000000000000000000000000000000000006",
      "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      "0x9c5C365e764829876243d0b289733B9D2b729685",
    ]);
    expect(v.rows[1].adapter_role).toBe("cometAdapter");
  });

  test("CLI exits 0 and prints the vector", () => {
    const r = cli(join(FIXTURE_DIR, cases.valid.file));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).bps).toEqual(cases.valid.asset_bps_by_fund_index);
  });

  test("weights are the largest-remainder bps of the analysts' mean, and each signature verifies", () => {
    const subs = valid.analyst_signatures.map((s: any) => JSON.parse(s.canonical_submission));
    const mean = [0, 1, 2, 3].map((i) => subs.reduce((a: number, s: any) => a + s.weights[i].weight, 0) / subs.length);
    expect(mean.map((m) => Math.round(m * 10_000))).toEqual(valid.weights.map((w: any) => w.weight_bps));
    for (const s of valid.analyst_signatures) {
      const raw = Buffer.from(s.public_key, "base64");
      const key = createPublicKey({
        key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
        format: "der",
        type: "spki",
      });
      expect(verify(null, Buffer.from(s.canonical_submission, "utf8"), key, Buffer.from(s.signature, "base64"))).toBe(true);
      expect(JSON.parse(s.canonical_submission).memberId).toBe(s.member_id);
      expect(JSON.parse(s.canonical_submission).subjectId).toBe(valid.subject_id);
    }
  });

  test("the 1.0 stances histogram and quorum still hold", () => {
    const stances = valid.analyst_signatures.map((s: any) => JSON.parse(s.canonical_submission).stance);
    for (const k of Object.keys(valid.stances)) {
      expect(stances.filter((s: string) => s === k).length).toBe(valid.stances[k]);
    }
    expect(valid.quorum.submitted).toBe(valid.analyst_signatures.length);
  });
});

describe("refuse cases", () => {
  for (const c of cases.refuse) {
    test(`${c.file} -> ${c.reason}`, () => {
      expect(refusal(fixture(c.file))).toBe(c.reason);
      const r = cli(join(FIXTURE_DIR, c.file));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`REFUSE ${c.reason}:`);
    });
  }

  test("the six required refuse cases are all present", () => {
    const reasons = new Set(cases.refuse.map((c: any) => c.reason));
    for (const r of [
      "BUCKET_SUM_MISMATCH",
      "ASSET_SUM_INVALID",
      "UNKNOWN_ASSET",
      "DUPLICATE_ASSET",
      "UNKNOWN_BUCKET",
      "BUCKET_HAS_NO_ASSETS",
    ]) {
      expect(reasons.has(r)).toBe(true);
    }
  });

  const valid = () => structuredClone(fixture(cases.valid.file));
  test("malformed key -> ASSET_KEY_MALFORMED", () => {
    const r = valid();
    r.assets[3].asset = "WETH";
    expect(refusal(r)).toBe("ASSET_KEY_MALFORMED");
  });
  test("fractional or negative weight -> ASSET_WEIGHT_OUT_OF_RANGE", () => {
    const r = valid();
    r.assets[3].weight_bps = 1199.5;
    expect(refusal(r)).toBe("ASSET_WEIGHT_OUT_OF_RANGE");
    r.assets[3].weight_bps = -1;
    expect(refusal(r)).toBe("ASSET_WEIGHT_OUT_OF_RANGE");
  });
  test("extra or reordered entry field -> ASSET_ENTRY_INVALID", () => {
    const r = valid();
    r.assets[0] = { sleeve: r.assets[0].sleeve, asset: r.assets[0].asset, weight_bps: r.assets[0].weight_bps };
    expect(refusal(r)).toBe("ASSET_ENTRY_INVALID");
    const r2 = valid();
    r2.assets[0].note = "x";
    expect(refusal(r2)).toBe("ASSET_ENTRY_INVALID");
  });
  test("empty assets -> ASSETS_MISSING", () => {
    const r = valid();
    r.assets = [];
    expect(refusal(r)).toBe("ASSETS_MISSING");
  });
  test("weights not the canonical four -> WEIGHTS_INVALID", () => {
    const r = valid();
    r.weights = r.weights.slice(1);
    expect(refusal(r)).toBe("WEIGHTS_INVALID");
  });
  test("an explicit 0 for an asset is accepted (it sells the asset)", () => {
    const r = valid();
    r.assets[5].weight_bps = 0;
    r.assets[4].weight_bps = 2800;
    r.weights[2].weight_bps = 4000;
    r.weights[3].weight_bps = 0;
    expect(refusal(r)).toBe("ACCEPTED");
  });
  test("a relabel that keeps every bucket sum -> LABEL_MISMATCH", () => {
    const r = valid();
    r.assets[4].sleeve = "real_world_assets";
    r.assets[5].sleeve = "protocol_tokens";
    r.assets[4].weight_bps = 1500;
    r.assets[3].weight_bps = 1000;
    expect(refusal(r)).toBe("LABEL_MISMATCH");
  });
  test("two entries swapped -> ASSET_ORDER_INVALID", () => {
    const r = valid();
    [r.assets[0], r.assets[1]] = [r.assets[1], r.assets[0]];
    expect(refusal(r)).toBe("ASSET_ORDER_INVALID");
  });
  test("an unknown top-level key -> FIELD_ORDER_INVALID", () => {
    const r = valid();
    r.extra = 1;
    expect(refusal(r)).toBe("FIELD_ORDER_INVALID");
  });
  test("CLI exits 2 on a usage error", () => {
    expect(cli().code).toBe(2);
  });
});

describe("schema 1.1", () => {
  test("is the 1.0 schema plus only the optional trailing assets field", () => {
    const s10 = read(join(REPO, "tests/fixtures/consensus-receipt.schema.json"));
    const s11 = read(DEFAULT_SCHEMA);
    expect(s11.$id).toBe("https://robotmoney.net/schemas/consensus-receipt/1.1");
    expect(s11.properties.schema_version.const).toBe("1.1");
    expect(s11.required).toEqual(s10.required);
    expect(Object.keys(s11.properties)).toEqual([...Object.keys(s10.properties), "assets"]);
    expect(s11.dependencies).toEqual({ assets: ["weights"] });
    const stripped = structuredClone(s11);
    stripped.$id = s10.$id;
    stripped.properties.schema_version.const = "1.0";
    delete stripped.properties.assets;
    delete stripped.dependencies;
    delete stripped.definitions.asset_weight;
    expect(stripped).toEqual(s10);
  });

  test("asset labels use exactly the bucket enum", () => {
    const s11 = read(DEFAULT_SCHEMA);
    expect(s11.definitions.asset_weight.properties.sleeve.enum).toEqual(s11.definitions.bucket_weight.properties.bucket.enum);
  });
});

describe("sim asset vectors", () => {
  const file = read(SIM_VECTORS);

  test("the file equals its derivation from the sleeve design", () => {
    expect(deriveSimVectors(file)).toEqual(file);
  });

  test("anchored and extreme receipts, with the code's rounding", () => {
    const r = file.receipts;
    expect(r.R1p.asset_bps).toEqual([3650, 2737, 2738, 262, 263, 350]);
    expect(r.d05.asset_bps).toEqual([3800, 2850, 2850, 250, 250, 0]);
    expect(r.d07.asset_bps).toEqual([3200, 2400, 2400, 500, 500, 1000]);
    expect(r.d08.asset_bps).toEqual([2800, 2100, 2100, 750, 750, 1500]);
    expect(r.X.asset_bps).toEqual([0, 0, 0, 2500, 2500, 5000]);
    expect(r.G.asset_bps).toEqual([4000, 3000, 3000, 0, 0, 0]);
  });

  test("every vector sums to 10,000, keeps each sleeve's weight, and stays under the lending cap", () => {
    for (const r of Object.values<any>(file.receipts)) {
      expect(r.asset_bps.reduce((a: number, b: number) => a + b, 0)).toBe(10_000);
      for (let s = 0; s < 4; ++s) {
        const sum = file.sleeve_design.assets
          .filter((d: any) => d.sleeve === s)
          .reduce((a: number, d: any) => a + r.asset_bps[d.fund_index], 0);
        expect(sum).toBe(r.sleeve_bps[s]);
      }
      for (const d of file.sleeve_design.assets) {
        if (d.cap_bps !== null) expect(r.asset_bps[d.fund_index]).toBeLessThanOrEqual(d.cap_bps);
      }
    }
  });

  test("every scenario names only known receipts", () => {
    for (const s of Object.values<any>(file.scenarios)) {
      for (const l of [s.genesis, ...s.plans]) expect(file.receipts[l]).toBeDefined();
    }
  });

  test("each sim vector passes the receipt checker when labelled by its sleeve", () => {
    const valid = fixture(cases.valid.file);
    const buckets = file.sleeve_order;
    const keyOf = new Map(file.sleeve_design.assets.map((d: any) => [d.fund_index, d]));
    const order: string[] = fixture("asset-map.json").canonical_asset_order;
    const rank = (e: any) => order.indexOf(e.asset);
    for (const r of Object.values<any>(file.receipts)) {
      const rec = structuredClone(valid);
      rec.weights = buckets.map((b: string, i: number) => ({ bucket: b, weight_bps: r.sleeve_bps[i] }));
      rec.assets = r.asset_bps.map((bps: number, i: number) => {
        const d: any = keyOf.get(i);
        return { asset: d.asset, sleeve: buckets[d.sleeve], weight_bps: bps };
      });
      rec.assets.sort((x: any, y: any) => rank(x) - rank(y));
      const v = checkReceiptAssets(rec, rows, rules, cases.chain_id);
      expect(v.bps).toEqual(r.asset_bps);
    }
  });

  test("the derivation floors, gives the remainder to the last asset, and refuses a cap breach", () => {
    const d = [
      { asset: "a", fund_index: 0, sleeve: 1, intra_bps: 3333, cap_bps: 6000 },
      { asset: "b", fund_index: 1, sleeve: 1, intra_bps: 3333, cap_bps: 6000 },
      { asset: "c", fund_index: 2, sleeve: 1, intra_bps: 3334, cap_bps: 6000 },
    ];
    expect(sleeveDesignAssetBps([0, 10_000, 0, 0], d)).toEqual([3333, 3333, 3334]);
    expect(sleeveDesignAssetBps([0, 9_999, 0, 1], [...d, { asset: "z", fund_index: 3, sleeve: 3, intra_bps: 10_000, cap_bps: null }])).toEqual([
      3332, 3332, 3335, 1,
    ]);
    d[0].intra_bps = 6100;
    d[1].intra_bps = 3900;
    d[2].intra_bps = 0;
    expect(() => sleeveDesignAssetBps([0, 10_000, 0, 0], d)).toThrow("TargetExceedsCap");
  });

  test("CLI --sim-vectors confirms the file", () => {
    expect(cli("--sim-vectors").code).toBe(0);
  });
});
