// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1.6 (Configuration).
// One JSON or TOML file plus an environment override per field: KEEPER_<FIELD_IN_SNAKE_CASE> (rpcUrl -> KEEPER_RPC_URL).
// Any invalid field throws ConfigError; the CLI exits 2 on it, before any chain read.
import { readFileSync } from "node:fs";
import { isAddress, type Address } from "viem";

export class ConfigError extends Error {
  readonly exitCode = 2;
}

export interface Config {
  rpcUrl: string;
  rpcFallbackUrls: string[];
  chainId: number;
  queue: Address;
  rebalancer: Address;
  /** Absent: direct mode (the key itself holds KEEPER_ROLE). */
  keeperAccount?: Address;
  keystore: string;
  /** A 0600 file holding the keystore password. Absent: KEEPER_PASSWORD, then stdin. */
  passwordFile?: string;
  /** Optional deployment manifest (JSON); queue, rebalancer and keeperAccount must appear in it. */
  manifest?: string;
  stateDir: string;
  intervalSecs: number;
  fastPollSecs: number;
  maxRequests: bigint;
  maxUsdc: bigint;
  maxCallsPerTick: number;
  gasMultiplier: number;
  maxFeeGwei: number;
  minGasWei: bigint;
  runwaySettles: number;
  receiptTimeoutSecs: number;
  maxReplacements: number;
  overdueSecs: number;
  realertSecs: number;
  alertWebhook?: string;
  healthPort: number;
}

const UINT_MAX = (1n << 256n) - 1n;

type Kind = "string" | "url" | "urls" | "address" | "int" | "num" | "big";
const FIELDS: Record<keyof Config, { kind: Kind; def?: unknown; optional?: boolean; min?: number }> = {
  rpcUrl: { kind: "url" },
  rpcFallbackUrls: { kind: "urls", def: [] },
  chainId: { kind: "int", min: 1 },
  queue: { kind: "address" },
  rebalancer: { kind: "address" },
  keeperAccount: { kind: "address", optional: true },
  keystore: { kind: "string" },
  passwordFile: { kind: "string", optional: true },
  manifest: { kind: "string", optional: true },
  stateDir: { kind: "string" },
  intervalSecs: { kind: "int", def: 300, min: 1 },
  fastPollSecs: { kind: "int", def: 30, min: 1 },
  maxRequests: { kind: "big", def: 100n, min: 1 },
  maxUsdc: { kind: "big", def: UINT_MAX, min: 1 },
  maxCallsPerTick: { kind: "int", def: 4, min: 1 },
  gasMultiplier: { kind: "num", def: 1.5, min: 1 },
  maxFeeGwei: { kind: "num", def: 5, min: 0 },
  minGasWei: { kind: "big", def: 1_000_000_000_000_000n, min: 0 },
  runwaySettles: { kind: "int", def: 10, min: 0 },
  receiptTimeoutSecs: { kind: "int", def: 120, min: 1 },
  maxReplacements: { kind: "int", def: 3, min: 0 },
  overdueSecs: { kind: "int", def: 900, min: 1 },
  realertSecs: { kind: "int", def: 3600, min: 1 },
  alertWebhook: { kind: "url", optional: true },
  healthPort: { kind: "int", def: 9464, min: 0 },
};

export const envName = (field: string) => "KEEPER_" + field.replace(/([A-Z])/g, "_$1").toUpperCase();

function coerce(field: string, kind: Kind, v: unknown, min?: number): unknown {
  const bad = (why: string) => new ConfigError(`config ${field}: ${why}`);
  switch (kind) {
    case "string":
      if (typeof v !== "string" || !v) throw bad("must be a non-empty string");
      return v;
    case "url":
      if (typeof v !== "string" || !/^(https?|wss?):\/\/\S+$/.test(v)) throw bad("must be an http(s) or ws(s) URL");
      return v;
    case "urls": {
      const list = typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v;
      if (!Array.isArray(list)) throw bad("must be a list of URLs");
      return list.map((u, i) => coerce(`${field}[${i}]`, "url", u));
    }
    case "address":
      if (typeof v !== "string" || !isAddress(v, { strict: false })) throw bad("must be a 0x address");
      return v as Address;
    case "int":
    case "num": {
      const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
      if (typeof n !== "number" || !Number.isFinite(n) || (kind === "int" && !Number.isInteger(n))) throw bad(`must be ${kind === "int" ? "an integer" : "a number"}`);
      if (min !== undefined && n < min) throw bad(`must be at least ${min}`);
      return n;
    }
    case "big": {
      let b: bigint;
      try {
        if (typeof v === "bigint") b = v;
        else if (typeof v === "number" && Number.isSafeInteger(v)) b = BigInt(v);
        else if (typeof v === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(v.trim())) b = BigInt(v.trim());
        else throw 0;
      } catch {
        throw bad("must be a non-negative integer (a string for large values)");
      }
      if (b < BigInt(min ?? 0) || b > UINT_MAX) throw bad("is out of range");
      return b;
    }
  }
}

/** Parses a JSON or TOML document (by extension, else by content). */
export function parseFile(path: string, text: string): Record<string, unknown> {
  const toml = path.endsWith(".toml") || (!path.endsWith(".json") && !text.trimStart().startsWith("{"));
  try {
    const v = toml ? Bun.TOML.parse(text) : JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not a table");
    return v as Record<string, unknown>;
  } catch (e) {
    throw new ConfigError(`config ${path}: cannot parse as ${toml ? "TOML" : "JSON"}: ${(e as Error).message}`);
  }
}

/** Builds the config from a parsed file and the environment. Unknown file keys are refused. */
export function buildConfig(file: Record<string, unknown>, env: Record<string, string | undefined>): Config {
  for (const k of Object.keys(file)) if (!(k in FIELDS)) throw new ConfigError(`config: unknown field '${k}'`);
  const out: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(FIELDS)) {
    const e = env[envName(field)];
    const v = e !== undefined && e !== "" ? e : file[field];
    if (v === undefined || v === null || v === "") {
      if (spec.def !== undefined) out[field] = spec.def;
      else if (!spec.optional) throw new ConfigError(`config ${field}: required (file field or ${envName(field)})`);
      continue;
    }
    out[field] = coerce(field, spec.kind, v, spec.min);
  }
  return out as unknown as Config;
}

export function loadConfig(path: string | undefined, env: Record<string, string | undefined> = process.env): Config {
  let file: Record<string, unknown> = {};
  if (path) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      throw new ConfigError(`config ${path}: cannot read: ${(e as Error).message}`);
    }
    file = parseFile(path, text);
  }
  return buildConfig(file, env);
}

/** The RPC's chain id must equal the configured one. */
export function checkChainId(cfg: Config, rpcChainId: number): void {
  if (rpcChainId !== cfg.chainId) throw new ConfigError(`chainId mismatch: config ${cfg.chainId}, RPC ${rpcChainId}`);
}

/** Every configured contract address must appear somewhere in the deployment manifest. */
export function checkManifest(cfg: Config, manifestText: string): void {
  const seen = new Set((manifestText.match(/0x[0-9a-fA-F]{40}/g) ?? []).map((a) => a.toLowerCase()));
  for (const f of ["queue", "rebalancer", "keeperAccount"] as const) {
    const a = cfg[f];
    if (a && !seen.has(a.toLowerCase())) throw new ConfigError(`manifest: ${f} ${a} is not in ${cfg.manifest}`);
  }
}
