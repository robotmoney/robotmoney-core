/**
 * The argument set of the one `publish contracts` CLI. A rehearsal and production call the same CLI with the same
 * devops SHA and core DEPLOY_SHA, so they differ only in the values of these arguments (plan principle 24).
 * Flag spellings are the CLI's own (--chain, --core-sha), never the aliases.
 */
export { TWIN_CHAIN_ID, MAINNET_CHAIN_ID } from "../chains.ts";
import { TWIN_CHAIN_ID } from "../chains.ts";

export interface PublishTarget {
  chainId: number;
  rpc: string;
  sheet: string;
  signer: string;       // keystore:<path> or ledger / trezor; never a key
  environment: string;  // GitHub Environment name, or "local"
  deploySha: string;
}

export function publishArgs(t: PublishTarget): string[] {
  if (!Number.isInteger(t.chainId) || t.chainId <= 0) throw new Error(`bad chain id ${t.chainId}`);
  if (!/^https?:\/\//.test(t.rpc)) throw new Error("rpc must be an http(s) URL");
  if (/(--private-key|--password\b)/.test(t.signer) || /^0x[0-9a-fA-F]{64}$/.test(t.signer)) throw new Error("the signer argument never carries a key or password");
  return ["--chain", String(t.chainId), "--rpc", t.rpc, "--sheet", t.sheet, "--signer", t.signer, "--environment", t.environment, "--core-sha", t.deploySha];
}

export interface RehearsalArgOptions {
  sheet?: string;
  signer?: string;
  environment?: string;
  deploySha?: string;
}

/**
 * The argument set for a rehearsal on the Twin chain. Only 918453 is accepted: rehearsals never use a fork or a new chain id.
 * Defaults point at the sheet fragment and the deployer keystore the rehearsal key helper wrote.
 */
export function rehearsalArgs(chainId: number, rpc: string, o: RehearsalArgOptions = {}): string[] {
  if (chainId !== TWIN_CHAIN_ID) throw new Error(`rehearsals run on the Twin chain ${TWIN_CHAIN_ID}, not ${chainId}`);
  return publishArgs({
    chainId, rpc,
    sheet: o.sheet ?? "rehearsal/sheet.env",
    signer: o.signer ?? "keystore:rehearsal/keys/DEPLOYER",
    environment: o.environment ?? "local",
    deploySha: o.deploySha ?? "",
  });
}

/** Names of the flags whose values differ between two argument sets. */
export function differingFlags(a: string[], b: string[]): string[] {
  if (a.length !== b.length) throw new Error("argument sets differ in shape");
  const out: string[] = [];
  for (let i = 0; i < a.length; i += 2) {
    if (a[i] !== b[i]) throw new Error(`flag order differs at ${i}: ${a[i]} vs ${b[i]}`);
    if (a[i + 1] !== b[i + 1]) out.push(a[i]!);
  }
  return out;
}

/**
 * Problems with the recorded argv of a spawned process: a secret-bearing flag, a key-shaped value, a keystore body, or any of the
 * given secret values (for example the passphrase read from the password file). Empty means clean.
 */
export function argvSecretProblems(argv: string[], secrets: string[] = []): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (/^--(private-key|password|passphrase|mnemonic|mnemonic-phrase|secret|keystore-json)$/.test(a)) out.push(`argv ${i}: secret flag ${a}`);
    if (/(^|[^0-9a-fA-F])(0x)?[0-9a-fA-F]{64}($|[^0-9a-fA-F])/.test(a)) out.push(`argv ${i}: 64-hex value`);
    if (/"ciphertext"|"crypto"\s*:/.test(a)) out.push(`argv ${i}: keystore body`);
    for (const s of secrets) if (s.length >= 8 && a.includes(s)) out.push(`argv ${i}: carries a secret value`);
  });
  return out;
}
