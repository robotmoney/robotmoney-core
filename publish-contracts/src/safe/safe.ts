// Safe 1.4.1 creation and connection, on @safe-global/protocol-kit. SafeL2 singleton through the canonical SafeProxyFactory.
import Safe from "@safe-global/protocol-kit";
import { concat, decodeFunctionData, encodeAbiParameters, getAddress, keccak256, toBytes, type Address, type Hex, type PublicClient } from "viem";
import { assertChainAllowed, chainGuard, lc, publicClientFor, rpcLabel, sameAddress, type ChainOpts } from "./chain.ts";
import { FACTORY_ABI, FALLBACK_HANDLER_SLOT, SAFE_141, SAFE_ABI, SAFE_VERSION, ZERO_ADDRESS } from "./constants.ts";
import { SafeRevertError, SafeToolError, revertReasonOf } from "./errors.ts";
import { silentLogger, type Logger } from "./log.ts";
import { readAfterWrite, settle, type ReadVerdict, type StaleReadRetry } from "./read-after-write.ts";
import type { Signer } from "./signers.ts";

export interface SafeHandle {
  readonly chain: ChainOpts;
  readonly address: Address;
  readonly version: typeof SAFE_VERSION;
  readonly client: PublicClient;
  readonly sdk: Safe;
  readonly logger: Logger;
  owners: Address[];
  threshold: number;
  /** Live nonce read, never cached. */
  nonce(): Promise<number>;
}

export function contractNetworksFor(chainId: number) {
  return {
    [String(chainId)]: {
      safeSingletonAddress: SAFE_141.singletonL2,
      safeProxyFactoryAddress: SAFE_141.proxyFactory,
      fallbackHandlerAddress: SAFE_141.fallbackHandler,
      multiSendAddress: SAFE_141.multiSend,
      multiSendCallOnlyAddress: SAFE_141.multiSendCallOnly,
      signMessageLibAddress: SAFE_141.signMessageLib,
      createCallAddress: SAFE_141.createCall,
      simulateTxAccessorAddress: SAFE_141.simulateTxAccessor,
    },
  };
}

export interface ConnectSafeOpts extends ChainOpts {
  safeAddress: Address;
  logger?: Logger;
  /** Set right after a broadcast that created the Safe (issue 1723): a read a node behind that block answers (no code, an eth_call with no data) is retried, bounded. Unset: single reads. */
  staleRead?: StaleReadRetry;
}

/**
 * The runtime code a SafeProxy created by `factory` for `singleton` carries. The 1.4.1 factory has no proxyRuntimeCode():
 * read proxyCreationCode(), append the constructor argument and run it as a creation eth_call, which returns the runtime code.
 */
export async function proxyRuntimeCodeOf(client: Pick<PublicClient, "readContract" | "call">, factory: Address, singleton: Address): Promise<Hex> {
  const creation = await client.readContract({ address: factory, abi: FACTORY_ABI, functionName: "proxyCreationCode" });
  const r = await client.call({ data: concat([creation, encodeAbiParameters([{ type: "address" }], [singleton])]) });
  if (!r.data || r.data === "0x") throw new SafeToolError("INFRA_MISSING", "the factory's proxy creation code returned no runtime code");
  return r.data;
}

const showCode = (c: Hex | undefined): string => (c && c !== "0x" ? `code with hash ${keccak256(c)}` : "no code");

/** Connects to a deployed Safe, on the right chain, and reads owners, threshold and version from the chain. Safe 1.4.1 only. */
export async function connectSafe(opts: ConnectSafeOpts): Promise<SafeHandle> {
  const logger = opts.logger ?? silentLogger;
  const client = publicClientFor(opts);
  await chainGuard(client, opts);
  const address = getAddress(opts.safeAddress);
  const read = <T>(what: string, expected: string, r: () => Promise<T>, judge?: (v: T) => ReadVerdict, show?: (v: T) => string) =>
    settle(opts.staleRead, { what: `${what} of the Safe ${address}`, expected, rpcUrl: opts.rpcUrl, read: r, judge, show, logger });
  const code = await read("the code", "the Safe's code", () => client.getCode({ address }), (c) => (!c || c === "0x" ? "stale" : "fresh"), showCode);
  if (!code || code === "0x") throw new SafeToolError("NOT_A_SAFE", `no contract at the Safe address ${address} on chain ${opts.chainId}`);
  let version = "";
  try { version = await read("VERSION()", SAFE_VERSION, () => client.readContract({ address, abi: SAFE_ABI, functionName: "VERSION" })); }
  catch (e) { if (e instanceof SafeToolError) throw e; /* reported below */ }
  if (version !== SAFE_VERSION) throw new SafeToolError("WRONG_SAFE_VERSION", `${address} does not answer as a Safe v${SAFE_VERSION} (VERSION: '${version || "none"}')`, { version });
  const [ownersRaw, thresholdRaw] = await Promise.all([
    read("getOwners()", "the roster", () => client.readContract({ address, abi: SAFE_ABI, functionName: "getOwners" })),
    read("getThreshold()", "the threshold", () => client.readContract({ address, abi: SAFE_ABI, functionName: "getThreshold" })),
  ]);
  const owners = [...ownersRaw] as Address[];
  const threshold = Number(thresholdRaw);
  if (owners.length === 0 || threshold < 1 || threshold > owners.length) throw new SafeToolError("NOT_A_SAFE", `the Safe reports an impossible roster: ${threshold} of ${owners.length}`);
  const sdk = await Safe.init({ provider: opts.rpcUrl, safeAddress: address, contractNetworks: contractNetworksFor(opts.chainId) });
  logger.log("info", "safe.connected", { safe: address, chain_id: opts.chainId, rpc_host: rpcLabel(opts.rpcUrl), owners: owners.length, threshold, version });
  return {
    chain: opts, address, version: SAFE_VERSION, client, sdk, logger, owners, threshold,
    async nonce() { return Number(await client.readContract({ address, abi: SAFE_ABI, functionName: "nonce" })); },
  };
}

// ---- creation -----------------------------------------------------------------------------------------------------------------------------

export interface RosterPolicy { minOwners: number; minThreshold: number; maxThresholdIsOwnersMinusOne: boolean }
/** The production roster rule, applied identically on every chain: at least 3 owners, threshold from 2 to N-1. */
export const PRODUCTION_ROSTER: RosterPolicy = { minOwners: 3, minThreshold: 2, maxThresholdIsOwnersMinusOne: true };

export interface CreateSafeOpts extends ChainOpts {
  owners: string[];
  threshold: number;
  /** Signs and pays the creation transaction (the deployer). */
  deployer: Signer;
  /** Decimal salt nonce. Default: a keccak of a fixed label, the version, threshold, owners and `deploySha`. */
  saltNonce?: string;
  deploySha?: string;
  policy?: RosterPolicy;
  /** Addresses that may not own the Safe (deployer, pauser, emergency, agent...), by label. */
  forbiddenOwners?: Record<string, string | undefined>;
  /** Required deployer nonce before the creation (stage `safe` expects 0, after it 1). Unset: not checked. */
  expectDeployerNonce?: number;
  /** Called with the plan before anything is sent. Return false to abort. Unset: no confirmation (the caller owns confirmation). */
  confirm?: (plan: CreateSafePlan) => Promise<boolean>;
  /** Simulate and plan only. */
  dryRun?: boolean;
  logger?: Logger;
  /** Bound and test seam for the reads after the creation transaction (issue 1723). Default: STALE_READ_TRIES tries, STALE_READ_DELAY_MS apart. */
  staleRead?: StaleReadRetry;
}

export interface CreateSafePlan {
  chainId: number; deployer: Address; owners: Address[]; threshold: number; version: typeof SAFE_VERSION;
  predictedAddress: Address; saltNonce: string; factory: Address; singleton: Address; fallbackHandler: Address; estimatedGas: bigint;
}

export interface CreateSafeResult {
  plan: CreateSafePlan;
  created: boolean;
  txHash?: Hex;
  block?: number;
  handle?: SafeHandle;
  /** The manifest the stage runner writes as safe.json. */
  manifest?: SafeManifest;
}

export interface SafeManifest {
  safe: Address; version: string; threshold: number; owners: Address[]; factory: Address; singleton: Address; fallback_handler: Address;
  salt_nonce: string; created_by: Address; tx_hash: Hex; block: number; chain_id: number;
}

export function validateRoster(ownersIn: string[], threshold: number, policy: RosterPolicy, forbidden: Record<string, string | undefined> = {}): Address[] {
  const owners: Address[] = ownersIn.map((o) => {
    try { return getAddress(o.trim()); } catch { throw new SafeToolError("ROSTER_INVALID", `owner '${o}' is not an address`); }
  });
  const n = owners.length;
  if (n < policy.minOwners) throw new SafeToolError("ROSTER_INVALID", `a production Safe needs at least ${policy.minOwners} owners (got ${n})`);
  if (new Set(owners.map(lc)).size !== n) throw new SafeToolError("ROSTER_INVALID", "the owner list repeats an address");
  const maxT = policy.maxThresholdIsOwnersMinusOne ? n - 1 : n;
  if (!Number.isInteger(threshold) || threshold < policy.minThreshold || threshold > maxT) {
    throw new SafeToolError("ROSTER_INVALID", `threshold ${threshold} must be an integer from ${policy.minThreshold} to ${maxT} for ${n} owners`);
  }
  for (const o of owners) {
    if (sameAddress(o, ZERO_ADDRESS)) throw new SafeToolError("ROSTER_INVALID", "the zero address cannot own the Safe");
    for (const [label, addr] of Object.entries(forbidden)) {
      if (addr && sameAddress(o, addr)) throw new SafeToolError("ROSTER_INVALID", `Safe owner ${o} is also ${label}: signers must be separate from the deployer and the operational keys`);
    }
  }
  return owners;
}

export function defaultSaltNonce(owners: Address[], threshold: number, deploySha = "none"): string {
  return BigInt(keccak256(toBytes(`robotmoney-core-safe:${deploySha}:${SAFE_VERSION}:${threshold}:${owners.join(" ")}`))).toString();
}

/**
 * Creates the production Safe through the canonical SafeProxyFactory (SafeL2 1.4.1 singleton, CompatibilityFallbackHandler).
 * All read-only checks run first. After the one creation transaction the Safe is verified from the chain, not from the plan:
 * owners, threshold, version, nonce 0, singleton slot, fallback slot and the pinned canonical proxy codehash.
 */
export async function createSafe(opts: CreateSafeOpts): Promise<CreateSafeResult> {
  const logger = opts.logger ?? silentLogger;
  assertChainAllowed(opts);
  const client = publicClientFor(opts);
  await chainGuard(client, opts);
  const policy = opts.policy ?? PRODUCTION_ROSTER;
  const deployer = await opts.deployer.address();
  const owners = validateRoster(opts.owners, opts.threshold, policy, { deployer, ...(opts.forbiddenOwners ?? {}) });

  for (const o of owners) {
    const code = await client.getCode({ address: o });
    if (code && code !== "0x") {
      if (code.startsWith("0xef0100")) logger.log("warn", "safe.create.owner_7702", { owner: o, note: "owner carries an EIP-7702 delegation; confirm it is a hardware-wallet account" });
      else throw new SafeToolError("ROSTER_INVALID", `Safe owner ${o} is a contract, not a wallet`);
    }
  }
  logger.log("info", "safe.create.roster_ok", { owners, threshold: opts.threshold });

  // the canonical infrastructure exists on this chain and is the canonical code
  for (const [label, addr] of [["factory", SAFE_141.proxyFactory], ["SafeL2 singleton", SAFE_141.singletonL2], ["fallback handler", SAFE_141.fallbackHandler]] as const) {
    const code = await client.getCode({ address: addr });
    if (!code || code === "0x") throw new SafeToolError("INFRA_MISSING", `Safe v${SAFE_VERSION} ${label} has no code at ${addr} on chain ${opts.chainId}`, { label, address: addr });
  }
  const singletonVersion = await client.readContract({ address: SAFE_141.singletonL2, abi: SAFE_ABI, functionName: "VERSION" }).catch(() => "");
  if (singletonVersion !== SAFE_VERSION) throw new SafeToolError("WRONG_SAFE_VERSION", `the singleton at ${SAFE_141.singletonL2} does not report Safe v${SAFE_VERSION}`);
  const proxyCode = await proxyRuntimeCodeOf(client, SAFE_141.proxyFactory, SAFE_141.singletonL2);
  if (keccak256(proxyCode) !== SAFE_141.proxyCodehash) throw new SafeToolError("INFRA_MISSING", "the factory's proxy runtime code is not the pinned canonical SafeProxy 1.4.1 code", { got: keccak256(proxyCode) });

  if (opts.expectDeployerNonce !== undefined) {
    const n = await client.getTransactionCount({ address: deployer });
    if (n !== opts.expectDeployerNonce) throw new SafeToolError("BAD_INPUT", `deployer nonce is ${n}, expected ${opts.expectDeployerNonce} before the Safe creation`, { got: n });
  }

  const saltNonce = opts.saltNonce ?? defaultSaltNonce(owners, opts.threshold, opts.deploySha);
  if (!/^[0-9]+$/.test(saltNonce)) throw new SafeToolError("BAD_INPUT", "saltNonce must be a decimal integer");
  const predicted = await Safe.init({
    provider: opts.rpcUrl,
    predictedSafe: {
      safeAccountConfig: { owners, threshold: opts.threshold, fallbackHandler: SAFE_141.fallbackHandler },
      safeDeploymentConfig: { saltNonce, safeVersion: SAFE_VERSION },
    },
    contractNetworks: contractNetworksFor(opts.chainId),
  });
  const predictedAddress = getAddress(await predicted.getAddress());
  const deployTx = await predicted.createSafeDeploymentTransaction();
  if (!sameAddress(deployTx.to, SAFE_141.proxyFactory)) throw new SafeToolError("CREATION_FAILED", `the SDK targets ${deployTx.to}, not the canonical factory ${SAFE_141.proxyFactory}`);
  const data = deployTx.data as Hex;

  // the factory itself agrees on the address (simulated from the deployer, nothing sent)
  let simulated: Address;
  try {
    const sim = await client.simulateContract({
      address: SAFE_141.proxyFactory, abi: FACTORY_ABI, functionName: "createProxyWithNonce", account: deployer,
      args: [SAFE_141.singletonL2, initializerOf(data), BigInt(saltNonce)],
    });
    simulated = sim.result;
  } catch (e) { throw new SafeToolError("CREATION_FAILED", `the factory refused the creation (simulated, nothing sent): ${revertReasonOf(e)}`); }
  if (!sameAddress(simulated, predictedAddress)) throw new SafeToolError("CREATION_FAILED", `the factory would create ${simulated}, the SDK predicted ${predictedAddress}`);
  const occupied = await client.getCode({ address: predictedAddress });
  if (occupied && occupied !== "0x") throw new SafeToolError("ADDRESS_OCCUPIED", `an account with code already exists at the predicted Safe address ${predictedAddress}`);

  const estimatedGas = await client.estimateGas({ account: deployer, to: deployTx.to as Address, data });
  const plan: CreateSafePlan = {
    chainId: opts.chainId, deployer, owners, threshold: opts.threshold, version: SAFE_VERSION, predictedAddress, saltNonce,
    factory: SAFE_141.proxyFactory, singleton: SAFE_141.singletonL2, fallbackHandler: SAFE_141.fallbackHandler, estimatedGas,
  };
  logger.log("info", "safe.create.plan", { ...plan, estimatedGas: estimatedGas.toString() });

  const gasPrice = await client.getGasPrice();
  const balance = await client.getBalance({ address: deployer });
  if (balance < gasPrice * estimatedGas * 3n + 100_000_000_000_000n) {
    // a dry run sends nothing: an unfunded deployer is a warning there (the preflight runs before the deployer is funded), a refusal otherwise
    if (!opts.dryRun) throw new SafeToolError("INSUFFICIENT_FUNDS", "the deployer balance is below 3x the gas cost plus the L1 allowance. Fund it.", { balance: balance.toString() });
    logger.log("warn", "safe.create.dry_run_unfunded", { balance: balance.toString() });
  }

  if (opts.dryRun) return { plan, created: false };
  if (opts.confirm && !(await opts.confirm(plan))) throw new SafeToolError("BAD_INPUT", "the operator did not confirm; nothing was sent");

  logger.log("info", "safe.create.broadcast", { deployer, safe: predictedAddress });
  let txHash: Hex;
  try { txHash = await opts.deployer.send({ to: SAFE_141.proxyFactory, data, gas: estimatedGas * 12n / 10n }, opts); }
  catch (e) { throw new SafeToolError("CREATION_FAILED", `the creation did not complete: ${revertReasonOf(e)}. Read the chain before sending it again.`); }
  const receipt = await client.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new SafeToolError("TX_REVERTED", `the creation transaction reverted: ${txHash}`);

  // every read below may meet a node behind the creation block: stale reads are retried, bounded (issue 1723)
  const staleRead = opts.staleRead ?? {};
  const handle = await connectSafe({ ...opts, safeAddress: predictedAddress, logger, staleRead });
  await verifyCreatedSafe(handle, { owners, threshold: opts.threshold }, staleRead);
  if (opts.expectDeployerNonce !== undefined) {
    const want = opts.expectDeployerNonce + 1;
    const after = await readAfterWrite({
      what: `the deployer ${deployer} nonce after ${txHash}`, expected: String(want), rpcUrl: opts.rpcUrl, logger,
      read: () => client.getTransactionCount({ address: deployer }), judge: (n) => (n < want ? "stale" : n === want ? "fresh" : "wrong"),
    }, staleRead);
    if (after !== want) throw new SafeToolError("VERIFY_FAILED", `deployer nonce is ${after} after the stage, expected ${want}`);
  }
  const manifest: SafeManifest = {
    safe: predictedAddress, version: SAFE_VERSION, threshold: opts.threshold, owners, factory: SAFE_141.proxyFactory, singleton: SAFE_141.singletonL2,
    fallback_handler: SAFE_141.fallbackHandler, salt_nonce: saltNonce, created_by: deployer, tx_hash: txHash, block: Number(receipt.blockNumber), chain_id: opts.chainId,
  };
  logger.log("info", "safe.create.verified", { safe: predictedAddress, tx_hash: txHash, block: manifest.block });
  return { plan, created: true, txHash, block: manifest.block, handle, manifest };
}

/** The `initializer` argument of createProxyWithNonce(singleton, initializer, saltNonce) inside the SDK's calldata. */
function initializerOf(calldata: Hex): Hex {
  const d = decodeFunctionData({ abi: FACTORY_ABI, data: calldata });
  if (d.functionName !== "createProxyWithNonce") throw new SafeToolError("CREATION_FAILED", "the SDK's deployment calldata is not createProxyWithNonce");
  return (d.args as readonly unknown[])[1] as Hex;
}

/**
 * Reads the finished Safe from the chain and fails on any difference from the plan. Also usable by a standalone verifier.
 * With `staleRead` (right after the creation, issue 1723) a read a node behind the creation block answers is retried, bounded: a read error
 * (an eth_call to an address without code yet), an empty storage slot or empty code. A different non-empty value still fails at once.
 */
export async function verifyCreatedSafe(handle: SafeHandle, want: { owners: Address[]; threshold: number }, staleRead?: StaleReadRetry): Promise<void> {
  const { client, address } = handle;
  const fail = (m: string): never => { throw new SafeToolError("VERIFY_FAILED", m, { safe: address }); };
  const read = <T>(what: string, expected: string, r: () => Promise<T>, judge?: (v: T) => ReadVerdict, show?: (v: T) => string) =>
    settle(staleRead, { what: `${what} of the new Safe ${address}`, expected, rpcUrl: handle.chain.rpcUrl, read: r, judge, show, logger: handle.logger });
  const word = (a: Address) => `0x${"0".repeat(24)}${lc(a).slice(2)}`;
  const slotJudge = (want: string) => (v: Hex | undefined): ReadVerdict => (!v || BigInt(v) === 0n ? "stale" : lc(v) === want ? "fresh" : "wrong");
  const owners = (await read("getOwners()", "the planned roster", () => client.readContract({ address, abi: SAFE_ABI, functionName: "getOwners" }))).map(lc).sort().join(",");
  if (owners !== want.owners.map(lc).sort().join(",")) fail(`the Safe's owners on chain differ from the plan: ${owners}`);
  if (Number(await read("getThreshold()", String(want.threshold), () => client.readContract({ address, abi: SAFE_ABI, functionName: "getThreshold" }))) !== want.threshold) fail("the Safe's threshold on chain differs from the plan");
  if ((await read("VERSION()", SAFE_VERSION, () => client.readContract({ address, abi: SAFE_ABI, functionName: "VERSION" }))) !== SAFE_VERSION) fail("the Safe reports the wrong version");
  if (Number(await read("nonce()", "0", () => client.readContract({ address, abi: SAFE_ABI, functionName: "nonce" }))) !== 0) fail("the new Safe's nonce is not 0");
  const slot0 = await read("storage slot 0", word(SAFE_141.singletonL2), () => client.getStorageAt({ address, slot: "0x0" }), slotJudge(word(SAFE_141.singletonL2)));
  if (lc(slot0 ?? "") !== word(SAFE_141.singletonL2)) fail(`the Safe's singleton (storage slot 0) is not ${SAFE_141.singletonL2}`);
  const fb = await read("the fallback handler slot", word(SAFE_141.fallbackHandler), () => client.getStorageAt({ address, slot: FALLBACK_HANDLER_SLOT }), slotJudge(word(SAFE_141.fallbackHandler)));
  if (lc(fb ?? "") !== word(SAFE_141.fallbackHandler)) fail(`the Safe's fallback handler is not ${SAFE_141.fallbackHandler}`);
  const code = await read("the code", `code with hash ${SAFE_141.proxyCodehash}`, () => client.getCode({ address }),
    (c) => (!c || c === "0x" ? "stale" : keccak256(c) === SAFE_141.proxyCodehash ? "fresh" : "wrong"), showCode);
  if (!code || keccak256(code) !== SAFE_141.proxyCodehash) fail("the Safe's code is not the factory's canonical proxy code");
}

export { SafeRevertError };
