// The Signer abstraction. A signer signs a Safe transaction hash for one owner and can send a transaction as a gas payer.
//   keystoreSigner   Foundry/Web3 v3 keystore, passphrase from a hidden prompt or a 0600 file. Never argv, never logged.
//   ledgerSigner / trezorSigner   hardware wallets through `cast wallet sign --ledger|--trezor` (prefixed eth_sign), args hold no secret.
//   loopbackKeySigner   a plaintext key, accepted only against a loopback RPC (local anvil). Refused everywhere else.
// Key material lives in a closure and is never put on a command line, in an env var, in a log line or in a bundle.
import { createDecipheriv, pbkdf2Sync, scryptSync } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createWalletClient, hexToBytes, http, isHex, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { isLoopbackRpc, viemChain, type ChainOpts } from "./chain.ts";
import { BASE_MAINNET_CHAIN_ID } from "./constants.ts";
import { SafeToolError } from "./errors.ts";
import { hiddenPrompt } from "./prompt.ts";
import { toSafeSignature, type SignMode } from "./sig.ts";

export interface SendRequest { to: Address; data: Hex; value?: bigint; gas?: bigint }

export interface Signer {
  readonly kind: "keystore" | "ledger" | "trezor" | "loopback-key" | "address-only";
  readonly modes: readonly SignMode[];
  address(): Promise<Address>;
  /** Signs the 32-byte Safe transaction hash. Returns a Safe-form signature (v 27/28 for raw, 31/32 for eth_sign). */
  signSafeHash(hash: Hex, mode: SignMode): Promise<Hex>;
  /** Sends a transaction paid by this signer's account and returns its hash. */
  send(req: SendRequest, chain: ChainOpts): Promise<Hex>;
}

// ---- passphrase sources ----------------------------------------------------------------------------------------------------
export type PassphraseSource =
  | { prompt: string }            // hidden terminal prompt (default)
  | { file: string }              // path to a file readable by its owner only (mode 0600 or stricter)
  | { value: string };            // already in memory (the caller's env hand-off); never log it

export function readPassphraseFile(path: string): string {
  if (!existsSync(path)) throw new SafeToolError("PASSPHRASE_UNAVAILABLE", `passphrase file not found: ${path}`);
  const st = statSync(path);
  if (!st.isFile()) throw new SafeToolError("PASSPHRASE_FILE_PERMISSIONS", `${path} is not a regular file`);
  if ((st.mode & 0o077) !== 0) throw new SafeToolError("PASSPHRASE_FILE_PERMISSIONS", `${path} is readable by group or others (mode ${(st.mode & 0o777).toString(8)}); run chmod 600 on it`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new SafeToolError("PASSPHRASE_FILE_PERMISSIONS", `${path} is not owned by the current user`);
  return readFileSync(path, "utf8").replace(/\r?\n$/, "");
}

export async function resolvePassphrase(src: PassphraseSource): Promise<string> {
  if ("value" in src) return src.value;
  if ("file" in src) return readPassphraseFile(src.file);
  return hiddenPrompt(src.prompt);
}

// ---- keystore decryption (Web3 Secret Storage v3: scrypt or pbkdf2, aes-128-ctr, keccak mac) ----------------------------------
export function decryptKeystoreJson(json: string, password: string): Hex {
  let c: any;
  try { c = (JSON.parse(json) as { crypto?: unknown; Crypto?: unknown }); c = c.crypto ?? c.Crypto; } catch { throw new SafeToolError("KEYSTORE_INVALID", "the keystore is not JSON"); }
  if (!c || typeof c !== "object" || !c.kdf || !c.ciphertext || !c.cipherparams?.iv || !c.mac) throw new SafeToolError("KEYSTORE_INVALID", "the keystore has no crypto section");
  const salt = Buffer.from(c.kdfparams.salt, "hex");
  let dk: Buffer;
  if (c.kdf === "scrypt") dk = scryptSync(password, salt, c.kdfparams.dklen, { N: c.kdfparams.n, r: c.kdfparams.r, p: c.kdfparams.p, maxmem: 1024 * 1024 * 1024 });
  else if (c.kdf === "pbkdf2") dk = pbkdf2Sync(password, salt, c.kdfparams.c, c.kdfparams.dklen, (c.kdfparams.prf ?? "hmac-sha256").replace("hmac-", ""));
  else throw new SafeToolError("KEYSTORE_INVALID", `unsupported keystore kdf ${c.kdf}`);
  const ct = Buffer.from(c.ciphertext, "hex");
  const mac = keccak256(Buffer.concat([dk.subarray(16, 32), ct]) as unknown as Uint8Array).slice(2);
  if (mac !== String(c.mac).toLowerCase()) throw new SafeToolError("WRONG_PASSPHRASE", "the passphrase does not open the keystore (nothing was signed or sent)");
  const d = createDecipheriv("aes-128-ctr", dk.subarray(0, 16), Buffer.from(c.cipherparams.iv, "hex"));
  const pk = Buffer.concat([d.update(ct), d.final()]);
  const hex = `0x${pk.toString("hex")}` as Hex;
  pk.fill(0);
  return hex;
}

// ---- the viem-account backed signers (keystore and loopback key) ----------------------------------------------------------------
function accountSigner(kind: "keystore" | "loopback-key", account: PrivateKeyAccount): Signer {
  return {
    kind,
    modes: ["raw", "eth_sign"],
    async address() { return account.address; },
    async signSafeHash(hash, mode) {
      const sig = mode === "raw" ? await account.sign({ hash }) : await account.signMessage({ message: { raw: hash } });
      return toSafeSignature(sig, mode);
    },
    async send(req, chain) {
      const wallet = createWalletClient({ account, chain: viemChain(chain), transport: http(chain.rpcUrl) });
      return wallet.sendTransaction({ to: req.to, data: req.data, value: req.value ?? 0n, ...(req.gas ? { gas: req.gas } : {}) });
    },
  };
}

export interface KeystoreSignerOpts {
  /** Path to the keystore file. */
  path?: string;
  /** Or the keystore JSON itself (the caller's credential tool hands it over in memory). */
  json?: string;
  passphrase?: PassphraseSource;
}

export async function keystoreSigner(opts: KeystoreSignerOpts): Promise<Signer> {
  let json = opts.json;
  if (!json) {
    if (!opts.path) throw new SafeToolError("SIGNER_UNAVAILABLE", "keystoreSigner needs a keystore path or JSON");
    if (!existsSync(opts.path)) throw new SafeToolError("SIGNER_UNAVAILABLE", `keystore not found: ${opts.path}`);
    json = readFileSync(opts.path, "utf8");
  }
  const pass = await resolvePassphrase(opts.passphrase ?? { prompt: "Keystore passphrase" });
  const pk = decryptKeystoreJson(json, pass);
  const account = privateKeyToAccount(pk);
  return accountSigner("keystore", account);
}

/**
 * The caller's credential-tool hand-off puts an ENCRYPTED keystore JSON and its password in
 * CHAIN_SIGNER_KEYSTORE / CHAIN_SIGNER_PASSWORD (or the CHAIN_FUNDER_* pair). Both are read once and removed from this process's env.
 */
export async function keystoreSignerFromEnv(role: "signer" | "funder" = "signer", env: NodeJS.ProcessEnv = process.env): Promise<Signer> {
  const ksVar = role === "signer" ? "CHAIN_SIGNER_KEYSTORE" : "CHAIN_FUNDER_KEYSTORE";
  const pwVar = role === "signer" ? "CHAIN_SIGNER_PASSWORD" : "CHAIN_FUNDER_PASSWORD";
  const json = env[ksVar], pw = env[pwVar];
  delete env[ksVar]; delete env[pwVar];
  if (!json || !pw) throw new SafeToolError("SIGNER_UNAVAILABLE", `no signer: the caller's credential tool must set ${ksVar} and ${pwVar}`);
  return keystoreSigner({ json, passphrase: { value: pw } });
}

/** A plaintext key, for a local anvil only. Refused against any non-loopback RPC and against Base mainnet. */
export function loopbackKeySigner(privateKey: Hex, chain: ChainOpts): Signer {
  if (!isLoopbackRpc(chain.rpcUrl) || chain.chainId === BASE_MAINNET_CHAIN_ID) {
    throw new SafeToolError("PLAINTEXT_KEY_REFUSED", "plaintext signing material is accepted only against a loopback RPC. Use a keystore or a hardware wallet.");
  }
  if (!isHex(privateKey) || hexToBytes(privateKey).length !== 32) throw new SafeToolError("SIGNER_UNAVAILABLE", "a private key is 32 bytes of hex");
  return accountSigner("loopback-key", privateKeyToAccount(privateKey));
}

// ---- hardware signers, through cast (no secret ever appears in these arguments) ----------------------------------------------------
export type CastRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export const runCast: CastRunner = async (args) => {
  const env = { ...process.env } as Record<string, string | undefined>;
  for (const k of ["ETH_PRIVATE_KEY", "PRIVATE_KEY", "ETH_PASSWORD", "ETH_KEYSTORE"]) delete env[k];
  const p = Bun.spawn(["cast", ...args], { stdout: "pipe", stderr: "pipe", env: env as Record<string, string> });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
};

function hardwareSigner(kind: "ledger" | "trezor", opts: { hdPath?: string; runner?: CastRunner }): Signer {
  const run = opts.runner ?? runCast;
  const flag = kind === "ledger" ? "--ledger" : "--trezor";
  const hd = opts.hdPath ? ["--mnemonic-derivation-path", opts.hdPath] : [];
  let cached: Address | undefined;
  const call = async (args: string[], what: string): Promise<string> => {
    const r = await run(args);
    if (r.code !== 0) throw new SafeToolError("HARDWARE_FAILED", `${kind} ${what} failed: ${r.stderr.split("\n").slice(-1)[0] || "no output"}`);
    return r.stdout;
  };
  return {
    kind,
    modes: ["eth_sign"],
    async address() {
      if (!cached) {
        const out = await call(["wallet", "address", flag, ...hd], "address lookup");
        if (!/^0x[0-9a-fA-F]{40}$/.test(out)) throw new SafeToolError("HARDWARE_FAILED", `${kind} returned an unexpected address`);
        cached = out as Address;
      }
      return cached;
    },
    async signSafeHash(hash, mode) {
      if (mode !== "eth_sign") throw new SafeToolError("UNSUPPORTED_SIGN_MODE", `a ${kind} signs a prefixed message: use mode eth_sign`);
      // The device signs the 32 hash bytes as a personal message. Safe reads v + 4 as that prefixed path.
      const out = await call(["wallet", "sign", flag, ...hd, hash], "signing");
      return toSafeSignature(out, "eth_sign");
    },
    async send(req, chain) {
      const args = ["send", flag, ...hd, "--rpc-url", chain.rpcUrl, "--chain", String(chain.chainId), "--json", req.to, req.data];
      if (req.value) args.push("--value", req.value.toString());
      const out = await call(args, "send");
      try { const j = JSON.parse(out) as { transactionHash?: string; status?: string }; if (j.status && j.status !== "0x1" && j.status !== "1") throw new SafeToolError("TX_REVERTED", `transaction ${j.transactionHash} reverted`); if (j.transactionHash) return j.transactionHash as Hex; } catch (e) { if (e instanceof SafeToolError) throw e; }
      throw new SafeToolError("SEND_FAILED", `${kind} send gave no transaction hash`);
    },
  };
}

export const ledgerSigner = (opts: { hdPath?: string; runner?: CastRunner } = {}): Signer => hardwareSigner("ledger", opts);
export const trezorSigner = (opts: { hdPath?: string; runner?: CastRunner } = {}): Signer => hardwareSigner("trezor", opts);

/** Build a signer from a CLI-style spec: "ledger", "trezor", "keystore:PATH[:passfile]", "env:signer", "env:funder". */
export async function signerFromSpec(spec: string, hdPath?: string): Promise<Signer> {
  if (spec === "ledger") return ledgerSigner({ hdPath });
  if (spec === "trezor") return trezorSigner({ hdPath });
  if (spec === "env:signer") return keystoreSignerFromEnv("signer");
  if (spec === "env:funder") return keystoreSignerFromEnv("funder");
  if (spec.startsWith("keystore:")) {
    const [, path, passFile] = spec.split(":");
    if (!path) throw new SafeToolError("BAD_INPUT", "keystore:PATH[:PASSPHRASE_FILE]");
    return keystoreSigner({ path, passphrase: passFile ? { file: passFile } : { prompt: `Passphrase for ${path}` } });
  }
  throw new SafeToolError("BAD_INPUT", `unknown signer spec '${spec}' (ledger, trezor, keystore:PATH[:PASSFILE], env:signer, env:funder)`);
}


/** A signer that is only an address: it can name the sender of a simulation and can never sign or send. Used by --dry-run with no secret. */
/**
 * An address-only signer that can SEND, for the preflight's local simulation chain only: the node itself signs for the unlocked
 * (impersonated) account, so no key exists anywhere. Refused against any RPC that is not loopback, and against Base mainnet's chain id.
 * It cannot sign a Safe hash.
 */
export function impersonatedSender(address: Address, chain: ChainOpts): Signer {
  if (!isLoopbackRpc(chain.rpcUrl) || chain.chainId === BASE_MAINNET_CHAIN_ID) {
    throw new SafeToolError("BAD_INPUT", "an impersonated sender is accepted only against the local simulation anvil (a loopback RPC).");
  }
  return {
    kind: "address-only", modes: [],
    async address() { return address; },
    async signSafeHash() { throw new SafeToolError("BAD_INPUT", "an impersonated sender cannot sign a Safe hash"); },
    async send(req, c) {
      const wallet = createWalletClient({ account: address, chain: viemChain(c), transport: http(c.rpcUrl) });
      return wallet.sendTransaction({ to: req.to, data: req.data, value: req.value ?? 0n, ...(req.gas ? { gas: req.gas } : {}) });
    },
  };
}

export function addressOnlySigner(address: Address): Signer {
  const no = (what: string): never => { throw new SafeToolError("BAD_INPUT", `an address-only signer cannot ${what}: it exists for --dry-run, which sends nothing`); };
  return {
    kind: "address-only", modes: [],
    async address() { return address; },
    async signSafeHash() { return no("sign"); },
    async send() { return no("send a transaction"); },
  };
}
