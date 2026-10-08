// Chain-id keyed floors. One rule: guards apply on 8453 and nothing else changes. No flag, env switch or sheet line lifts a floor on 8453.
// Plan principles 4, 5, 6, 18, 19; issue devops 55 (S6). The chain id comes from the RPC (`cast chain-id`), never from a hostname.
import { PublishError } from "./errors.ts";
import { isLoopbackRpc } from "./safe/chain.ts";
import type { Sheet, CallerInputs } from "./sheet.ts";

import { MAINNET_CHAIN_ID, TWIN_CHAIN_ID, MAINNET_DELAY_FLOOR, isMainnet, delayFloor } from "./chains.ts";
export { MAINNET_CHAIN_ID, TWIN_CHAIN_ID, MAINNET_DELAY_FLOOR, isMainnet, delayFloor };

/** Env names that carry plaintext signing material. Refused on 8453 in the caller environment. */
export const PLAINTEXT_ENV = ["PRIVATE_KEY", "ETH_PRIVATE_KEY", "MNEMONIC", "ETH_MNEMONIC", "ETH_PASSWORD", "ETH_KEYSTORE_PASSWORD"];

/**
 * Plaintext signing material in a signer spec or the environment: a key, a mnemonic, a raw key, a plaintext-style spec.
 * A keystore with a passphrase FILE is not plaintext here (core's stage signer is keystore:PATH:PASSFILE): see passphraseFileReason.
 */
export function plaintextKeyReason(spec: string, env: Record<string, string | undefined> = {}): string | undefined {
  if (/(^|\s)--(private-key|private-keys|mnemonic|mnemonic-path|mnemonics|password)(\s|=|$)/.test(spec)) return `the signer argument carries plaintext signing material (${spec.split(/\s|=/)[0]})`;
  if (/^(plaintext|private-key|key|loopback-key)(:|$)/.test(spec)) return `signer '${spec.split(":")[0]}' is a plaintext key`;
  if (/^0x[0-9a-fA-F]{64}$/.test(spec)) return "the signer argument is a raw private key";
  for (const n of PLAINTEXT_ENV) if (env[n]) return `the environment carries ${n}`;
  return undefined;
}

/** A keystore signer with a passphrase file keeps the passphrase on disk. Allowed off 8453, refused on it. */
export const passphraseFileReason = (spec: string): string | undefined =>
  /^keystore:[^:]+:.+/.test(spec) ? "a keystore signer with a passphrase file keeps the passphrase in a file: type it at the hidden prompt, or use env:signer from the credential engine" : undefined;

/** Everything plaintext, passphrase file included. This is the 8453 rule. */
export const plaintextSignerReason = (spec: string, env: Record<string, string | undefined> = {}): string | undefined =>
  plaintextKeyReason(spec, env) ?? passphraseFileReason(spec);

/** The signer-spec floors alone, for a second signer (the pause-all EMERGENCY key): plaintext material is refused off loopback on every chain, and passphrase files on mainnet. */
export function assertSignerSpec(spec: string, i: { rpcChainId: number; rpc: string; env?: Record<string, string | undefined> }): void {
  if (!isLoopbackRpc(i.rpc)) {
    const why = plaintextKeyReason(spec, i.env ?? {});
    if (why) throw floor(`plaintext signing material is refused against a non-loopback RPC: ${why}`, { chainId: i.rpcChainId });
  }
  if (isMainnet(i.rpcChainId)) {
    const why = plaintextSignerReason(spec, i.env ?? {});
    if (why) throw floor(`plaintext signing is refused on chain ${MAINNET_CHAIN_ID}: ${why}`);
  }
}

export interface FloorInput {
  /** Chain id read from the RPC (cast chain-id). */
  rpcChainId: number;
  /** The RPC URL. Plaintext signing material is refused against any RPC that is not loopback, on every chain. */
  rpc?: string;
  sheet: Sheet;
  /** The --chain argument, when given. */
  argChainId?: number;
  caller: CallerInputs;
  signerSpec?: string;
  env?: Record<string, string | undefined>;
  environment?: string;
  githubActions?: boolean;
  /** Frozen counts are being measured (rehearsal only). */
  measure?: boolean;
  /**
   * Public addresses that share one root of trust, read from the file named by --correlated-owners-file (loadCorrelatedOwners). Addresses only, never keys.
   * REQUIRED on 8453: the floor is on by default, so an unloaded list is refused rather than skipped.
   */
  correlatedOwners?: string[];
}

/** Pull every 20-byte address out of text (a file of addresses). */
export const parseCorrelatedOwners = (text: string): string[] => [...new Set((text.match(/0x[0-9a-fA-F]{40}/g) ?? []).map((a) => a.toLowerCase()))];

/** Safe owners listed as correlated (one root of trust). Two or more of them on 8453 means one secret holds the quorum. */
export const correlatedOwnersIn = (owners: string[], personas: string[] = []): string[] => {
  const set = new Set(personas.map((a) => a.toLowerCase()));
  return owners.filter((o) => set.has(o.toLowerCase()));
};

const floor = (message: string, details: Record<string, unknown> = {}) => new PublishError("FLOOR", message, details);

/** One chain-id source: the RPC. The sheet CHAIN_ID and the --chain argument must equal it. (The sheet parser already pins EXPECTED_CHAIN_ID to CHAIN_ID.) */
export function assertChainIds(i: Pick<FloorInput, "rpcChainId" | "sheet" | "argChainId">): void {
  const { rpcChainId, sheet, argChainId } = i;
  if (!Number.isInteger(rpcChainId) || rpcChainId <= 0) throw new PublishError("CHAIN", `the RPC returned a bad chain id '${rpcChainId}'`);
  if (sheet.chainId !== rpcChainId) throw new PublishError("CHAIN", `the sheet CHAIN_ID ${sheet.chainId} differs from the chain id ${rpcChainId} read from the RPC`, { sheet: sheet.chainId, rpc: rpcChainId });
  if (argChainId !== undefined && argChainId !== rpcChainId) throw new PublishError("CHAIN", `--chain ${argChainId} differs from the chain id ${rpcChainId} read from the RPC`, { arg: argChainId, rpc: rpcChainId });
}

/** All chain-keyed floors. Throws the first violation (FLOOR or CHAIN). */
export function assertFloors(i: FloorInput): void {
  assertChainIds(i);
  const chainId = i.rpcChainId;
  const min = delayFloor(chainId);
  if (i.sheet.timelockMinDelay < BigInt(min)) throw floor(`TIMELOCK_MIN_DELAY ${i.sheet.timelockMinDelay} is below the floor ${min} on chain ${chainId}`, { delay: Number(i.sheet.timelockMinDelay), floor: min, chainId });
  if (i.sheet.govern.newDelay < BigInt(min)) throw floor(`GOVERN_NEW_DELAY ${i.sheet.govern.newDelay} is below the floor ${min} on chain ${chainId}`, { floor: min, chainId });
  if (i.rpc && !isLoopbackRpc(i.rpc)) {
    const why = plaintextKeyReason(i.signerSpec ?? "", i.env ?? {});
    if (why) throw floor(`plaintext signing material is refused against a non-loopback RPC: ${why}`, { chainId });
  }
  if (isMainnet(chainId)) {
    if (i.caller.yes) throw floor("YES=1 is refused on chain 8453: the real deployment has a human in the loop (typed confirmation, or CONFIRM=environment behind required reviewers)");
    if (i.measure) throw floor("--measure is refused on chain 8453: counts are measured on a rehearsal and frozen in a reviewed file");
    if (i.correlatedOwners === undefined) throw floor("the correlated-owners floor could not run on chain 8453: the correlated-owners file was not loaded (--correlated-owners-file)");
    const shared = correlatedOwnersIn(i.sheet.safeOwners, i.correlatedOwners);
    if (shared.length >= 2) throw floor(`${shared.length} SAFE_OWNERS are listed as correlated owners (${shared.join(", ")}): on chain 8453 the owners are independent hardware wallets, never keys that share one root of trust`, { owners: shared });
    const why = plaintextSignerReason(i.signerSpec ?? "", i.env ?? {});
    if (why) throw floor(`plaintext signing is refused on chain 8453: ${why}`);
    if (i.caller.confirm === "environment") {
      if (!i.githubActions) throw floor("CONFIRM=environment is valid only inside GitHub Actions, behind an Environment with required reviewers");
      if (!i.environment || i.environment === "local") throw floor("CONFIRM=environment needs --environment set to the GitHub Environment name");
    }
  }
}

/** Read the chain id from the RPC with `cast chain-id`. `cast` is injected so tests stub it. */
export async function readRpcChainId(cast: (args: string[]) => Promise<string>): Promise<number> {
  const out = (await cast(["chain-id"])).trim();
  if (!/^[0-9]+$/.test(out)) throw new PublishError("CHAIN", `cast chain-id returned '${out}'`);
  return Number(out);
}
