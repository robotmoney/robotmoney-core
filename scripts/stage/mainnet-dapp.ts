import { currentGeneration, type MigrationOverlay } from "../../publish-contracts/src/migration-overlay.ts";
// Read-only dapp stack on Base mainnet (8453), core issue 1725. Bun TypeScript, pure functions.
//
// `core-stack dapp up --chain 8453 --rpc URL --manifests DIR --start-block N` starts docker-compose.dapp.yaml plus
// docker-compose.dapp.mainnet.yaml. It starts no Twin chain, runs no deploy job, holds no key and sends no
// transaction. This module builds the compose environment from a COPY of the rehearsal manifests (a directory
// passed as an argument, never a path baked in here) and holds every refusal:
//   - a signing key, passphrase, keystore or deploy-sheet variable in the environment,
//   - a manifest from another chain, a missing manifest, an address that is not an address,
//   - a vault or the router with no recorded runtime code hash (the dapp's build-time pins, QA plan U5),
//   - a proxied vault or router (its stage manifest names an implementation) with no recorded implementation
//     code hash (the dapp's implementation pins, ADR-0014), or a recorded one for a contract that is not a proxy,
//   - a compose file that publishes a port off loopback, joins the host network or defines the deploy job.
// The explorer indexer and the dapp read through a public Base RPC. The RPC URL may carry an API key, so
// it is only ever logged as its origin.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { manifestOf, vaultManifests } from "./stage-manifests.ts";

export const MAINNET_CHAIN_ID = 8453;
/** A compose project of its own: `down` of the stage stack (robotmoney-dapp) never touches this one, nor the reverse. */
export const MAINNET_DAPP_PROJECT = "robotmoney-dapp-8453";
export const MAINNET_DAPP_COMPOSE_REL = "testing/ethereum-testnet/config/docker-compose.dapp.yaml";
export const MAINNET_OVERLAY_REL = "testing/ethereum-testnet/config/docker-compose.dapp.mainnet.yaml";
/** Host ports differ from the stage stack (5173 and 18546) so a tunnel pointed at the stage ports never reaches this stack. */
export const MAINNET_DEFAULT_PORTS = { dapp: 15173, explorer: 18547 } as const;
export const MAINNET_DEFAULT_MAX_BLOCK_RANGE = 1000;
/** Vault order is the order of the router weights and of the manifests: USDC, PROTO, AGENT, RWA. */
export const VAULT_KEYS = ["rmUSDC", "rmPROTO", "rmAGENT", "rmRWA"] as const;

/** A refusal. `cls` is the one word a caller can switch on; the detail never carries a secret value. */
export class MainnetDappError extends Error {
  constructor(
    public readonly cls: string,
    public readonly detail: string,
  ) {
    super(`${cls}: ${detail}`);
  }
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

// ─── refusals on the environment ─────────────────────────────────────────────
/**
 * Variable names that mean a signing key, a key store, a seed or a deploy step. Matched on the NAME,
 * case-insensitive. Issue 1737 item 6 (QA plan U5) widened it: `PRIVATEKEY`, a bare or `_`-delimited `PK`,
 * `ETH_KEY`, `WALLET_KEY`, any `SECRET`, any `SEED`, and every `STAGE_SHEET*` (so `STAGE_SHEET_PATH` too).
 */
export const SECRET_ENV_NAME =
  /(PRIVATE_?KEY|SECRET|MNEMONIC|SEED|PASSPHRASE|KEYSTORE|SIGNER|DEPLOYER|FAUCET|ETH_KEY|WALLET_KEY|(^|_)PK($|_)|^STAGE_SHEET|^PUBLISH_|^DEPLOY_ONLY$)/i;

/**
 * Refuses when the process environment holds anything that could sign or deploy. A set-but-empty variable is fine:
 * compose cannot use an empty key. Names only: a value is never read into a message.
 */
export function assertNoSigningEnv(env: Record<string, string | undefined>): void {
  const bad = Object.entries(env)
    .filter(([k, v]) => SECRET_ENV_NAME.test(k) && v !== undefined && v.trim() !== "")
    .map(([k]) => k)
    .sort();
  if (bad.length > 0) {
    throw new MainnetDappError(
      "signing-env-present",
      `the read-only mainnet dapp refuses to start with ${bad.join(", ")} in the environment: unset ${bad.length === 1 ? "it" : "them"} (the stack holds no key and runs no deploy or faucet step)`,
    );
  }
}

/** Refuses a built environment that carries a key or a deploy setting, or a faucet key that is not empty. */
export function assertEnvReadOnly(env: Record<string, string>): void {
  assertNoSigningEnv(env);
  if (env.VITE_FAUCET_HARNESS_PRIVATE_KEY !== "") {
    throw new MainnetDappError("faucet-key-present", "VITE_FAUCET_HARNESS_PRIVATE_KEY must be empty on 8453");
  }
  if (env.VITE_CHAIN_ID !== String(MAINNET_CHAIN_ID)) throw new MainnetDappError("wrong-chain", `VITE_CHAIN_ID must be ${MAINNET_CHAIN_ID}`);
  if (env.VITE_ENV_CLASS !== "mainnet") throw new MainnetDappError("env-class", "VITE_ENV_CLASS must be mainnet");
  if (env.INDEXER_CHAIN_ID !== String(MAINNET_CHAIN_ID) || env.EXPLORER_API_CHAIN_ID !== String(MAINNET_CHAIN_ID)) {
    throw new MainnetDappError("wrong-chain", `INDEXER_CHAIN_ID and EXPLORER_API_CHAIN_ID must be ${MAINNET_CHAIN_ID}`);
  }
}

// ─── refusals on the compose files ───────────────────────────────────────────
const stripQuotes = (s: string): string => s.trim().replace(/^["']|["']$/g, "");

/** Every published port entry of a compose file's text (the `- "host:container"` items under a `ports:` key). */
export function composePortEntries(text: string): string[] {
  const out: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)ports:\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const indent = m[1]!.length;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trim() === "" || l.trim().startsWith("#")) continue;
      const li = /^(\s*)-\s+(.*)$/.exec(l);
      if (!li || li[1]!.length <= indent) break;
      out.push(stripQuotes(li[2]!.replace(/\s+#.*$/, "")));
    }
  }
  return out;
}

/**
 * The static rules for the compose files of the 8453 stack: every published port is bound to 127.0.0.1, no service
 * uses the host network, and nothing defines the deploy job or the deploy profile. `files` are (name, text) pairs.
 */
export function assertComposeReadOnly(files: { name: string; text: string }[]): void {
  if (files.length === 0) throw new MainnetDappError("compose-missing", "no compose file to check");
  for (const f of files) {
    for (const p of composePortEntries(f.text)) {
      if (!p.startsWith("127.0.0.1:")) {
        throw new MainnetDappError("port-not-loopback", `${f.name} publishes '${p}': every port of the 8453 stack must start with 127.0.0.1:`);
      }
    }
    const code = f.text
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    if (/network_mode:\s*["']?host/.test(code)) throw new MainnetDappError("host-network", `${f.name} uses the host network`);
    if (/^\s*stage-harness:/m.test(code) || /--deploy-only/.test(code) || /\bsmoke-test\b/.test(code)) {
      throw new MainnetDappError("deploy-job-present", `${f.name} defines or calls the deploy job`);
    }
    if (/profiles:\s*\[[^\]]*\bdeploy\b/.test(code) || /^\s*-\s*deploy\s*$/m.test(code)) {
      throw new MainnetDappError("deploy-job-present", `${f.name} uses the deploy profile`);
    }
  }
}

interface ComposeConfig {
  services?: Record<string, { ports?: { host_ip?: string; published?: string | number }[]; network_mode?: string }>;
}

/** The runtime twin of the static rule, on `docker compose config --format json`: the merged, interpolated result. */
export function assertMergedConfigLoopback(configJson: string): void {
  let cfg: ComposeConfig;
  try {
    cfg = JSON.parse(configJson) as ComposeConfig;
  } catch {
    throw new MainnetDappError("compose-config-unreadable", "docker compose config did not print JSON");
  }
  const services = cfg.services ?? {};
  if (Object.keys(services).length === 0) throw new MainnetDappError("compose-config-unreadable", "docker compose config lists no service");
  for (const [name, svc] of Object.entries(services)) {
    if (name === "stage-harness") throw new MainnetDappError("deploy-job-present", "the merged config has the stage-harness service");
    if (svc.network_mode === "host") throw new MainnetDappError("host-network", `service ${name} uses the host network`);
    for (const p of svc.ports ?? []) {
      if (p.host_ip !== "127.0.0.1") {
        throw new MainnetDappError("port-not-loopback", `service ${name} publishes ${p.published ?? "?"} on '${p.host_ip ?? "all interfaces"}', not 127.0.0.1`);
      }
    }
  }
}

// ─── the manifests ───────────────────────────────────────────────────────────
export interface MainnetAddresses {
  gateway: string;
  gatewayCodeHash: string;
  /**
   * Issue 1810: the approved ERC-1967 implementation behind a proxied gateway and its code hash, from the
   * gateway manifest. Empty for a direct (legacy) gateway, whose manifest has neither field.
   */
  gatewayImplementation: string;
  gatewayImplementationHash: string;
  registry: string;
  router: string;
  /** keccak256 of the router's runtime code, as the timelock manifest read it from the chain (`code_hashes.router`). */
  routerCodeHash: string;
  /** keccak256 of each vault's runtime code, keyed like `vaults` (`vault_handover.vault_<i>.code_hash`). */
  vaultCodeHashes: Record<(typeof VAULT_KEYS)[number], string>;
  /**
   * ADR-0014: keccak256 of the implementation behind the router proxy (`code_hashes.router_implementation`).
   * Behind a proxy `routerCodeHash` is the generic `ERC1967Proxy` code, so only this pin says which logic is
   * reviewed. Empty for a direct router (its stage manifest names no `router_implementation`).
   */
  routerImplementationHash: string;
  /** The same for each vault (`vault_handover.vault_<i>.implementation_code_hash`); empty for a direct vault. */
  vaultImplementationHashes: Record<(typeof VAULT_KEYS)[number], string>;
  governance: string;
  consensusReceipt: string;
  /**
   * The InvestmentCommitteePolicy proxy (`timelock.json` `addresses.ic_policy`). Security round 1: one of the proxied core contracts (ADR-0014 §1), so the indexer must
   * watch it, or its Upgraded and UpgradesFrozen events never reach proxy_upgrade_events and the watchdog's upgrade page stays silent for it.
   */
  icPolicy: string;
  timelock: string;
  safe: string;
  vaults: Record<(typeof VAULT_KEYS)[number], string>;
}

type Json = Record<string, any>;

function readJson(dir: string, file: string, read: (p: string) => string): Json {
  const path = join(dir, file);
  let raw: unknown;
  try {
    raw = JSON.parse(read(path));
  } catch (e) {
    throw new MainnetDappError("manifest-unreadable", `${path}: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new MainnetDappError("manifest-unreadable", `${path} is not a JSON object`);
  return raw as Json;
}

function addr(file: string, field: string, v: unknown): string {
  if (typeof v !== "string" || !ADDR.test(v) || ZERO.test(v)) throw new MainnetDappError("manifest-field", `${file} ${field} is not a non-zero address`);
  return v;
}

/** A recorded runtime code hash: a non-zero bytes32, else a refusal (the dapp would build without that pin). */
function codeHash(file: string, field: string, v: unknown): string {
  if (typeof v !== "string" || !BYTES32.test(v) || /^0x0{64}$/.test(v)) {
    throw new MainnetDappError("manifest-field", `${file} ${field} is not a non-zero bytes32 runtime code hash`);
  }
  return v;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** A stage manifest's implementation address: the contract is a proxy. Absent or zero: a direct contract. */
function isProxyManifest(v: unknown): boolean {
  return typeof v === "string" && ADDR.test(v) && !ZERO.test(v);
}

/**
 * The implementation pin of one contract (ADR-0014): required when its stage manifest names an implementation,
 * refused when the timelock manifest records one for a contract that is not a proxy (the dapp would then refuse
 * every write to it as `implementation-unexpected`). Empty for a direct contract.
 */
function implementationHash(file: string, field: string, proxy: boolean, v: unknown): string {
  const recorded = typeof v === "string" && BYTES32.test(v) && !/^0x0{64}$/.test(v);
  if (proxy) return codeHash(file, field, v);
  if (recorded) {
    throw new MainnetDappError("manifest-mismatch", `${file} ${field} is set but the stage manifest names no implementation: it is not a proxy`);
  }
  return "";
}

/**
 * Reads the rehearsal manifests from `dir` (a copy given by the caller; this function only reads) and returns the
 * addresses the dapp stack is configured with. Every manifest must say chain_id 8453, and the manifests must agree
 * with one another on the shared addresses.
 */
export function readMainnetManifests(dir: string, read: (p: string) => string = (p) => readFileSync(p, "utf8"), overlay?: MigrationOverlay): MainnetAddresses {
  const files = {
    gateway: manifestOf("gateway"),
    registry: manifestOf("registry"),
    router: manifestOf("router"),
    governance: manifestOf("governance"),
    timelock: manifestOf("timelock"),
  };
  const vaultFiles = vaultManifests();
  const docs: Record<string, Json> = {};
  for (const f of [...Object.values(files), ...VAULT_KEYS.map((k) => vaultFiles[k]!)]) {
    docs[f] = readJson(dir, f, read);
    if (docs[f]!.chain_id !== MAINNET_CHAIN_ID) {
      throw new MainnetDappError("wrong-chain", `${f} says chain_id ${JSON.stringify(docs[f]!.chain_id)}, want ${MAINNET_CHAIN_ID}`);
    }
  }
  const g = docs[files.gateway]!;
  const gateway = addr(files.gateway, "gateway", g.gateway);
  const hash = g.gateway_runtime_hash;
  if (typeof hash !== "string" || !BYTES32.test(hash) || /^0x0{64}$/.test(hash)) {
    throw new MainnetDappError("manifest-field", `${files.gateway} gateway_runtime_hash is not a non-zero bytes32`);
  }
  // Issue 1810: a proxied gateway's manifest names its implementation; both fields or neither.
  let gatewayImplementation = "";
  let gatewayImplementationHash = "";
  if (g.gateway_implementation !== undefined || g.gateway_implementation_runtime_hash !== undefined) {
    gatewayImplementation = addr(files.gateway, "gateway_implementation", g.gateway_implementation);
    const ih = g.gateway_implementation_runtime_hash;
    if (typeof ih !== "string" || !BYTES32.test(ih) || /^0x0{64}$/.test(ih)) {
      throw new MainnetDappError("manifest-field", `${files.gateway} gateway_implementation_runtime_hash is not a non-zero bytes32`);
    }
    gatewayImplementationHash = ih;
  }
  const registry = addr(files.registry, "registry", docs[files.registry]!.registry);
  const router = addr(files.router, "router", docs[files.router]!.router);
  const governance = addr(files.governance, "governance", docs[files.governance]!.governance);
  if (!same(addr(files.gateway, "gateway_router", g.gateway_router), router)) {
    throw new MainnetDappError("manifest-mismatch", `${files.gateway} gateway_router differs from ${files.router} router`);
  }
  const t = docs[files.timelock]!;
  const ta = (t.addresses ?? {}) as Json;
  const timelock = addr(files.timelock, "addresses.timelock", ta.timelock);
  const safe = addr(files.timelock, "addresses.safe", ta.safe);
  const consensusReceipt = addr(files.timelock, "addresses.consensus_receipt", ta.consensus_receipt);
  const icPolicy = addr(files.timelock, "addresses.ic_policy", ta.ic_policy);
  for (const [field, want] of [["registry", registry], ["router", router], ["governance", governance], ["gateway", gateway]] as const) {
    if (!same(addr(files.timelock, `addresses.${field}`, ta[field]), want)) {
      throw new MainnetDappError("manifest-mismatch", `${files.timelock} addresses.${field} differs from its own manifest`);
    }
  }
  const timelockVaults: unknown = ta.vaults;
  if (!Array.isArray(timelockVaults) || timelockVaults.length !== VAULT_KEYS.length) {
    throw new MainnetDappError("manifest-field", `${files.timelock} addresses.vaults is not a list of ${VAULT_KEYS.length} vaults`);
  }
  const vaults = {} as MainnetAddresses["vaults"];
  /** The deploy-time vault of each key, before the migration overlay names a later generation (issue 1796). */
  const deployedVaults = {} as MainnetAddresses["vaults"];
  VAULT_KEYS.forEach((key, i) => {
    const file = vaultFiles[key]!;
    const a = addr(file, "vault", docs[file]!.vault);
    if (!same(a, addr(files.timelock, `addresses.vaults[${i}]`, timelockVaults[i]))) {
      throw new MainnetDappError("manifest-mismatch", `${file} vault differs from ${files.timelock} addresses.vaults[${i}] (${key})`);
    }
    deployedVaults[key] = a;
    vaults[key] = overlay ? currentGeneration(overlay, MAINNET_CHAIN_ID, key, a) : a;
  });
  /**
   * A vault the migration overlay moved to a later generation (issue 1796): the overlay's verified runtime hash of the
   * current generation. The timelock manifest records only the deploy-time vault, so its hashes no longer apply.
   */
  const movedRuntimeHash = (key: (typeof VAULT_KEYS)[number]): string | undefined => {
    if (!overlay || same(vaults[key], deployedVaults[key])) return undefined;
    const gen = overlay.generations.find((r) => r.vault === key && same(r.current_address, vaults[key]));
    return codeHash("current-vaults.json", `generations[${key}].current_runtime_hash`, gen?.current_runtime_hash);
  };
  // QA plan U5 (issue 1737 item 1): the dapp's build-time code-hash pins. DeployTimelock reads every vault's and
  // the router's runtime code hash back from the chain into the timelock manifest. A vault or router with no
  // recorded hash refuses the build: a bundle without its pin would refuse every deposit into it anyway.
  const routerCodeHash = codeHash(files.timelock, "code_hashes.router", ((t.code_hashes ?? {}) as Json).router);
  const handover = (t.vault_handover ?? {}) as Json;
  const vaultCodeHashes = {} as MainnetAddresses["vaultCodeHashes"];
  VAULT_KEYS.forEach((key, i) => {
    const entry = (handover[`vault_${i}`] ?? {}) as Json;
    if (!same(addr(files.timelock, `vault_handover.vault_${i}.address`, entry.address), deployedVaults[key])) {
      throw new MainnetDappError("manifest-mismatch", `${files.timelock} vault_handover.vault_${i}.address is not the ${key} vault`);
    }
    const deployedHash = codeHash(files.timelock, `vault_handover.vault_${i}.code_hash`, entry.code_hash);
    vaultCodeHashes[key] = movedRuntimeHash(key) ?? deployedHash;
  });
  // ADR-0014: behind a proxy the code hashes above are the generic ERC1967Proxy, the same for every proxy and
  // unchanged by an upgrade. The implementation pins say which logic was reviewed. DeployTimelock reads each
  // proxy's ERC-1967 implementation and hashes its code into the timelock manifest.
  const routerImplementationHash = implementationHash(
    files.timelock,
    "code_hashes.router_implementation",
    isProxyManifest(docs[files.router]!.router_implementation),
    ((t.code_hashes ?? {}) as Json).router_implementation,
  );
  const vaultImplementationHashes = {} as MainnetAddresses["vaultImplementationHashes"];
  VAULT_KEYS.forEach((key, i) => {
    const entry = (handover[`vault_${i}`] ?? {}) as Json;
    // DeployVault names the implementation `vault_implementation`; the basket vault deploys name it `implementation`.
    const vaultDoc = docs[vaultFiles[key]!]!;
    const deployed = implementationHash(
      files.timelock,
      `vault_handover.vault_${i}.implementation_code_hash`,
      isProxyManifest(vaultDoc.vault_implementation ?? vaultDoc.implementation),
      entry.implementation_code_hash,
    );
    // A vault the overlay moved has no recorded implementation hash: no pin, so the dapp refuses deposits into it
    // (exits are never gated by a pin) until a pin for its implementation is recorded.
    vaultImplementationHashes[key] = movedRuntimeHash(key) === undefined ? deployed : "";
  });
  if (!same(vaults.rmUSDC, addr(files.gateway, "vault", g.vault))) {
    throw new MainnetDappError("manifest-mismatch", `${files.gateway} vault is not the rmUSDC vault`);
  }
  return {
    gateway,
    gatewayCodeHash: hash,
    gatewayImplementation,
    gatewayImplementationHash,
    registry,
    router,
    routerCodeHash,
    routerImplementationHash,
    governance,
    consensusReceipt,
    icPolicy,
    timelock,
    safe,
    vaults,
    vaultCodeHashes,
    vaultImplementationHashes,
  };
}

// ─── the environment ─────────────────────────────────────────────────────────
export interface MainnetDappInput {
  rpc: string;
  logsRpc?: string;
  manifestsDir: string;
  startBlock: number;
  maxBlockRange?: number;
  dappPort?: number;
  explorerPort?: number;
  /** The URLs a browser reaches the stack on when something already on this host forwards to the loopback ports. Default: the loopback URLs. */
  publicDappUrl?: string;
  publicExplorerUrl?: string;
}

/** `https://host` for a URL, nothing else: a path or a query can carry an API key. */
export function redactRpc(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "(invalid url)";
  }
}

function checkRpcUrl(flag: string, url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new MainnetDappError("rpc-invalid", `${flag} is not a URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new MainnetDappError("rpc-invalid", `${flag} must be http or https`);
}

/** Port as a number in 1024..65535, else a refusal. */
function checkPort(flag: string, n: number): number {
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new MainnetDappError("port-invalid", `${flag} must be an integer from 1024 to 65535`);
  return n;
}

/**
 * The compose environment of the 8453 stack, from the manifests. Nothing here is a key, and the faucet key,
 * the devnet RPC and the compose profiles are set empty on purpose so a value in the caller's shell cannot leak in.
 */
export function buildMainnetDappEnv(input: MainnetDappInput, read?: (p: string) => string): Record<string, string> {
  checkRpcUrl("--rpc", input.rpc);
  if (input.logsRpc) checkRpcUrl("--logs-rpc", input.logsRpc);
  if (!Number.isSafeInteger(input.startBlock) || input.startBlock < 1) throw new MainnetDappError("start-block-invalid", "--start-block must be a positive integer (the first block of the deployment)");
  const range = input.maxBlockRange ?? MAINNET_DEFAULT_MAX_BLOCK_RANGE;
  if (!Number.isSafeInteger(range) || range < 1) throw new MainnetDappError("block-range-invalid", "--max-block-range must be an integer of at least 1");
  const dappPort = checkPort("--dapp-port", input.dappPort ?? MAINNET_DEFAULT_PORTS.dapp);
  const explorerPort = checkPort("--explorer-port", input.explorerPort ?? MAINNET_DEFAULT_PORTS.explorer);
  if (dappPort === explorerPort) throw new MainnetDappError("port-invalid", "--dapp-port and --explorer-port must differ");
  if (input.publicDappUrl) checkRpcUrl("--public-dapp-url", input.publicDappUrl);
  if (input.publicExplorerUrl) checkRpcUrl("--public-explorer-url", input.publicExplorerUrl);
  const origin = (u: string): string => u.replace(/\/+$/, "");
  const reader = read ?? ((p: string) => readFileSync(p, "utf8"));
  const overlayPath = join(input.manifestsDir, "current-vaults.json");
  const overlay = existsSync(overlayPath) ? JSON.parse(reader(overlayPath)) as MigrationOverlay : undefined;
  const a = readMainnetManifests(input.manifestsDir, reader, overlay);
  // ADR-0014: the reviewed implementation behind each proxied vault; a direct contract has none, and neither has a vault the
  // migration overlay moved (the overlay records the new generation's runtime hash only, see readMainnetManifests).
  const vaultPins = Object.fromEntries(VAULT_KEYS.map((k) => [a.vaults[k], a.vaultImplementationHashes[k]]).filter(([, h]) => h !== ""));
  const env: Record<string, string> = {
    COMPOSE_PROFILES: "",
    DAPP_PORT: String(dappPort),
    EXPLORER_API_PORT: String(explorerPort),
    VITE_DAPP_URL: input.publicDappUrl ? origin(input.publicDappUrl) : `http://127.0.0.1:${dappPort}`,
    VITE_EXPLORER_API_URL: input.publicExplorerUrl ? origin(input.publicExplorerUrl) : `http://127.0.0.1:${explorerPort}`,
    VITE_ENV_CLASS: "mainnet",
    VITE_CHAIN_ID: String(MAINNET_CHAIN_ID),
    VITE_FAUCET_HARNESS_PRIVATE_KEY: "",
    VITE_DEVNET_RPC_URL: "",
    VITE_GATEWAY_ADDRESS: a.gateway,
    VITE_VAULT_ADDRESS: a.vaults.rmUSDC,
    VITE_GATEWAY_EXPECTED_CODE_HASH: a.gatewayCodeHash,
    // Issue 1810: the approved implementation behind the gateway proxy and its code hash; empty for a direct gateway.
    VITE_GATEWAY_EXPECTED_IMPLEMENTATION: a.gatewayImplementation,
    VITE_GATEWAY_EXPECTED_IMPLEMENTATION_HASH: a.gatewayImplementationHash,
    // Build-time vault and router pins (QA plan U5): vault address -> runtime code hash, and the router's hash.
    VITE_VAULT_EXPECTED_CODE_HASH: JSON.stringify(Object.fromEntries(VAULT_KEYS.map((k) => [a.vaults[k], a.vaultCodeHashes[k]]))),
    VITE_ROUTER_EXPECTED_CODE_HASH: a.routerCodeHash,
    // ADR-0014 (security review 2026-10-15, review-security-007/010): behind a proxy the code-hash pins above are the generic
    // ERC1967Proxy, so the reviewed implementation behind each proxied vault and the router is pinned too. A direct contract has none.
    VITE_VAULT_EXPECTED_IMPLEMENTATION_HASH: JSON.stringify(vaultPins),
    VITE_ROUTER_EXPECTED_IMPLEMENTATION_HASH: a.routerImplementationHash,
    VITE_REGISTRY_ADDRESS: a.registry,
    VITE_ROUTER_ADDRESS: a.router,
    VITE_TIMELOCK_ADDRESS: a.timelock,
    VITE_SAFE_ADDRESS: a.safe,
    VITE_VAULT_ADDRESSES: JSON.stringify(a.vaults),
    INDEXER_GATEWAY: a.gateway,
    INDEXER_VAULT: a.vaults.rmUSDC,
    INDEXER_REGISTRY: a.registry,
    INDEXER_PORTFOLIO_ROUTER: a.router,
    INDEXER_ROUTER_GOVERNANCE: a.governance,
    INDEXER_CONSENSUS_RECEIPT: a.consensusReceipt,
    // Security round 1: the IC policy proxy is watched too. Without it its Upgraded and UpgradesFrozen events never reach proxy_upgrade_events (the watchdog's upgrade
    // page), and /v1/committee/* and /v1/regime/feed stay empty.
    INDEXER_INVESTMENT_COMMITTEE: a.icPolicy,
    // The indexer watches only the addresses it is given. Without these two the Safe and the timelock are
    // absent from /v1/chains/8453/contracts and their governance events are never read (issue 1731).
    INDEXER_TIMELOCK: a.timelock,
    INDEXER_SAFE: a.safe,
    INDEXER_RPC_URL: input.rpc,
    INDEXER_LOGS_RPC_URL: input.logsRpc ?? "",
    INDEXER_START_BLOCK: String(input.startBlock),
    INDEXER_MAX_BLOCKS_PER_TICK: String(range),
    INDEXER_CHAIN_ID: String(MAINNET_CHAIN_ID),
    INDEXER_CHAIN_NAME: "base",
    EXPLORER_API_CHAIN_ID: String(MAINNET_CHAIN_ID),
  };
  assertEnvReadOnly(env);
  return env;
}

/** Values compose interpolates with `:?` even for `down`: placeholders, never real addresses. */
export const MAINNET_TEARDOWN_ENV: Record<string, string> = {
  INDEXER_GATEWAY: "teardown",
  INDEXER_VAULT: "teardown",
  INDEXER_START_BLOCK: "1",
  VITE_GATEWAY_ADDRESS: "teardown",
  VITE_VAULT_ADDRESS: "teardown",
  VITE_GATEWAY_EXPECTED_CODE_HASH: "teardown",
  VITE_FAUCET_HARNESS_PRIVATE_KEY: "",
  COMPOSE_PROFILES: "receipt-fixtures",
};

/** Refuses a compose file list (as passed to docker compose) that lacks the read-only mainnet overlay or adds a stage or chain file. */
export function assertOverlayInFileList(files: string[]): void {
  if (!files.includes(MAINNET_OVERLAY_REL)) throw new MainnetDappError("overlay-missing", `the compose file list must include ${MAINNET_OVERLAY_REL}`);
  if (files.join("|") !== mainnetComposeFiles().join("|")) throw new MainnetDappError("overlay-missing", "the compose file list is not exactly the dapp file plus the mainnet overlay");
}

/** The compose files of the 8453 stack, relative to the repo root, in merge order. */
export const mainnetComposeFiles = (): string[] => [MAINNET_DAPP_COMPOSE_REL, MAINNET_OVERLAY_REL];

export function mainnetComposeTexts(repoRoot: string): { name: string; text: string }[] {
  return mainnetComposeFiles().map((rel) => {
    const p = join(repoRoot, rel);
    if (!existsSync(p)) throw new MainnetDappError("compose-missing", `${p} does not exist`);
    return { name: rel, text: readFileSync(p, "utf8") };
  });
}
