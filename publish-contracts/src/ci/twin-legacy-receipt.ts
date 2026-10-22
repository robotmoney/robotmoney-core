// Issue 1910: the v0.5.0-shaped receipt fixture of the Twin upgrade rehearsal (src/ci/twin-upgrade-lifecycle.ts, step 2b). Test setup only, Twin only: it builds the state the live
// v0.5.0 receipt proxy has, so the typed receipt migration of `govern --row upgrade-proxy` runs against a populated proxy. The IMPLEMENTATION the rehearsal upgrades TO is never
// created here: it comes from the `deploy-implementation` verb (the drift test of upgrade-runbook-drift.test.ts keeps the lifecycle harness itself free of raw creates).
//
// The proxy is contracts/test/helpers/LegacyConsensusRecommendationReceipt.sol (the faithful copy of the v0.5.0 state and write surface, the Solidity-level proof is
// contracts/test/ConsensusReceiptMigration.t.sol) behind an ERC1967 proxy governed by the rehearsal's timelock. The deployer is the stand-in "gateway" that records two receipts, and
// releases one as the ADMIN_ROLE holder. Then ADMIN_ROLE and DEFAULT_ADMIN_ROLE belong to the timelock, and ADMIN_ROLE also to RouterGovernance (the v0.5.0 release authority); the
// deployer holds nothing. Every transaction is a `cast send` signed by the deployer keystore. Nothing here runs on Base mainnet.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeDeployData, encodeFunctionData, getAddress, keccak256, parseAbi, toBytes, type Address, type Hex } from "viem";
import { linkCreationCode } from "../deploy-implementation.ts";
import { artifactJson } from "../verify/codehash.ts";

export const LEGACY_RECEIPT_CONTRACT = "LegacyConsensusRecommendationReceipt";
export const ADMIN_ROLE: Hex = keccak256(toBytes("ADMIN_ROLE"));
export const DEFAULT_ADMIN_ROLE: Hex = `0x${"0".repeat(64)}`;
/** GovernedUUPS.UpgradeMode.Upgradeable. */
const UPGRADE_MODE_UPGRADEABLE = 1;
export const IC_POLICY_STANDIN: Address = "0x000000000000000000000000000000000000c0de";
export const SUBMITTER_STANDIN: Address = "0x0000000000000000000000000000000000000b01";
export const RECEIPT_IDS: readonly [Hex, Hex] = [keccak256(toBytes("twin-receipt-1")), keccak256(toBytes("twin-receipt-2"))];
const DIGESTS: readonly [Hex, Hex] = [keccak256(toBytes("twin-digest-1")), keccak256(toBytes("twin-digest-2"))];
const LEGACY_INIT_ABI = parseAbi(["function initialize(address admin_, address gateway_, address icPolicy_, address upgradeTimelock_, uint8 upgradeMode_)"]);

/** One `cast send` signed by the deployer keystore. Returns the receipt JSON, and throws when the transaction did not succeed. */
export type CastSend = (args: string[]) => { transactionHash?: Hex; contractAddress?: string | null; status?: unknown };

/** A `cast send` for `rpc`: options first (cast reads everything after `--create` as the code), signed by `keystore` with `passFile`, from `from`. */
export function castSender(o: { rpc: string; keystore: string; passFile: string; from: Address; scratchDir: string }): CastSend {
  let n = 0;
  return (args) => {
    const file = join(o.scratchDir, `cast-send-${++n}.json`);
    const r = Bun.spawnSync(["cast", "send", "--json", "--rpc-url", o.rpc, "--keystore", o.keystore, "--password-file", o.passFile, "--from", o.from, ...args], { stdout: "pipe", stderr: "inherit" });
    const out = r.stdout.toString();
    Bun.write(file, out);
    if (r.exitCode !== 0) throw new Error(`cast send ${args.slice(0, 2).join(" ")} exited ${r.exitCode}`);
    const rc = JSON.parse(out.trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "{}");
    if (!["0x1", "1", "success"].includes(String(rc.status).toLowerCase())) throw new Error(`cast send ${args.slice(0, 2).join(" ")} did not succeed: ${JSON.stringify(rc)}`);
    return rc;
  };
}

/**
 * Deploys the populated v0.5.0-shaped receipt proxy. `libraries` are the addresses the live receipt implementation links (the new receipt's `implementation_deploys` entry names them),
 * so the legacy implementation links the same GovernedUpgrade library. Returns the proxy and the legacy implementation.
 */
export function deployPopulatedLegacyReceipt(o: { send: CastSend; outDir: string; libraries: Record<string, Address>; deployer: Address; timelock: Address; governance: Address }): { proxy: Address; implementation: Address } {
  const linked = linkCreationCode(artifactJson(o.outDir, LEGACY_RECEIPT_CONTRACT), o.libraries, LEGACY_RECEIPT_CONTRACT);
  if (!linked.code) throw new Error(`the legacy receipt cannot be linked: ${linked.problems.join("; ")}`);
  const implementation = getAddress(o.send(["--create", linked.code]).contractAddress as string) as Address;
  const proxyArt = artifactJson(o.outDir, "ERC1967Proxy");
  const init = encodeFunctionData({ abi: LEGACY_INIT_ABI, functionName: "initialize", args: [o.deployer, o.deployer, IC_POLICY_STANDIN, o.timelock, UPGRADE_MODE_UPGRADEABLE] });
  const proxy = getAddress(o.send(["--create", encodeDeployData({ abi: proxyArt.abi, bytecode: proxyArt.bytecode.object as Hex, args: [implementation, init] })]).contractAddress as string) as Address;
  for (const role of [DEFAULT_ADMIN_ROLE, ADMIN_ROLE]) o.send([proxy, "grantRole(bytes32,address)", role, o.timelock]);
  o.send([proxy, "grantRole(bytes32,address)", ADMIN_ROLE, o.governance]);
  RECEIPT_IDS.forEach((id, i) => o.send([proxy, "recordReceipt(address,bytes32,bytes32,string)", SUBMITTER_STANDIN, id, DIGESTS[i]!, `https://twin.invalid/r${i + 1}`]));
  o.send([proxy, "releaseReceipt(bytes32)", RECEIPT_IDS[0]]);
  for (const role of [ADMIN_ROLE, DEFAULT_ADMIN_ROLE]) o.send([proxy, "renounceRole(bytes32,address)", role, o.deployer]);
  return { proxy, implementation };
}

/** The deployer's address from its keystore file. */
export const keystoreAddress = (path: string): Address => getAddress(`0x${String(JSON.parse(readFileSync(path, "utf8")).address).replace(/^0x/, "")}`) as Address;
