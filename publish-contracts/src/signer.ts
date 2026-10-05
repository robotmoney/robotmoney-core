// The one signer of a run, in two forms: the arguments forge needs for each script stage, and the Safe tool's Signer for the Safe stage
// (and for paying gas in govern). Specs: keystore:PATH[:PASSFILE], env:signer, ledger, trezor. A key or a passphrase is never an argument.
// env:signer is the caller's credential-tool hand-off: the encrypted keystore and its password arrive in CHAIN_SIGNER_KEYSTORE and
// CHAIN_SIGNER_PASSWORD, are written to a 0700 memory-backed directory for forge, and are shredded on every exit path.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress } from "viem";
import { PublishError } from "./errors.ts";
import { addressOnlySigner, keystoreSigner, ledgerSigner, trezorSigner, type CastRunner, type Signer } from "./safe/index.ts";
import type { Address } from "./sheet.ts";

export interface PublishSigner {
  readonly spec: string;
  readonly kind: "keystore" | "ledger" | "trezor" | "address";
  /** Flags for `forge script`, including --sender once known. Never carries a key or password value. */
  forgeArgs(): Promise<string[]>;
  address(): Promise<Address>;
  /** The Safe tool signer (prompts for the passphrase once, hidden, unless a file or the engine supplied it). */
  safeSigner(): Promise<Signer>;
  cleanup(): void;
}

function keystoreAddress(json: string): Address {
  let a: unknown;
  try { a = JSON.parse(json).address; } catch { throw new PublishError("SIGNER", "the keystore is not JSON"); }
  if (typeof a !== "string" || !/^(0x)?[0-9a-fA-F]{40}$/.test(a)) throw new PublishError("SIGNER", "the keystore has no address field");
  return getAddress(a.startsWith("0x") ? a : `0x${a}`);
}

/** Never echo what follows the first colon (it may be a path to a secret, or worse). */
const redact = (spec: string): string => (/^0x[0-9a-fA-F]{64}$/.test(spec) ? "0x..." : spec.replace(/:.*/s, ":..."));

function memoryDir(): string {
  const base = process.env.XDG_RUNTIME_DIR || "/dev/shm";
  if (!existsSync(base)) throw new PublishError("SIGNER", `no memory-backed directory (${base}) for the temporary keystore`);
  const d = mkdtempSync(join(base, "publish-contracts."));
  chmodSync(d, 0o700);
  return d;
}

function shred(path: string): void {
  try { const n = statSync(path).size; writeFileSync(path, Buffer.alloc(n)); } catch { /* already gone */ }
  try { rmSync(path, { force: true }); } catch { /* already gone */ }
}

export interface MakeSignerOpts {
  env?: Record<string, string | undefined>;
  runner?: CastRunner;
}

export function makeSigner(spec: string, opts: MakeSignerOpts = {}): PublishSigner {
  const env = opts.env ?? process.env;
  let cachedSafe: Signer | undefined;
  const files: string[] = [];
  let dir: string | undefined;
  const cleanup = () => { for (const f of files.splice(0)) shred(f); if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } dir = undefined; } };

  if (spec === "ledger" || spec === "trezor") {
    const s = spec === "ledger" ? ledgerSigner({ runner: opts.runner }) : trezorSigner({ runner: opts.runner });
    const flag = spec === "ledger" ? "--ledger" : "--trezor";
    return {
      spec, kind: spec, cleanup,
      async address() { return (await s.address()) as Address; },
      async forgeArgs() { return [flag, "--sender", await s.address()]; },
      async safeSigner() { return s; },
    };
  }

  if (spec === "env:signer") {
    // read once, then remove from this process's environment so a child never inherits them
    const json = env.CHAIN_SIGNER_KEYSTORE, pw = env.CHAIN_SIGNER_PASSWORD;
    delete env.CHAIN_SIGNER_KEYSTORE; delete env.CHAIN_SIGNER_PASSWORD;
    if (!json || !pw) throw new PublishError("SIGNER", "env:signer needs CHAIN_SIGNER_KEYSTORE (an encrypted keystore JSON) and CHAIN_SIGNER_PASSWORD, set by the caller's credential tool");
    const address = keystoreAddress(json);
    let forge: string[] | undefined;
    return {
      spec, kind: "keystore", cleanup,
      async address() { return address; },
      async forgeArgs() {
        if (!forge) {
          dir = memoryDir();
          const ks = join(dir, "signer.json"), pwf = join(dir, "pw");
          writeFileSync(ks, json, { mode: 0o600 }); files.push(ks);
          writeFileSync(pwf, pw, { mode: 0o600 }); files.push(pwf);
          forge = ["--keystore", ks, "--password-file", pwf, "--sender", address];
        }
        return forge;
      },
      async safeSigner() { return (cachedSafe ??= await keystoreSigner({ json, passphrase: { value: pw } })); },
    };
  }

  if (spec.startsWith("keystore:")) {
    const parts = spec.slice("keystore:".length).split(":");
    const [path, passFile] = parts;
    if (!path) throw new PublishError("SIGNER", `signer '${redact(spec)}' has no keystore path. Form: keystore:PATH[:PASSFILE]`);
    if (parts.length > 2) throw new PublishError("SIGNER", `signer '${redact(spec)}' has too many fields. Form: keystore:PATH[:PASSFILE] (a path with a colon is not supported)`);
    if (passFile === "") throw new PublishError("SIGNER", `signer '${redact(spec)}' ends with a colon and no passphrase file. Form: keystore:PATH[:PASSFILE]`);
    if (!existsSync(path)) throw new PublishError("SIGNER", `keystore not found: ${path}`);
    if (!statSync(path).isFile()) throw new PublishError("SIGNER", `keystore is not a file: ${path}`);
    if (passFile !== undefined && !existsSync(passFile)) throw new PublishError("SIGNER", `passphrase file not found: ${passFile}`);
    const address = keystoreAddress(readFileSync(path, "utf8"));
    return {
      spec, kind: "keystore", cleanup,
      async address() { return address; },
      async forgeArgs() { return ["--keystore", path, ...(passFile ? ["--password-file", passFile] : []), "--sender", address]; },
      async safeSigner() { return (cachedSafe ??= await keystoreSigner({ path, passphrase: passFile ? { file: passFile } : { prompt: `Passphrase for ${path}` } })); },
    };
  }
  if (spec.startsWith("address:")) {
    // No secret at all: the sender of a simulation. Only --dry-run accepts it (the CLI refuses it for a broadcast).
    const a = spec.slice("address:".length);
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new PublishError("SIGNER", "address:ADDR needs a 20-byte 0x address (the deployer, ADMIN_ADDRESS)");
    const address = getAddress(a);
    const s = addressOnlySigner(address);
    return { spec, kind: "address", cleanup, async address() { return address; }, async forgeArgs() { return ["--sender", address]; }, async safeSigner() { return s; } };
  }
  if (spec.startsWith("env:")) throw new PublishError("SIGNER", `unknown env signer '${redact(spec)}': the only one is env:signer (the caller's credential-tool hand-off)`);
  if (spec === "") throw new PublishError("SIGNER", "no signer given. Use keystore:PATH[:PASSFILE], env:signer, ledger or trezor");
  throw new PublishError("SIGNER", `unknown signer spec '${redact(spec)}' (keystore:PATH[:PASSFILE], env:signer, ledger, trezor). A key is never a signer`);
}
