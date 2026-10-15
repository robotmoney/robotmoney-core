// Offline test for the read-only Base mainnet dapp stack (core issue 1725): the env builder from the rehearsal
// manifests, every refusal, the loopback guard and `core-stack dapp up|down|status --chain 8453` against a fake
// `docker compose`. No network, no docker, no chain, no key. The manifests are a fixture built here from PUBLIC
// mainnet addresses; no path to a real manifests directory appears in the code or in this test.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runCli, type Deps, type RunOpts, type RunResult } from "../core-stack.ts";
import {
  MAINNET_DAPP_PROJECT,
  MAINNET_DEFAULT_PORTS,
  MAINNET_OVERLAY_REL,
  MAINNET_DAPP_COMPOSE_REL,
  MainnetDappError,
  assertComposeReadOnly,
  assertEnvReadOnly,
  assertOverlayInFileList,
  mainnetComposeFiles,
  assertMergedConfigLoopback,
  assertNoSigningEnv,
  buildMainnetDappEnv,
  composePortEntries,
  mainnetComposeTexts,
  readMainnetManifests,
  redactRpc,
} from "../mainnet-dapp.ts";
import { manifestOf, vaultManifests } from "../stage-manifests.ts";

const CORE_ROOT = join(import.meta.dir, "../../..");
const WORK = mkdtempSync(join(tmpdir(), "mainnet-dapp-test-"));
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

// Public addresses of the rehearsal (the Safe and the four vaults) and stand-ins for the rest.
const SAFE = "0x5E68a40648DD23065b21b1C414e1178ddE6482ca";
const VAULTS = {
  rmUSDC: "0xde5CCE7CcFc4ce1997bd93eC7bBd7085ce55f574",
  rmPROTO: "0xe5b18d5F0f848802d1a5aD302284334dBdc8AE93",
  rmAGENT: "0x323dC47ea32A3203f0418dDA0Ae6A8BACD885C7a",
  rmRWA: "0xDA0aebEf18ed702f4584e4E81bD59E29b01fd85f",
};
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const GATEWAY = A(0x1001);
const REGISTRY = A(0x1002);
const ROUTER = A(0x1003);
const GOVERNANCE = A(0x1004);
const RECEIPT = A(0x1005);
const IC_POLICY = A(0x1007);
const TIMELOCK = A(0x1006);
const HASH = `0x${"ab".repeat(32)}`;
// QA plan U5: the router's and each vault's runtime code hash, as DeployTimelock records them.
const ROUTER_HASH = `0x${"cd".repeat(32)}`;
const VAULT_HASHES: Record<string, string> = {
  rmUSDC: `0x${"01".repeat(32)}`,
  rmPROTO: `0x${"02".repeat(32)}`,
  rmAGENT: `0x${"03".repeat(32)}`,
  rmRWA: `0x${"04".repeat(32)}`,
};

type Json = Record<string, unknown>;
/** The manifests a rehearsal leaves, reduced to the fields the dapp stack reads. `tweak` edits them before they are written. */
function fixture(name: string, tweak?: (docs: Record<string, Json>) => void): string {
  const dir = join(WORK, name);
  mkdirSync(dir, { recursive: true });
  const vf = vaultManifests();
  const docs: Record<string, Json> = {
    [manifestOf("gateway")]: { chain_id: 8453, gateway: GATEWAY, gateway_router: ROUTER, vault: VAULTS.rmUSDC, gateway_runtime_hash: HASH },
    [manifestOf("registry")]: { chain_id: 8453, registry: REGISTRY },
    [manifestOf("router")]: { chain_id: 8453, router: ROUTER },
    [manifestOf("governance")]: { chain_id: 8453, governance: GOVERNANCE },
    [manifestOf("timelock")]: {
      chain_id: 8453,
      addresses: { gateway: GATEWAY, registry: REGISTRY, router: ROUTER, governance: GOVERNANCE, consensus_receipt: RECEIPT, ic_policy: IC_POLICY, timelock: TIMELOCK, safe: SAFE, vaults: Object.values(VAULTS) },
      code_hashes: { gateway: HASH, router: ROUTER_HASH },
      vault_handover: Object.fromEntries(
        Object.entries(VAULTS).map(([key, address], i) => [`vault_${i}`, { address, code_hash: VAULT_HASHES[key] }]),
      ),
    },
  };
  for (const [key, addr] of Object.entries(VAULTS)) docs[vf[key]!] = { chain_id: 8453, vault: addr };
  tweak?.(docs);
  for (const [file, doc] of Object.entries(docs)) writeFileSync(join(dir, file), JSON.stringify(doc));
  return dir;
}

const RPC = "https://rpc.example/v2/SECRET-API-KEY";
const input = (dir: string, extra: Record<string, unknown> = {}) => ({ rpc: RPC, manifestsDir: dir, startBlock: 52_401_633, ...extra });
const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MainnetDappError);
    return (e as MainnetDappError).cls;
  }
  throw new Error("expected a refusal, none thrown");
};

describe("the env builder from the manifests", () => {
  const dir = fixture("good");
  const env = buildMainnetDappEnv(input(dir));

  test("reads the four vaults in order, the gateway hash, and every contract address", () => {
    expect(readMainnetManifests(dir).vaults).toEqual(VAULTS);
    expect(env.VITE_VAULT_ADDRESS).toBe(VAULTS.rmUSDC);
    expect(JSON.parse(env.VITE_VAULT_ADDRESSES!)).toEqual(VAULTS);
    expect(env.VITE_SAFE_ADDRESS).toBe(SAFE);
    expect(env.VITE_GATEWAY_EXPECTED_CODE_HASH).toBe(HASH);
    expect(env.VITE_GATEWAY_ADDRESS).toBe(GATEWAY);
    expect(env.INDEXER_GATEWAY).toBe(GATEWAY);
    expect(env.INDEXER_VAULT).toBe(VAULTS.rmUSDC);
    expect(env.INDEXER_REGISTRY).toBe(REGISTRY);
    expect(env.INDEXER_PORTFOLIO_ROUTER).toBe(ROUTER);
    expect(env.INDEXER_ROUTER_GOVERNANCE).toBe(GOVERNANCE);
    expect(env.INDEXER_CONSENSUS_RECEIPT).toBe(RECEIPT);
    // Security round 1: the IC policy proxy is watched (its Upgraded / UpgradesFrozen events page the watchdog)
    expect(env.INDEXER_INVESTMENT_COMMITTEE).toBe(IC_POLICY);
    expect(readMainnetManifests(dir).icPolicy).toBe(IC_POLICY);
    // Issue 1731: the Safe and the timelock are in the indexer's watched set.
    expect(env.INDEXER_SAFE).toBe(SAFE);
    expect(env.INDEXER_TIMELOCK).toBe(TIMELOCK);
    expect(env.VITE_TIMELOCK_ADDRESS).toBe(TIMELOCK);
    // A direct (legacy) gateway's manifest has no implementation: the pins are empty.
    expect(env.VITE_GATEWAY_EXPECTED_IMPLEMENTATION).toBe("");
    expect(env.VITE_GATEWAY_EXPECTED_IMPLEMENTATION_HASH).toBe("");
  });

  test("passes a proxied gateway's implementation pin through, and refuses a half or zero pin (issue 1810)", () => {
    const IMPL = A(0x10a);
    const IMPL_HASH = `0x${"cd".repeat(32)}`;
    const proxied = fixture("proxied", (d) => {
      Object.assign(d[manifestOf("gateway")]!, { gateway_implementation: IMPL, gateway_implementation_runtime_hash: IMPL_HASH });
    });
    const penv = buildMainnetDappEnv(input(proxied));
    expect(penv.VITE_GATEWAY_EXPECTED_IMPLEMENTATION).toBe(IMPL);
    expect(penv.VITE_GATEWAY_EXPECTED_IMPLEMENTATION_HASH).toBe(IMPL_HASH);
    const half = fixture("impl-half", (d) => void (d[manifestOf("gateway")]!.gateway_implementation = IMPL));
    expect(refusal(() => buildMainnetDappEnv(input(half)))).toBe("manifest-field");
    const zero = fixture("impl-zero", (d) => {
      Object.assign(d[manifestOf("gateway")]!, { gateway_implementation: IMPL, gateway_implementation_runtime_hash: `0x${"0".repeat(64)}` });
    });
    expect(refusal(() => buildMainnetDappEnv(input(zero)))).toBe("manifest-field");
  });

  // Issue 1737 item 1 (QA plan U5): the builder hands the dapp a code-hash pin for every vault and the router,
  // equal to the runtime code hash the manifests recorded from the chain.
  test("emits the vault and router code-hash pins from the timelock manifest", () => {
    expect(env.VITE_ROUTER_EXPECTED_CODE_HASH).toBe(ROUTER_HASH);
    const pins = JSON.parse(env.VITE_VAULT_EXPECTED_CODE_HASH!) as Record<string, string>;
    expect(Object.keys(pins).sort()).toEqual(Object.values(VAULTS).sort());
    for (const [key, address] of Object.entries(VAULTS)) expect(pins[address]).toBe(VAULT_HASHES[key]);
    expect(readMainnetManifests(dir).vaultCodeHashes).toEqual(VAULT_HASHES);
    expect(readMainnetManifests(dir).routerCodeHash).toBe(ROUTER_HASH);
  });

  // ADR-0014: the stage manifests name no implementation here (direct contracts, like Deploy 2), so the
  // build carries no implementation pin: one for a direct contract would refuse every write to it.
  test("emits no implementation pins for direct vaults and a direct router", () => {
    expect(env.VITE_VAULT_EXPECTED_IMPLEMENTATION_HASH).toBe("{}");
    expect(env.VITE_ROUTER_EXPECTED_IMPLEMENTATION_HASH).toBe("");
  });

  test("is chain 8453, mainnet class, with an EMPTY faucet key and no devnet RPC", () => {
    expect(env.INDEXER_CHAIN_ID).toBe("8453");
    expect(env.EXPLORER_API_CHAIN_ID).toBe("8453");
    expect(env.INDEXER_CHAIN_NAME).toBe("base");
    expect(env.VITE_ENV_CLASS).toBe("mainnet");
    expect(env.VITE_CHAIN_ID).toBe("8453");
    expect(env.VITE_FAUCET_HARNESS_PRIVATE_KEY).toBe("");
    expect(env.VITE_DEVNET_RPC_URL).toBe("");
    expect(env.COMPOSE_PROFILES).toBe("");
    // The only bytes32 values are the public code-hash pins: nothing key-shaped rides along.
    const pins = new Set([HASH, ROUTER_HASH]);
    expect(Object.values(env).some((v) => /^0x[0-9a-f]{64}$/i.test(v) && !pins.has(v))).toBe(false);
  });

  test("carries the RPC, the start block, the range and loopback URLs on ports that are not the stage ports", () => {
    expect(env.INDEXER_RPC_URL).toBe(RPC);
    expect(env.INDEXER_LOGS_RPC_URL).toBe("");
    expect(env.INDEXER_START_BLOCK).toBe("52401633");
    expect(env.INDEXER_MAX_BLOCKS_PER_TICK).toBe("1000");
    expect(env.DAPP_PORT).toBe(String(MAINNET_DEFAULT_PORTS.dapp));
    expect([env.DAPP_PORT, env.EXPLORER_API_PORT]).not.toContain("5173");
    expect([env.DAPP_PORT, env.EXPLORER_API_PORT]).not.toContain("18546");
    expect(env.VITE_EXPLORER_API_URL).toBe(`http://127.0.0.1:${MAINNET_DEFAULT_PORTS.explorer}`);
    const custom = buildMainnetDappEnv(input(dir, { logsRpc: "https://logs.example/k", maxBlockRange: 500, dappPort: 16000, explorerPort: 16001 }));
    expect(custom.INDEXER_LOGS_RPC_URL).toBe("https://logs.example/k");
    expect(custom.INDEXER_MAX_BLOCKS_PER_TICK).toBe("500");
    expect([custom.DAPP_PORT, custom.EXPLORER_API_PORT]).toEqual(["16000", "16001"]);
  });

  test("public URLs only change what the browser bundle and the CORS origin are told, never a port or a bind", () => {
    const pub = buildMainnetDappEnv(input(dir, { publicDappUrl: "https://dapp.example/", publicExplorerUrl: "https://explorer.example" }));
    expect(pub.VITE_DAPP_URL).toBe("https://dapp.example");
    expect(pub.VITE_EXPLORER_API_URL).toBe("https://explorer.example");
    expect([pub.DAPP_PORT, pub.EXPLORER_API_PORT]).toEqual([env.DAPP_PORT, env.EXPLORER_API_PORT]);
    expect(refusal(() => buildMainnetDappEnv(input(dir, { publicDappUrl: "javascript:1" })))).toBe("rpc-invalid");
  });

  test("never logs an RPC URL with its key", () => {
    expect(redactRpc(RPC)).toBe("https://rpc.example");
    expect(redactRpc("not a url")).toBe("(invalid url)");
  });

  test("no hard-coded path to the rehearsal directory, keys or a keystore in the code or the overlay", () => {
    for (const rel of ["scripts/stage/mainnet-dapp.ts", "scripts/stage/core-stack.ts", MAINNET_OVERLAY_REL]) {
      const text = readFileSync(join(CORE_ROOT, rel), "utf8");
      expect(text).not.toMatch(/rm-base-mainnet-test|robotmoney-keys|robotmoney-evidence/);
    }
  });
});

describe("refusals on the manifests and the options", () => {
  test("a manifest from another chain, each one", () => {
    const names = [manifestOf("gateway"), manifestOf("registry"), manifestOf("router"), manifestOf("governance"), manifestOf("timelock"), ...Object.values(vaultManifests())];
    expect(names.length).toBe(9);
    for (const [i, file] of names.entries()) {
      const dir = fixture(`wrong-chain-${i}`, (d) => void (d[file]!.chain_id = 918453));
      expect(refusal(() => buildMainnetDappEnv(input(dir)))).toBe("wrong-chain");
    }
  });
  test("a missing manifest, an unparseable one and one that is not an object", () => {
    const dir = fixture("missing");
    rmSync(join(dir, manifestOf("router")));
    expect(refusal(() => buildMainnetDappEnv(input(dir)))).toBe("manifest-unreadable");
    writeFileSync(join(dir, manifestOf("router")), "not json");
    expect(refusal(() => buildMainnetDappEnv(input(dir)))).toBe("manifest-unreadable");
    writeFileSync(join(dir, manifestOf("router")), "[]");
    expect(refusal(() => buildMainnetDappEnv(input(dir)))).toBe("manifest-unreadable");
  });
  test("security round 1: a timelock manifest with no IC policy address, or a zero one, is refused (the indexer would never watch that proxy)", () => {
    const tl = (d: Record<string, Json>) => (d[manifestOf("timelock")]!.addresses as Json);
    expect(refusal(() => buildMainnetDappEnv(input(fixture("ic-none", (d) => void delete tl(d).ic_policy))))).toBe("manifest-field");
    expect(refusal(() => buildMainnetDappEnv(input(fixture("ic-zero", (d) => void (tl(d).ic_policy = A(0))))))).toBe("manifest-field");
  });
  test("a zero or malformed address, a bad gateway hash", () => {
    expect(refusal(() => buildMainnetDappEnv(input(fixture("zero", (d) => void (d[manifestOf("registry")]!.registry = A(0))))))).toBe("manifest-field");
    expect(refusal(() => buildMainnetDappEnv(input(fixture("short", (d) => void (d[manifestOf("router")]!.router = "0x1234")))))).toBe("manifest-field");
    expect(refusal(() => buildMainnetDappEnv(input(fixture("hash", (d) => void (d[manifestOf("gateway")]!.gateway_runtime_hash = "0x12")))))).toBe("manifest-field");
    expect(refusal(() => buildMainnetDappEnv(input(fixture("hash0", (d) => void (d[manifestOf("gateway")]!.gateway_runtime_hash = `0x${"0".repeat(64)}`)))))).toBe("manifest-field");
  });
  // Issue 1737 item 1 (QA plan U5): a manifest vault or router with no runtime code hash fails the build.
  test("a vault or the router with no recorded code hash, or a handover entry for another vault", () => {
    const tl = (d: Record<string, Json>) => d[manifestOf("timelock")]!;
    const handover = (d: Record<string, Json>) => tl(d).vault_handover as Record<string, Json>;
    for (const i of [0, 1, 2, 3]) {
      expect(refusal(() => buildMainnetDappEnv(input(fixture(`vh-missing-${i}`, (d) => void delete handover(d)[`vault_${i}`]!.code_hash))))).toBe("manifest-field");
      expect(refusal(() => buildMainnetDappEnv(input(fixture(`vh-zero-${i}`, (d) => void (handover(d)[`vault_${i}`]!.code_hash = `0x${"0".repeat(64)}`)))))).toBe("manifest-field");
    }
    expect(refusal(() => buildMainnetDappEnv(input(fixture("vh-none", (d) => void delete tl(d).vault_handover))))).toBe("manifest-field");
    expect(refusal(() => buildMainnetDappEnv(input(fixture("vh-swap", (d) => void (handover(d).vault_1!.address = VAULTS.rmUSDC)))))).toBe("manifest-mismatch");
    expect(refusal(() => buildMainnetDappEnv(input(fixture("rh-none", (d) => void delete (tl(d).code_hashes as Json).router))))).toBe("manifest-field");
    expect(refusal(() => buildMainnetDappEnv(input(fixture("rh-short", (d) => void ((tl(d).code_hashes as Json).router = "0x12")))))).toBe("manifest-field");
  });
  // ADR-0014 (security round 1): behind a proxy the code-hash pins are the generic ERC1967Proxy, so the build
  // must carry the reviewed implementation of every proxied vault and the router, or refuse to start.
  test("emits the implementation pins of proxied vaults and the router, and refuses a proxy without one", () => {
    const IMPL = A(0x2001);
    const ROUTER_IMPL_HASH = `0x${"e1".repeat(32)}`;
    const VAULT_IMPL_HASH = `0x${"e2".repeat(32)}`;
    const tl = (d: Record<string, Json>) => d[manifestOf("timelock")]!;
    const handover = (d: Record<string, Json>) => tl(d).vault_handover as Record<string, Json>;
    const proxied = (d: Record<string, Json>) => {
      d[manifestOf("router")]!.router_implementation = IMPL;
      d[vaultManifests().rmPROTO!]!.vault_implementation = IMPL;
      (tl(d).code_hashes as Json).router_implementation = ROUTER_IMPL_HASH;
      handover(d).vault_1!.implementation_code_hash = VAULT_IMPL_HASH;
    };
    const env = buildMainnetDappEnv(input(fixture("impl-good", proxied)));
    expect(env.VITE_ROUTER_EXPECTED_IMPLEMENTATION_HASH).toBe(ROUTER_IMPL_HASH);
    expect(JSON.parse(env.VITE_VAULT_EXPECTED_IMPLEMENTATION_HASH!)).toEqual({ [VAULTS.rmPROTO]: VAULT_IMPL_HASH });
    // A proxy whose implementation hash was not recorded: the dapp would refuse every deposit into it.
    expect(
      refusal(() => buildMainnetDappEnv(input(fixture("impl-router-none", (d) => {
        proxied(d);
        delete (tl(d).code_hashes as Json).router_implementation;
      })))),
    ).toBe("manifest-field");
    expect(
      refusal(() => buildMainnetDappEnv(input(fixture("impl-vault-zero", (d) => {
        proxied(d);
        handover(d).vault_1!.implementation_code_hash = `0x${"0".repeat(64)}`;
      })))),
    ).toBe("manifest-field");
    // A recorded implementation for a contract its stage manifest says is direct.
    expect(
      refusal(() => buildMainnetDappEnv(input(fixture("impl-direct", (d) => {
        handover(d).vault_2!.implementation_code_hash = VAULT_IMPL_HASH;
      })))),
    ).toBe("manifest-mismatch");
    // A basket vault deploy names its implementation `implementation` (BasketVaultDeployBase), DeployVault `vault_implementation`.
    const basket = buildMainnetDappEnv(input(fixture("impl-basket", (d) => {
      proxied(d);
      d[vaultManifests().rmAGENT!]!.implementation = IMPL;
      handover(d).vault_2!.implementation_code_hash = VAULT_IMPL_HASH;
    })));
    expect(JSON.parse(basket.VITE_VAULT_EXPECTED_IMPLEMENTATION_HASH!)).toEqual({ [VAULTS.rmPROTO]: VAULT_IMPL_HASH, [VAULTS.rmAGENT]: VAULT_IMPL_HASH });
  });

  // Issue 1796 with QA plan U5: a vault the migration overlay (current-vaults.json) moved to a later generation is pinned by
  // the overlay's verified runtime hash, never by the deploy-time hash of the retired vault, and carries no implementation pin
  // (the overlay records none), so the dapp refuses deposits into it while its exits stay open.
  test("a vault the migration overlay moved is pinned by the overlay's runtime hash and has no implementation pin", () => {
    const NEW_PROTO = A(0x4001);
    const NEW_PROTO_HASH = `0x${"f2".repeat(32)}`;
    const tl = (d: Record<string, Json>) => d[manifestOf("timelock")]!;
    const generation = {
      vault: "rmPROTO", old_address: VAULTS.rmPROTO, current_address: NEW_PROTO, old_runtime_hash: VAULT_HASHES.rmPROTO,
      current_runtime_hash: NEW_PROTO_HASH, operation_id: `0x${"21".repeat(32)}`, execution_tx: `0x${"22".repeat(32)}`,
    };
    const moved = (gen: Json) => (d: Record<string, Json>) => {
      d[vaultManifests().rmPROTO!]!.vault_implementation = A(0x2001);
      (tl(d).vault_handover as Record<string, Json>).vault_1!.implementation_code_hash = `0x${"e2".repeat(32)}`;
      d["current-vaults.json"] = { schema: "robotmoney-vault-generations-v1", chain_id: 8453, verified_block: "1", generations: [gen] };
    };
    const env = buildMainnetDappEnv(input(fixture("overlay-moved", moved(generation))));
    expect(JSON.parse(env.VITE_VAULT_ADDRESSES!).rmPROTO).toBe(NEW_PROTO);
    const pins = JSON.parse(env.VITE_VAULT_EXPECTED_CODE_HASH!) as Record<string, string>;
    expect(pins[NEW_PROTO]).toBe(NEW_PROTO_HASH);
    expect(pins[VAULTS.rmPROTO]).toBeUndefined();
    expect(JSON.parse(env.VITE_VAULT_EXPECTED_IMPLEMENTATION_HASH!)).toEqual({});
    // mutation: an overlay generation without a usable runtime hash refuses the build
    expect(refusal(() => buildMainnetDappEnv(input(fixture("overlay-zero", moved({ ...generation, current_runtime_hash: `0x${"0".repeat(64)}` })))))).toBe("manifest-field");
  });

  test("manifests that disagree: router, vault order, rmUSDC, timelock addresses", () => {
    expect(refusal(() => buildMainnetDappEnv(input(fixture("rt", (d) => void (d[manifestOf("gateway")]!.gateway_router = A(0x9999))))))).toBe("manifest-mismatch");
    expect(
      refusal(() =>
        buildMainnetDappEnv(
          input(
            fixture("order", (d) => {
              (d[manifestOf("timelock")]!.addresses as Json).vaults = [VAULTS.rmPROTO, VAULTS.rmUSDC, VAULTS.rmAGENT, VAULTS.rmRWA];
            }),
          ),
        ),
      ),
    ).toBe("manifest-mismatch");
    expect(refusal(() => buildMainnetDappEnv(input(fixture("usdc", (d) => void (d[manifestOf("gateway")]!.vault = VAULTS.rmPROTO)))))).toBe("manifest-mismatch");
    expect(
      refusal(() =>
        buildMainnetDappEnv(
          input(
            fixture("tl", (d) => {
              (d[manifestOf("timelock")]!.addresses as Json).registry = A(0x7777);
            }),
          ),
        ),
      ),
    ).toBe("manifest-mismatch");
    expect(
      refusal(() =>
        buildMainnetDappEnv(
          input(
            fixture("three", (d) => {
              (d[manifestOf("timelock")]!.addresses as Json).vaults = Object.values(VAULTS).slice(0, 3);
            }),
          ),
        ),
      ),
    ).toBe("manifest-field");
  });
  test("a bad RPC URL, start block, range and ports", () => {
    const dir = fixture("opts");
    expect(refusal(() => buildMainnetDappEnv(input(dir, { rpc: "ws://x" })))).toBe("rpc-invalid");
    expect(refusal(() => buildMainnetDappEnv(input(dir, { rpc: "nope" })))).toBe("rpc-invalid");
    expect(refusal(() => buildMainnetDappEnv(input(dir, { logsRpc: "ftp://x" })))).toBe("rpc-invalid");
    expect(refusal(() => buildMainnetDappEnv(input(dir, { startBlock: 0 })))).toBe("start-block-invalid");
    expect(refusal(() => buildMainnetDappEnv(input(dir, { startBlock: 1.5 })))).toBe("start-block-invalid");
    expect(refusal(() => buildMainnetDappEnv(input(dir, { maxBlockRange: 0 })))).toBe("block-range-invalid");
    expect(refusal(() => buildMainnetDappEnv(input(dir, { dappPort: 80 })))).toBe("port-invalid");
    expect(refusal(() => buildMainnetDappEnv(input(dir, { dappPort: 16000, explorerPort: 16000 })))).toBe("port-invalid");
  });
});

describe("refusals on signing keys and deploy settings", () => {
  // Issue 1737 item 6 (QA plan U5): PRIVATEKEY, PK, ETH_KEY, WALLET_KEY, SECRET, SEED and STAGE_SHEET_PATH used to pass.
  // Each name is listed on its own, so dropping one from the matcher fails this test.
  const BAD = [
    "VITE_FAUCET_HARNESS_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "PRIVATE_KEY", "ETH_KEYSTORE", "MNEMONIC", "KEYSTORE_PASSPHRASE", "SAFE_SIGNER_KEY", "DEPLOYER", "FAUCET_KEY", "STAGE_SHEET", "PUBLISH_MANIFEST_DIR", "deployer_key",
    "PRIVATEKEY", "OWNER_PRIVATEKEY", "PK", "OWNER_PK", "PK_HEX", "ETH_KEY", "WALLET_KEY", "SECRET", "API_SECRET", "SEED", "WALLET_SEED", "STAGE_SHEET_PATH",
  ];
  test("each name is refused when it has a value, and the message names the variable but not the value", () => {
    for (const name of BAD) {
      let msg = "";
      try {
        assertNoSigningEnv({ [name]: "s3cret-value" });
      } catch (e) {
        msg = (e as MainnetDappError).message;
        expect((e as MainnetDappError).cls).toBe("signing-env-present");
      }
      expect(msg).toContain(name);
      expect(msg).not.toContain("s3cret-value");
    }
  });
  test("an empty or unset variable, and ordinary variables, are fine", () => {
    assertNoSigningEnv({ VITE_FAUCET_HARNESS_PRIVATE_KEY: "", DEPLOYER_PRIVATE_KEY: "  ", PATH: "/usr/bin", HOME: "/home/x", POSTGRES_PASSWORD: "x", INDEXER_RPC_URL: RPC, UNSET: undefined });
    // `PK` matches as a whole word only, and the code-hash pins are not secrets.
    assertNoSigningEnv({ PKG_CONFIG_PATH: "/usr/lib/pkgconfig", APK_HOME: "/x", VITE_VAULT_EXPECTED_CODE_HASH: "{}", VITE_ROUTER_EXPECTED_CODE_HASH: HASH });
  });
  test("a built env with a faucet key, another env class or another chain is refused", () => {
    const env = buildMainnetDappEnv(input(fixture("envcheck")));
    assertEnvReadOnly(env);
    expect(refusal(() => assertEnvReadOnly({ ...env, VITE_FAUCET_HARNESS_PRIVATE_KEY: "0xabc" }))).toBe("signing-env-present");
    expect(refusal(() => assertEnvReadOnly({ ...env, VITE_ENV_CLASS: "fork" }))).toBe("env-class");
    expect(refusal(() => assertEnvReadOnly({ ...env, INDEXER_CHAIN_ID: "918453" }))).toBe("wrong-chain");
    expect(refusal(() => assertEnvReadOnly({ ...env, VITE_CHAIN_ID: "1" }))).toBe("wrong-chain");
    expect(refusal(() => assertEnvReadOnly({ ...env, EXPLORER_API_CHAIN_ID: "1" }))).toBe("wrong-chain");
  });
});

/** The text without full-line comments (`#` or `//`): prose may name what the code must not do. */
const noComments = (t: string): string =>
  t
    .split("\n")
    .filter((l) => !/^\s*(#|\/\/)/.test(l))
    .join("\n");

describe("the loopback guard on the compose files", () => {
  const real = mainnetComposeTexts(CORE_ROOT);
  const base = real.find((f) => f.name === MAINNET_DAPP_COMPOSE_REL)!;
  const overlay = real.find((f) => f.name === MAINNET_OVERLAY_REL)!;

  test("the committed files pass, and every published port of the stack is on 127.0.0.1", () => {
    assertComposeReadOnly(real);
    const ports = real.flatMap((f) => composePortEntries(f.text));
    expect(ports.length).toBeGreaterThanOrEqual(4);
    for (const p of ports) expect(p.startsWith("127.0.0.1:")).toBe(true);
  });
  // Security round 1: an env value the container never receives watches nothing. Every setting the indexer reads from its environment (services/explorer-indexer
  // src/main.rs `env = "INDEXER_..."`) must reach the explorer-indexer container from the dapp compose file or the mainnet overlay. The two left out are tuning and
  // backfill knobs with safe defaults, never a contract the indexer must watch.
  test("security round 1: every INDEXER_* setting of the indexer reaches its container (INDEXER_INVESTMENT_COMMITTEE among them)", () => {
    const UNMAPPED_ON_PURPOSE = new Set(["INDEXER_TICK_SECONDS", "INDEXER_END_BLOCK"]);
    const mainRs = readFileSync(join(CORE_ROOT, "services", "explorer-indexer", "src", "main.rs"), "utf8");
    const names = [...new Set([...mainRs.matchAll(/env\s*=\s*"(INDEXER_[A-Z0-9_]+)"/g)].map((m) => m[1]!))];
    expect(names).toContain("INDEXER_INVESTMENT_COMMITTEE");
    const blockOf = (text: string) => noComments(text).split(/\n  explorer-indexer:/)[1]?.split(/\n  [a-z][a-z0-9-]*:\s*\n/)[0] ?? "";
    const mapped = blockOf(base.text) + blockOf(overlay.text);
    for (const n of names) if (!UNMAPPED_ON_PURPOSE.has(n)) expect([n, new RegExp(`\\b${n}:`).test(mapped)]).toEqual([n, true]);
    expect(blockOf(base.text)).toContain("INDEXER_INVESTMENT_COMMITTEE: ${INDEXER_INVESTMENT_COMMITTEE:-}");
  });
  test("issue 1731: the compose file hands INDEXER_TIMELOCK and INDEXER_SAFE to the indexer container", () => {
    // An env value the container never receives watches nothing. The indexer service block must pass both.
    const block = noComments(base.text).split(/\n  explorer-api:/)[0]!.split(/\n  explorer-indexer:/)[1]!;
    expect(block).toContain("INDEXER_TIMELOCK: ${INDEXER_TIMELOCK:-}");
    expect(block).toContain("INDEXER_SAFE: ${INDEXER_SAFE:-}");
  });
  test("mutation: a port on all interfaces, a bare port and 0.0.0.0 are each refused", () => {
    for (const bad of ['"5173:5173"', '"0.0.0.0:5173:5173"', "5173:5173", '"${DAPP_PORT:-5173}:5173"']) {
      const mutated = base.text.replace('"127.0.0.1:${DAPP_PORT:-5173}:5173"', bad);
      expect(mutated).not.toBe(base.text);
      expect(refusal(() => assertComposeReadOnly([{ name: base.name, text: mutated }, overlay]))).toBe("port-not-loopback");
    }
  });
  test("mutation: a port added by the overlay, the host network, the deploy job and the deploy profile are refused", () => {
    expect(refusal(() => assertComposeReadOnly([base, { name: "o", text: `${overlay.text}\n  extra:\n    ports:\n      - "8080:8080"\n` }]))).toBe("port-not-loopback");
    expect(refusal(() => assertComposeReadOnly([base, { name: "o", text: "services:\n  dapp:\n    network_mode: host\n" }]))).toBe("host-network");
    expect(refusal(() => assertComposeReadOnly([base, { name: "o", text: "services:\n  stage-harness:\n    image: x\n" }]))).toBe("deploy-job-present");
    expect(refusal(() => assertComposeReadOnly([base, { name: "o", text: "services:\n  job:\n    command: [\"--deploy-only\"]\n" }]))).toBe("deploy-job-present");
    expect(refusal(() => assertComposeReadOnly([base, { name: "o", text: 'services:\n  job:\n    profiles: ["deploy"]\n' }]))).toBe("deploy-job-present");
    expect(refusal(() => assertComposeReadOnly([]))).toBe("compose-missing");
  });
  test("a port entry under a commented line or with a trailing comment is read correctly", () => {
    expect(composePortEntries('ports:\n  # note\n  - "127.0.0.1:1:1" # x\nother: 1\n')).toEqual(["127.0.0.1:1:1"]);
    expect(composePortEntries("ports: !reset []\nnext: 1\n")).toEqual([]);
  });
  test("the merged config check refuses a non-loopback host_ip, a missing one, the host network and the deploy job", () => {
    const ok = JSON.stringify({ services: { dapp: { ports: [{ host_ip: "127.0.0.1", published: "15173" }] }, postgres: {} } });
    assertMergedConfigLoopback(ok);
    const mut = (svc: unknown) => JSON.stringify({ services: svc });
    expect(refusal(() => assertMergedConfigLoopback(mut({ dapp: { ports: [{ host_ip: "0.0.0.0", published: "1" }] } })))).toBe("port-not-loopback");
    expect(refusal(() => assertMergedConfigLoopback(mut({ dapp: { ports: [{ published: "1" }] } })))).toBe("port-not-loopback");
    expect(refusal(() => assertMergedConfigLoopback(mut({ dapp: { network_mode: "host" } })))).toBe("host-network");
    expect(refusal(() => assertMergedConfigLoopback(mut({ "stage-harness": {} })))).toBe("deploy-job-present");
    expect(refusal(() => assertMergedConfigLoopback("{}"))).toBe("compose-config-unreadable");
    expect(refusal(() => assertMergedConfigLoopback("nope"))).toBe("compose-config-unreadable");
  });
  test("the overlay renames every container, forces the mainnet class and an empty faucet key, and joins no chain network", () => {
    const names = (t: string) => [...t.matchAll(/container_name:\s*(\S+)/g)].map((m) => m[1]!);
    const baseNames = names(base.text);
    const overlayNames = names(overlay.text);
    expect(baseNames.length).toBeGreaterThanOrEqual(6);
    expect(overlayNames.length).toBe(baseNames.length);
    for (const n of overlayNames) expect(n.startsWith("dapp8453-")).toBe(true);
    for (const n of overlayNames) expect(baseNames).not.toContain(n);
    expect(overlay.text).toMatch(/VITE_ENV_CLASS:\s*mainnet/);
    expect(overlay.text).toMatch(/VITE_CHAIN_ID:\s*"8453"/);
    expect(overlay.text).toMatch(/VITE_FAUCET_HARNESS_PRIVATE_KEY:\s*""/);
    expect(noComments(overlay.text)).not.toMatch(/chain-net|CHAIN_NET_NAME/);
    expect(MAINNET_DAPP_PROJECT).not.toBe("robotmoney-dapp");
  });
});

describe("nothing in CI or the repo points a workflow or a hostname at the 8453 stack", () => {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  test("no workflow runs the mainnet verb or the overlay, and no file outside the stage tool ties the public stage hostname to 8453", () => {
    const wf = walk(join(CORE_ROOT, ".github")).filter((p) => /\.(ya?ml|sh|ts)$/.test(p));
    expect(wf.length).toBeGreaterThan(5);
    for (const p of wf) {
      const text = readFileSync(p, "utf8");
      expect(text).not.toMatch(/dapp (up|down|status) --chain|docker-compose\.dapp\.mainnet|robotmoney-dapp-8453/);
      expect(text).not.toMatch(/stage-dapp\.robotmoney-labs\.dev/);
    }
    for (const rel of ["scripts/stage/mainnet-dapp.ts", MAINNET_OVERLAY_REL]) {
      expect(noComments(readFileSync(join(CORE_ROOT, rel), "utf8"))).not.toMatch(/robotmoney-labs\.dev|cloudflared|nginx|ingress/i);
    }
  });
});

// ─── core-stack dapp up|down|status --chain 8453 against a fake docker ──────
interface Rec {
  cmd: string[];
  opts?: RunOpts;
}
function harness(over: { env?: Record<string, string | undefined>; configJson?: string; upCode?: number; http?: Record<string, boolean> } = {}) {
  const calls: Rec[] = [];
  let out = "";
  let err = "";
  const defaultConfig = JSON.stringify({ services: { dapp: { ports: [{ host_ip: "127.0.0.1", published: "15173" }] }, "explorer-api": { ports: [{ host_ip: "127.0.0.1", published: "18547" }] } } });
  const deps: Deps = {
    async run(cmd, opts): Promise<RunResult> {
      calls.push({ cmd, opts });
      if (cmd.includes("config")) return { code: 0, stdout: over.configJson ?? defaultConfig, stderr: "" };
      if (cmd.includes("up")) return { code: over.upCode ?? 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    has: () => true,
    out: (s) => void (out += s),
    err: (s) => void (err += s),
    nowMs: () => 1_700_000_000_000,
    sleep: async () => {},
    env: over.env ?? { PATH: "/usr/bin", HOME: "/home/x" },
    repoRoot: CORE_ROOT,
    rpcChainId: async () => "",
    httpOk: async (u) => over.http?.[u] ?? false,
    procStart: () => undefined,
  };
  return { deps, calls, get out() { return out; }, get err() { return err; } };
}
const MANI = fixture("cli");
const UP = ["dapp", "up", "--chain", "8453", "--rpc", RPC, "--manifests", MANI, "--start-block", "52401633"];
const filesOf = (argv: string[]) => argv.filter((_, i) => argv[i - 1] === "-f").map((f) => f.replace(CORE_ROOT + "/", ""));

describe("the overlay must be in the compose file list", () => {
  test("the real list passes; a list without the overlay, with an extra file or reordered is refused", () => {
    assertOverlayInFileList(mainnetComposeFiles());
    const [base] = mainnetComposeFiles();
    expect(refusal(() => assertOverlayInFileList([base!]))).toBe("overlay-missing");
    expect(refusal(() => assertOverlayInFileList([...mainnetComposeFiles(), "testing/ethereum-testnet/config/docker-compose.dapp.stage.yaml"]))).toBe("overlay-missing");
    expect(refusal(() => assertOverlayInFileList([...mainnetComposeFiles()].reverse()))).toBe("overlay-missing");
    expect(refusal(() => assertOverlayInFileList([]))).toBe("overlay-missing");
  });
});

describe("core-stack dapp --chain 8453", () => {
  test("up: config check then up, with the 8453 project, only the dapp files, no chain and no deploy job", async () => {
    const h = harness();
    expect(await runCli(UP, h.deps)).toBe(0);
    expect(h.calls.map((c) => c.cmd.find((a) => a === "config" || a === "up"))).toEqual(["config", "up"]);
    for (const c of h.calls) {
      expect(c.cmd.slice(0, 5)).toEqual(["docker", "compose", "--project-name", MAINNET_DAPP_PROJECT, "-f"]);
      expect(filesOf(c.cmd)).toEqual([MAINNET_DAPP_COMPOSE_REL, MAINNET_OVERLAY_REL]);
      expect(c.cmd.join(" ")).not.toMatch(/stage-chain|stage-harness|twin-chain|--profile|deploy|run --rm/);
    }
    const up = h.calls[1]!;
    expect(up.opts?.env?.INDEXER_START_BLOCK).toBe("52401633");
    expect(up.opts?.env?.VITE_FAUCET_HARNESS_PRIVATE_KEY).toBe("");
    expect(up.opts?.env?.INDEXER_CHAIN_ID).toBe("8453");
    expect(up.cmd).toContain("--wait");
    expect(h.out).toContain("loopback only");
    expect(h.out).toContain("127.0.0.1:15173");
  });
  test("up: the log lines carry the RPC origin and never its key", async () => {
    const h = harness();
    await runCli(UP, h.deps);
    expect(h.err).toContain("https://rpc.example");
    expect(h.err).not.toContain("SECRET-API-KEY");
    expect(h.out).not.toContain("SECRET-API-KEY");
  });
  test("up: --upgrade-evidence reaches the env builder (security round 2); a scheduled-only row refuses the build before compose runs", async () => {
    const ev = join(WORK, "cli-ev.json");
    writeFileSync(ev, JSON.stringify({ chain_id: 8453, proxy_upgrades: [{ proxy: "rmUSDC", proxy_address: A(0x9999), implementation_code_hash: `0x${"f0".repeat(32)}`, execute_tx: `0x${"13".repeat(32)}`, execute_status: 1 }] }));
    const h = harness();
    expect(await runCli([...UP, "--upgrade-evidence", ev], h.deps)).toBe(0);
    writeFileSync(ev, JSON.stringify({ chain_id: 8453, proxy_upgrades: [{ proxy: "rmUSDC", proxy_address: A(0x9999), implementation_code_hash: `0x${"f0".repeat(32)}` }] }));
    const refused = harness();
    expect(await runCli([...UP, "--upgrade-evidence", ev], refused.deps)).not.toBe(0);
    expect(refused.calls).toEqual([]);
  });
  test("up: flags reach the environment (logs RPC, range, ports)", async () => {
    const h = harness();
    const argv = [...UP, "--logs-rpc", "https://logs.example/x", "--max-block-range", "900", "--dapp-port", "16000", "--explorer-port", "16001"];
    expect(await runCli(argv, h.deps)).toBe(0);
    const env = h.calls[1]!.opts!.env!;
    expect([env.INDEXER_LOGS_RPC_URL, env.INDEXER_MAX_BLOCKS_PER_TICK, env.DAPP_PORT, env.EXPLORER_API_PORT]).toEqual(["https://logs.example/x", "900", "16000", "16001"]);
  });
  test("up: any signing key in the environment is refused with exit 65 before a file is read or a command runs", async () => {
    for (const name of ["VITE_FAUCET_HARNESS_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "ETH_KEYSTORE", "STAGE_SHEET"]) {
      const h = harness({ env: { PATH: "/usr/bin", [name]: "x" } });
      expect(await runCli(UP, h.deps)).toBe(65);
      expect(h.calls.length).toBe(0);
      expect(h.out).toContain("signing-env-present");
      expect(h.out).toContain(name);
    }
  });
  test("up: the same refusal covers down and status", async () => {
    for (const verb of ["down", "status"]) {
      const h = harness({ env: { PRIVATE_KEY: "x" } });
      expect(await runCli(["dapp", verb, "--chain", "8453"], h.deps)).toBe(65);
      expect(h.calls.length).toBe(0);
    }
  });
  test("up: another chain, a missing option, a bad manifest and a non-loopback merged config refuse without starting anything", async () => {
    let h = harness();
    expect(await runCli(["dapp", "up", "--chain", "918453", "--rpc", RPC, "--manifests", MANI, "--start-block", "1"], h.deps)).toBe(65);
    expect(h.out).toContain("wrong-chain");
    for (const drop of ["--rpc", "--manifests", "--start-block"]) {
      h = harness();
      const argv = [...UP];
      const i = argv.indexOf(drop);
      argv.splice(i, 2);
      expect(await runCli(argv, h.deps)).toBe(64);
      expect(h.calls.length).toBe(0);
    }
    h = harness();
    expect(await runCli(UP.map((a) => (a === MANI ? fixture("cli-bad", (d) => void (d[manifestOf("registry")]!.chain_id = 1)) : a)), h.deps)).toBe(65);
    expect(h.calls.length).toBe(0);
    h = harness({ configJson: JSON.stringify({ services: { dapp: { ports: [{ host_ip: "0.0.0.0", published: "15173" }] } } }) });
    expect(await runCli(UP, h.deps)).toBe(65);
    expect(h.out).toContain("port-not-loopback");
    expect(h.calls.some((c) => c.cmd.includes("up"))).toBe(false);
  });
  test("up: a stack that does not become healthy exits 66", async () => {
    expect(await runCli(UP, harness({ upCode: 1 }).deps)).toBe(66);
  });
  test("down: only the 8453 project is taken down, with placeholder values and no key", async () => {
    const h = harness();
    expect(await runCli(["dapp", "down", "--chain", "8453"], h.deps)).toBe(0);
    expect(h.calls.length).toBe(1);
    expect(h.calls[0]!.cmd.slice(0, 4)).toEqual(["docker", "compose", "--project-name", MAINNET_DAPP_PROJECT]);
    expect(h.calls[0]!.cmd).toContain("down");
    expect(h.calls[0]!.opts?.env?.VITE_FAUCET_HARNESS_PRIVATE_KEY).toBe("");
  });
  test("status: asks the loopback ports of the 8453 stack, not the stage ports", async () => {
    const asked: string[] = [];
    const h = harness();
    h.deps.httpOk = async (u) => (asked.push(u), true);
    expect(await runCli(["dapp", "status", "--chain", "8453"], h.deps)).toBe(0);
    expect(asked).toEqual([`http://127.0.0.1:${MAINNET_DEFAULT_PORTS.explorer}/health`, `http://127.0.0.1:${MAINNET_DEFAULT_PORTS.dapp}/`]);
    const down = harness();
    expect(await runCli(["dapp", "status", "--chain", "8453"], down.deps)).toBe(1);
    expect(down.out).toContain("explorer-unready");
  });
  test("up and down refuse a compose list without the overlay before any docker call", async () => {
    const lists: Record<string, string[]> = {
      "no overlay": [MAINNET_DAPP_COMPOSE_REL],
      "stage overlay instead": [MAINNET_DAPP_COMPOSE_REL, "testing/ethereum-testnet/config/docker-compose.dapp.stage.yaml"],
      "extra file": [...mainnetComposeFiles(), "testing/ethereum-testnet/config/docker-compose.stage-chain.yaml"],
    };
    for (const [name, list] of Object.entries(lists)) {
      for (const argv of [UP, ["dapp", "down", "--chain", "8453"]]) {
        const h = harness();
        h.deps.mainnetComposeFiles = () => list;
        expect(await runCli(argv, h.deps), name).toBe(65);
        expect(h.out, name).toContain("overlay-missing");
        expect(h.calls.length, name).toBe(0);
      }
    }
    const ok = harness();
    ok.deps.mainnetComposeFiles = () => mainnetComposeFiles();
    expect(await runCli(UP, ok.deps)).toBe(0);
  });
  test("the Twin-mode verbs are unchanged: dapp up without --chain stays a usage error", async () => {
    expect(await runCli(["dapp", "up"], harness().deps)).toBe(64);
  });
});

// ─── the Deploy 2 section of stage-deployment.md (core issue 1782, QA plan U8) ──
// The operator follows that section to point the stage dapp at Deploy 2. It names the manifests the stack reads,
// every compose key and one command. These tests keep the three equal to what this tool does, so the doc cannot
// drift from it. The Deploy 2 addresses stay in the doc only: the fixture here is the same stand-in as above.
describe("stage-deployment.md: the stage dapp on Deploy 2 matches the 8453 tool", () => {
  const doc = readFileSync(join(CORE_ROOT, "docs/development/stage-deployment.md"), "utf8");
  const start = doc.indexOf("## Stage dapp on rm-core-stage-1 pointed at Deploy 2");
  const end = start < 0 ? -1 : doc.indexOf("\n## ", start + 1);
  const section = start < 0 ? "" : doc.slice(start, end < 0 ? undefined : end);
  const lines = section.split("\n");
  const bullet = (lead: string): string => lines.find((l) => l.startsWith(`- **${lead}**`)) ?? "";
  const between = (s: string, from: string, to: string): string => {
    const i = s.indexOf(from);
    const j = i < 0 ? -1 : s.indexOf(to, i + from.length);
    return j < 0 ? "" : s.slice(i, j);
  };
  const jsonNames = (s: string): string[] => [...s.matchAll(/`([a-z0-9-]+\.json)`/g)].map((m) => m[1]!);

  test("the section is there", () => expect(section.length).toBeGreaterThan(0));

  test("the manifest bullet lists exactly the files the stack reads, and lists none of them as unread", () => {
    const read: string[] = [];
    readMainnetManifests(fixture("u8-doc"), (p) => (read.push(basename(p)), readFileSync(p, "utf8")));
    const line = bullet("Manifest paths.");
    const listed = jsonNames(between(line, "The 8453 stack reads", "It does not read"));
    const unread = jsonNames(between(line, "It does not read", "Copy the whole folder"));
    expect(listed.length).toBeGreaterThan(0);
    expect([...listed].sort()).toEqual([...new Set(read)].sort());
    expect(unread.length).toBeGreaterThan(0);
    expect(unread.filter((n) => read.includes(n))).toEqual([]);
  });

  test("the overlay key table names every key the builder sets, and only keys the builder or the overlay sets", () => {
    const env = buildMainnetDappEnv(input(fixture("u8-keys")));
    const overlay = readFileSync(join(CORE_ROOT, MAINNET_OVERLAY_REL), "utf8");
    const keys = lines
      .filter((l) => /^\s*\| `/.test(l))
      .flatMap((l) => [...(l.split("|")[1] ?? "").matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((m) => m[1]!));
    expect(keys.length).toBeGreaterThan(0);
    expect(Object.keys(env).filter((k) => !keys.includes(k))).toEqual([]);
    expect(keys.filter((k) => !(k in env) && !new RegExp(`^\\s+${k}:`, "m").test(overlay))).toEqual([]);
  });

  test("the documented command exits 0 against a fake docker with the documented start block and logs RPC", async () => {
    const i = lines.findIndex((l) => l.trim().startsWith("bun scripts/stage/core-stack.ts dapp up"));
    expect(i).toBeGreaterThanOrEqual(0);
    let cmd = "";
    for (let j = i; j < lines.length; j++) {
      const t = lines[j]!.trim();
      cmd += ` ${t.replace(/\\$/, "")}`;
      if (!t.endsWith("\\")) break;
    }
    // Drop `bun scripts/stage/core-stack.ts`; the RPC placeholder and the manifests copy become the fixture's.
    const words = cmd.replace("<base rpc url>", RPC).trim().split(/\s+/).slice(2);
    const after = (flag: string): string | undefined => (words.includes(flag) ? words[words.indexOf(flag) + 1] : undefined);
    const startBlock = after("--start-block");
    expect(startBlock).toMatch(/^[0-9]+$/);
    expect(bullet("Start block.")).toContain(`\`--start-block ${startBlock}\``);
    const argv = words.map((w, k) => (words[k - 1] === "--manifests" ? MANI : w));
    expect(argv.slice(0, 4)).toEqual(["dapp", "up", "--chain", "8453"]);
    const h = harness();
    expect(await runCli(argv, h.deps)).toBe(0);
    const env = h.calls[1]!.opts!.env!;
    expect(env.INDEXER_START_BLOCK).toBe(startBlock!);
    expect(env.INDEXER_LOGS_RPC_URL).toBe(after("--logs-rpc")!);
  });
});
