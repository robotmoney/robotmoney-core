// Canonical: core issue 1490 (clean room rule, core 1498).
// The gate exits 0 on the tree and non-zero, naming file and line, on a planted production address
// in a Solidity test, a Rust harness file, a TypeScript test and a workflow, in any case and with
// or without the 0x prefix. A third-party address and a docs mention pass.
// QA plan v1 E10: the gate lists every Robot Money contract the committed Deploy 2 manifests
// (deployments/8453/deploy-2) record, and the recorder keeper fork test reads them from there.
// Run: bun test scripts/ci/check-no-production-addresses.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEPLOY_2, PRODUCTION_ADDRESSES, scanText } from "./check-no-production-addresses.ts";

const repo = resolve(import.meta.dir, "..", "..");
const gate = join(repo, "scripts/ci/check-no-production-addresses.ts");
const temps: string[] = [];

function plant(rel: string, body: string): { code: number; out: string } {
  const root = mkdtempSync(join(tmpdir(), "nopa-"));
  temps.push(root);
  // One clean file so the gate scans at least one file.
  mkdirSync(join(root, "testing"), { recursive: true });
  writeFileSync(join(root, "testing/clean.txt"), "nothing here\n");
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
  const p = Bun.spawnSync(["bun", gate, "--root", root], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString() + p.stderr.toString() };
}

afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const vault = PRODUCTION_ADDRESSES[0]!.address;
const safe = PRODUCTION_ADDRESSES[4]!.address;

describe("no production addresses gate", () => {
  test("the tree is clean and the gate scanned files", () => {
    const p = Bun.spawnSync(["bun", gate], { stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toMatch(/\d+ files checked, 0 matches/);
  });

  test("a planted vault address in a forge test fails and names file and line", () => {
    const r = plant("contracts/test/Planted.t.sol", `// x\naddress constant V = 0x${vault};\n`);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("contracts/test/Planted.t.sol:2");
  });

  test("a planted address in a Rust harness file fails", () => {
    const r = plant("testing/fork-e2e-rust/src/addresses.rs", `pub const VAULT: Address = address!("${vault}");\n`);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("testing/fork-e2e-rust/src/addresses.rs:1");
  });

  test("upper case and checksum form still fail", () => {
    const r = plant("clients/dapp/tests/unit/x.test.ts", `const a = "0x${safe.toUpperCase()}";\n`);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("old admin Safe");
  });

  test("a planted address in a workflow fails", () => {
    const r = plant(".github/workflows/planted.yml", `env:\n  VAULT: "0x${PRODUCTION_ADDRESSES[1]!.address}"\n`);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(".github/workflows/planted.yml:2");
  });

  test("a third-party address passes", () => {
    const r = plant("testing/x.rs", 'address!("833589fcd6edb6e08f4c7c32d4f71b54bda02913");\n');
    expect(r.code).toBe(0);
  });

  test("docs are not scanned", () => {
    const r = plant("docs/technical/smart-contracts.md", `vault 0x${vault}\n`);
    expect(r.code).toBe(0);
  });

  test("a tree with no scanned files fails", () => {
    const root = mkdtempSync(join(tmpdir(), "nopa-"));
    temps.push(root);
    const p = Bun.spawnSync(["bun", gate, "--root", root], { stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).not.toBe(0);
  });

  test("scanText reports every listed address on its line", () => {
    for (const a of PRODUCTION_ADDRESSES) {
      expect(scanText("f", `\n0x${a.address}`)).toEqual([{ file: "f", line: 2, name: a.name }]);
    }
  });
});

// ── Deploy 2 (QA plan v1 E10) ──────────────────────────────────────────────────────────────────

const DEPLOY_2_DIR = join(repo, "deployments/8453/deploy-2");

/**
 * Every address-valued key of each Deploy 2 manifest, sorted into the contracts Deploy 2 created
 * (the gate must list them) and the rest. An array index reads `[]` and `vault_handover.vault_<i>`
 * reads `vault_N`. A key in neither list fails the classification test, so a manifest key that
 * names a new contract cannot slip past the gate.
 */
const CONTRACT_KEYS: Record<string, string[]> = {
  "agent-token-vault.json": ["vault", "registry", "adapter_v4", "recorder", "assets[].pool"], // a V4 asset's pool is its recorder
  "gateway.json": ["gateway", "gateway_router", "vault"],
  "governance.json": ["governance", "router"],
  "ic-policy.json": ["policy", "consensus_receipt", "gateway"],
  "protocol-asset-vault.json": ["vault", "registry"],
  "recorder.json": ["recorder"],
  "registry.json": ["registry", "vault"],
  "router.json": ["router", "registry", "vault"],
  "rwa-basket-vault.json": ["vault", "registry", "adapter"],
  "safe.json": ["safe"],
  "timelock.json": [
    "addresses.consensus_receipt", "addresses.gateway", "addresses.governance", "addresses.ic_policy",
    "addresses.registry", "addresses.router", "addresses.safe", "addresses.timelock", "addresses.vault",
    "addresses.vaults[]", "gateway", "governance", "registry", "roles.admin_role_holder", "router", "safe",
    "timelock", "vault", "vaults[]", "vault_handover.vault_N.address", "vault_handover.vault_N.admin",
    "vault_handover.vault_N.registry",
  ],
  "vault.json": ["vault", "aave_adapter", "compound_adapter", "moonwell_flagship_adapter"],
};
/** Keys (EOAs), third-party contracts (tokens, pools, venues, the Safe factory and singleton) and the CREATE2 TickMath library. */
const OTHER_KEYS: Record<string, string[]> = {
  "agent-token-vault.json": ["assets[].token"],
  "gateway.json": ["admin", "pauser", "share_receiver", "usdc"],
  "governance.json": ["admin"],
  "ic-policy.json": ["admin", "receipt_admin"],
  "libs.json": ["tick_math"],
  "protocol-asset-vault.json": ["assets[].token", "assets[].pool"],
  "recorder.json": ["pool_manager"],
  "registry.json": ["admin", "asset"],
  "router.json": ["admin", "usdc"],
  "rwa-basket-vault.json": ["assets[].token", "assets[].pool"],
  "safe.json": ["owners[]", "factory", "singleton", "fallback_handler", "created_by"],
  "timelock.json": ["addresses.emergency", "emergency", "vault_handover.vault_N.emergency"],
  "vault.json": ["admin", "aave_v3_venue", "compound_v3_venue", "moonwell_flagship_venue", "seed_share_receiver", "usdc"],
};

/** Every non-zero address in one manifest, with its normalized key path. Lower case, no 0x. */
function addressesOf(file: string): { key: string; address: string }[] {
  const out: { key: string; address: string }[] = [];
  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, `${path}[]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
    else if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && BigInt(v) !== 0n) {
      out.push({ key: path.replace(/^vault_handover\.vault_\d+\./, "vault_handover.vault_N."), address: v.slice(2).toLowerCase() });
    }
  };
  walk(JSON.parse(readFileSync(join(DEPLOY_2_DIR, file), "utf8")), "");
  return out;
}

const manifestFiles = (): string[] => readdirSync(DEPLOY_2_DIR).filter((f) => f.endsWith(".json")).sort();
const deploy2Listed = (): Map<string, string> =>
  new Map(PRODUCTION_ADDRESSES.filter((p) => p.name.startsWith(DEPLOY_2)).map((p) => [p.address, p.name]));
const manifestValue = (file: string, key: string): string => {
  let v: unknown = JSON.parse(readFileSync(join(DEPLOY_2_DIR, file), "utf8"));
  for (const k of key.split(".")) v = (v as Record<string, unknown>)[k];
  return String(v).slice(2).toLowerCase();
};

describe("Deploy 2 addresses (QA plan v1 E10)", () => {
  test("every address in the Deploy 2 manifests is classified as a Robot Money contract or not", () => {
    const files = manifestFiles();
    expect(files.length).toBeGreaterThanOrEqual(13);
    const unclassified: string[] = [];
    for (const f of files) {
      if (!(f in CONTRACT_KEYS) && !(f in OTHER_KEYS)) unclassified.push(f);
      const known = new Set([...(CONTRACT_KEYS[f] ?? []), ...(OTHER_KEYS[f] ?? [])]);
      for (const a of addressesOf(f)) if (!known.has(a.key)) unclassified.push(`${f} ${a.key}`);
    }
    expect(unclassified).toEqual([]);
  });

  test("gate lists Deploy 2 addresses", () => {
    const recorded = new Map<string, string>();
    for (const f of manifestFiles()) {
      const keys = new Set(CONTRACT_KEYS[f] ?? []);
      for (const a of addressesOf(f)) if (keys.has(a.key)) recorded.set(a.address, `${f} ${a.key}`);
    }
    const listed = deploy2Listed();
    expect(new Set(PRODUCTION_ADDRESSES.map((p) => p.address)).size).toBe(PRODUCTION_ADDRESSES.length); // no address listed twice
    // The two contracts the recorder keeper fork test reads (agent-token-vault.json vault and recorder).
    expect(recorded.has(manifestValue("agent-token-vault.json", "vault"))).toBe(true);
    expect(recorded.has(manifestValue("agent-token-vault.json", "recorder"))).toBe(true);
    expect(recorded.size).toBeGreaterThan(0);
    expect([...listed.keys()].sort()).toEqual([...recorded.keys()].sort());
    // Each entry names the file and key its address is read from, and that key holds it.
    for (const [address, name] of listed) {
      const m = /\((\S+\.json) (\S+)\)$/.exec(name);
      expect(m).not.toBeNull();
      expect(manifestValue(m![1]!, m![2]!)).toBe(address);
    }
    // A manifest key outside the contract list never reaches the gate (keys, third-party contracts, TickMath).
    for (const f of manifestFiles()) {
      for (const a of addressesOf(f)) if ((OTHER_KEYS[f] ?? []).includes(a.key)) expect(listed.has(a.address)).toBe(false);
    }
  });

  test("a planted Deploy 2 rmAGENT vault or recorder fails and names Deploy 2", () => {
    const vault = manifestValue("agent-token-vault.json", "vault");
    const recorder = manifestValue("agent-token-vault.json", "recorder");
    const sol = plant("scripts/ops/integration/Planted.t.sol", `// x\nBasketVault v = BasketVault(0x${vault});\n`);
    expect(sol.code).not.toBe(0);
    expect(sol.out).toContain("scripts/ops/integration/Planted.t.sol:2");
    expect(sol.out).toContain(`${DEPLOY_2} rmAGENT vault`);
    const sh = plant("scripts/ops/planted-fork.sh", `#!/usr/bin/env bash\nexport RECORDER_ADDRESS=0x${recorder.toUpperCase()}\n`);
    expect(sh.code).not.toBe(0);
    expect(sh.out).toContain("scripts/ops/planted-fork.sh:2");
    expect(sh.out).toContain(`${DEPLOY_2} rmAGENT UniswapV4PriceRecorder`);
  });

  test("the recorder keeper fork test reads rmAGENT and its recorder from the Deploy 2 manifest", () => {
    for (const rel of ["scripts/ops/test-recorder-keeper-fork.sh", "scripts/ops/integration/RecorderKeeperDeposit.t.sol"]) {
      const text = readFileSync(join(repo, rel), "utf8");
      expect(scanText(rel, text)).toEqual([]);
      expect(text).toContain("deployments/8453/deploy-2");
      expect(text).toContain("agent-token-vault.json");
    }
  });
});
