// The one-time migrations of the fund system, per release: the only non-empty `upgradeToAndCall` data a fund-system upgrade may carry. Each is the proxy's own
// migrate function, a reinitializer callable only from the upgrade timelock, passed as the data of upgradeToAndCall.
//   v0.9.0  (contracts commit 588a68598): migrateV090 on rebalancer, fund, queue. Order on chain: rebalancer, fund, queue (the fund migration requires the Rebalancer to run 0.9.0).
//   v0.10.0 (issue 2062): migrateV0100() on rebalancer, fund, queue, fund-governance and fund-receipt, each without arguments. A proxy whose build has no migrateV0100 upgrades with 0x.
// Canonical: contracts/lib/FundMigrateLib.sol, contracts/lib/FlowMigrateLib.sol, contracts/Rebalancer.sol, docs/runbooks/contract-qa/releases/v0.10.0-onevault-upgrade.yaml.
// fund-upgrade-record.ts records a decoded `fund_migration` on the proxy_upgrades entry; evidence-check.ts checks it offline and against the scheduled call; deploy-implementation.ts
// prints the current release's data in its next-step command. Any other data is refused: arbitrary calldata never passes as a migration.
import { decodeFunctionData, encodeFunctionData, keccak256, parseAbi, toFunctionSelector, type Abi, type Hex } from "viem";

export interface FundMigrationDef { proxy: string; contract: string; function: string; signature: string; selector: Hex; args: readonly { name: string; type: "address" | "uint32" | "uint16"; sheet?: string }[] }
export interface ReleaseMigrations { release: string; function: string; defs: Readonly<Record<string, FundMigrationDef>> }

const noArgs = (proxy: string, contract: string, fn: string): FundMigrationDef => ({ proxy, contract, function: fn, signature: `${fn}()`, selector: toFunctionSelector(`${fn}()`), args: [] });

/** Oldest first. By verifier proxy name. The v0.9.0 queue's three arguments are the sheet's FLOW_CANCEL_BUFFER, FLOW_MAX_PAUSE and FLOW_MATCH_BAND_BPS. */
export const FUND_MIGRATION_RELEASES: readonly ReleaseMigrations[] = [
  {
    release: "v0.9.0", function: "migrateV090", defs: {
      rebalancer: { proxy: "rebalancer", contract: "Rebalancer", function: "migrateV090", signature: "migrateV090()", selector: "0x27491b91", args: [] },
      fund: { proxy: "fund", contract: "RobotMoneyFund", function: "migrateV090", signature: "migrateV090(address)", selector: "0xd85cc223", args: [{ name: "rebalancer_", type: "address" }] },
      queue: {
        proxy: "queue", contract: "FlowQueue", function: "migrateV090", signature: "migrateV090(uint32,uint32,uint16)", selector: "0x1d74ec6f",
        args: [{ name: "cancelBuffer_", type: "uint32", sheet: "FLOW_CANCEL_BUFFER" }, { name: "maxPause_", type: "uint32", sheet: "FLOW_MAX_PAUSE" }, { name: "matchBandBps_", type: "uint16", sheet: "FLOW_MATCH_BAND_BPS" }],
      },
    },
  },
  {
    release: "v0.10.0", function: "migrateV0100", defs: {
      rebalancer: noArgs("rebalancer", "Rebalancer", "migrateV0100"),
      fund: noArgs("fund", "RobotMoneyFund", "migrateV0100"),
      queue: noArgs("queue", "FlowQueue", "migrateV0100"),
      "fund-governance": noArgs("fund-governance", "RebalanceGovernance", "migrateV0100"),
      "fund-receipt": noArgs("fund-receipt", "ConsensusRecommendationReceipt", "migrateV0100"),
    },
  },
];

export const LATEST_RELEASE = FUND_MIGRATION_RELEASES[FUND_MIGRATION_RELEASES.length - 1]!.release;

export function releaseMigrations(release: string): ReleaseMigrations {
  const r = FUND_MIGRATION_RELEASES.find((x) => x.release === release);
  if (!r) throw new Error(`no fund migrations are defined for release ${release} (${FUND_MIGRATION_RELEASES.map((x) => x.release).join(", ")})`);
  return r;
}

/** The v0.9.0 table, kept for the v0.9.0 release file's callers. */
export const FUND_MIGRATIONS: Readonly<Record<string, FundMigrationDef>> = releaseMigrations("v0.9.0").defs;

/**
 * PURE. The current release of a build: the newest release whose migrate function any of `abis` (the build's fund-system contract ABIs) names, or undefined when none does.
 * A 0.10.0 build still carries migrateV090, so the newest name wins; a proxy of that build without the current function upgrades with 0x, never an older migration.
 */
export function currentRelease(abis: readonly unknown[][]): ReleaseMigrations | undefined {
  const names = new Set(abis.flatMap((abi) => abi.filter((x: any) => x?.type === "function").map((x: any) => String(x.name))));
  return [...FUND_MIGRATION_RELEASES].reverse().find((r) => names.has(r.function));
}

/** The order the runbook chains them in with timelock predecessors. */
export const FUND_MIGRATION_ORDER = ["rebalancer", "fund", "queue"] as const;

/** What a proxy_upgrades entry records of the call data. */
export interface FundMigrationRecord { name: string; function: string; signature: string; selector: Hex; args: string[]; data: Hex; data_hash: Hex }

const abiOf = (d: FundMigrationDef): Abi => parseAbi([`function ${d.function}(${d.args.map((a) => `${a.type} ${a.name}`).join(", ")})`] as readonly string[]) as Abi;
const tagOf = (release: string): string => release.replace(/\./g, "");

/** The upgradeToAndCall data of `proxy`'s migration of `release` (default v0.9.0) with these arguments. */
export function fundMigrationData(proxy: string, args: readonly (string | bigint | number)[], release = "v0.9.0"): Hex {
  const d = releaseMigrations(release).defs[proxy];
  if (!d) throw new Error(`the ${proxy} proxy has no ${release} migration`);
  return encodeFunctionData({ abi: abiOf(d), functionName: d.function, args: d.args.map((a, i) => (a.type === "address" ? String(args[i]) : Number(args[i]))) });
}

/** The definition of `proxy` whose selector `data` carries, in any release. */
function defBySelector(proxy: string, data: Hex): { def: FundMigrationDef; release: string } | undefined {
  for (const r of FUND_MIGRATION_RELEASES) {
    const d = r.defs[proxy];
    if (d && data.slice(0, 10).toLowerCase() === d.selector) return { def: d, release: r.release };
  }
  return undefined;
}

/** The decoded migration of `data` on `proxy`, or the reason it is not one. `0x` is no migration (undefined record, no problem). */
export function decodeFundMigration(proxy: string, data: Hex): { record?: FundMigrationRecord; problem?: string } {
  if (data === "0x") return {};
  const known = FUND_MIGRATION_RELEASES.map((r) => r.defs[proxy]).filter((d): d is FundMigrationDef => !!d);
  if (!known.length) return { problem: `the upgrade carries data ${data.slice(0, 10)}...: the ${proxy} proxy has no migration, so its upgrade is upgradeToAndCall(new, "") only` };
  const hit = defBySelector(proxy, data);
  if (!hit) return { problem: `the upgrade data's selector ${data.slice(0, 10)} is not one of the ${proxy} proxy's migrations (${known.map((d) => `${d.signature} ${d.selector}`).join(", ")})` };
  const d = hit.def;
  let args: readonly unknown[];
  try { args = (decodeFunctionData({ abi: abiOf(d), data }).args ?? []) as readonly unknown[]; } catch (e) { return { problem: `the upgrade data does not decode as ${d.signature}: ${(e as Error).message.split("\n")[0]}` }; }
  const strs = args.map((a) => String(a));
  // Re-encode: trailing bytes or a non-canonical encoding is not the migration.
  if (fundMigrationData(proxy, strs, hit.release).toLowerCase() !== data.toLowerCase()) return { problem: `the upgrade data is not the canonical encoding of ${d.signature}` };
  return { record: { name: `${proxy}-${tagOf(hit.release)}`, function: d.function, signature: d.signature, selector: d.selector, args: strs, data, data_hash: keccak256(data) } };
}

/** Offline problems of a recorded `fund_migration` on a proxy_upgrades entry of `proxyName`. */
export function fundMigrationRecordProblems(rec: unknown, proxyName: string): string[] {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return ["fund_migration is not an object"];
  const r = rec as Record<string, unknown>;
  if (!FUND_MIGRATION_RELEASES.some((x) => x.defs[proxyName])) return [`fund_migration on the ${proxyName} proxy, which has no migration`];
  const data = String(r.data ?? "") as Hex;
  const dec = /^0x([0-9a-fA-F]{2})+$/.test(data) ? decodeFundMigration(proxyName, data) : { problem: "fund_migration data is not hex" };
  if (dec.problem || !dec.record) return [dec.problem ?? "fund_migration data is empty"];
  const p: string[] = [];
  const w = dec.record;
  if (r.name !== w.name) p.push(`fund_migration name ${String(r.name)} is not ${w.name}`);
  if (r.function !== undefined && r.function !== w.function) p.push(`fund_migration function ${String(r.function)} is not ${w.function}`);
  if (r.signature !== w.signature) p.push(`fund_migration signature ${String(r.signature)} is not ${w.signature}`);
  if (String(r.selector ?? "").toLowerCase() !== w.selector) p.push(`fund_migration selector ${String(r.selector)} is not ${w.selector}`);
  if (String(r.data_hash ?? "").toLowerCase() !== w.data_hash.toLowerCase()) p.push("fund_migration data_hash is not the keccak256 of its data");
  if (!Array.isArray(r.args) || r.args.map(String).join(",").toLowerCase() !== w.args.join(",").toLowerCase()) p.push(`fund_migration args ${JSON.stringify(r.args)} are not the decoded data (${w.args.join(", ")})`);
  return p;
}

/** PURE. The migration arguments of `proxy` in `release` (default v0.9.0) from the run sheet's text and the Rebalancer proxy address (the v0.9.0 fund's one argument). */
export function migrationArgsFrom(proxy: string, sheetText: string, rebalancer: string | undefined, release = "v0.9.0"): string[] {
  const r = releaseMigrations(release);
  const d = r.defs[proxy];
  if (!d) throw new Error(`the ${proxy} proxy has no ${release} migration (${Object.keys(r.defs).join(", ")})`);
  const sheet = Object.fromEntries(sheetText.split("\n").map((l) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(l.trim())).filter((m): m is RegExpExecArray => !!m).map((m) => [m[1]!, m[2]!.trim()]));
  return d.args.map((a) => {
    const v = a.type === "address" ? rebalancer : a.sheet ? sheet[a.sheet] : undefined;
    if (!v) throw new Error(`the ${proxy} migration needs ${a.type === "address" ? "the rebalancer proxy (rebalancer.json rebalancer)" : `the sheet's ${a.sheet}`}`);
    return v;
  });
}

// CLI (the release files): the one encoder of the runbook's migration data.
//   bun publish-contracts/src/fund-migrations.ts data --proxy NAME --manifest-dir DIR --sheet FILE [--release v0.9.0|v0.10.0]
// prints the proxy's migration calldata of the release (default v0.9.0, the second argument of upgradeToAndCall): for v0.9.0 the fund's from rebalancer.json, the
// queue's from the sheet's FLOW_CANCEL_BUFFER, FLOW_MAX_PAUSE and FLOW_MATCH_BAND_BPS. Exit 2 on a usage error or a missing input.
if (import.meta.main) {
  const { readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const [verb, ...rest] = process.argv.slice(2);
  const f: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) f[(rest[i] ?? "").replace(/^--/, "")] = rest[i + 1] ?? "";
  try {
    if (verb !== "data" || !f.proxy || !f["manifest-dir"] || !f.sheet) throw new Error("usage: fund-migrations.ts data --proxy NAME --manifest-dir DIR --sheet FILE [--release v0.9.0|v0.10.0]");
    const release = f.release || "v0.9.0";
    const rp = join(f["manifest-dir"], "rebalancer.json");
    const reb = existsSync(rp) ? String((JSON.parse(readFileSync(rp, "utf8")) as Record<string, unknown>).rebalancer ?? "") : undefined;
    console.log(fundMigrationData(f.proxy, migrationArgsFrom(f.proxy, readFileSync(f.sheet, "utf8"), reb || undefined, release), release));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
}
