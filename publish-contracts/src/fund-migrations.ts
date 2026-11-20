// The one-time v0.9.0 migrations of the fund system (contracts commit 588a68598): the only non-empty `upgradeToAndCall` data a fund-system upgrade may carry. Each is the
// proxy's own `migrateV090`, a reinitializer(2) callable only from the upgrade timelock, passed as the data of upgradeToAndCall. Order on chain: rebalancer, fund, queue
// (the fund migration requires the Rebalancer to run 0.9.0 already). Canonical: contracts/lib/FundMigrateLib.sol, contracts/lib/FlowMigrateLib.sol, contracts/Rebalancer.sol.
// fund-upgrade-record.ts records a decoded `fund_migration` on the proxy_upgrades entry; evidence-check.ts checks it offline and against the scheduled call; deploy-implementation.ts
// prints the data in its next-step command. Any other data is refused: arbitrary calldata never passes as a migration.
import { decodeFunctionData, encodeFunctionData, keccak256, parseAbi, type Abi, type Hex } from "viem";

export interface FundMigrationDef { proxy: string; contract: string; signature: string; selector: Hex; args: readonly { name: string; type: "address" | "uint32" | "uint16"; sheet?: string }[] }

/** By verifier proxy name (FUND_PROXY_NAMES). The queue's three arguments are the sheet's FLOW_CANCEL_BUFFER, FLOW_MAX_PAUSE and FLOW_MATCH_BAND_BPS (no sheet key yet: the runbook names it). */
export const FUND_MIGRATIONS: Readonly<Record<string, FundMigrationDef>> = {
  rebalancer: { proxy: "rebalancer", contract: "Rebalancer", signature: "migrateV090()", selector: "0x27491b91", args: [] },
  fund: { proxy: "fund", contract: "RobotMoneyFund", signature: "migrateV090(address)", selector: "0xd85cc223", args: [{ name: "rebalancer_", type: "address" }] },
  queue: {
    proxy: "queue", contract: "FlowQueue", signature: "migrateV090(uint32,uint32,uint16)", selector: "0x1d74ec6f",
    args: [{ name: "cancelBuffer_", type: "uint32", sheet: "FLOW_CANCEL_BUFFER" }, { name: "maxPause_", type: "uint32", sheet: "FLOW_MAX_PAUSE" }, { name: "matchBandBps_", type: "uint16", sheet: "FLOW_MATCH_BAND_BPS" }],
  },
};

/** The order the runbook chains them in with timelock predecessors. */
export const FUND_MIGRATION_ORDER = ["rebalancer", "fund", "queue"] as const;

/** What a proxy_upgrades entry records of the call data. */
export interface FundMigrationRecord { name: string; function: "migrateV090"; signature: string; selector: Hex; args: string[]; data: Hex; data_hash: Hex }

const abiOf = (d: FundMigrationDef): Abi => parseAbi([`function migrateV090(${d.args.map((a) => `${a.type} ${a.name}`).join(", ")})`] as readonly string[]) as Abi;

/** The upgradeToAndCall data of `proxy`'s migration with these arguments. */
export function fundMigrationData(proxy: string, args: readonly (string | bigint | number)[]): Hex {
  const d = FUND_MIGRATIONS[proxy];
  if (!d) throw new Error(`the ${proxy} proxy has no v0.9.0 migration`);
  return encodeFunctionData({ abi: abiOf(d), functionName: "migrateV090", args: d.args.map((a, i) => (a.type === "address" ? String(args[i]) : Number(args[i]))) });
}

/** The decoded migration of `data` on `proxy`, or the reason it is not one. `0x` is no migration (undefined record, no problem). */
export function decodeFundMigration(proxy: string, data: Hex): { record?: FundMigrationRecord; problem?: string } {
  if (data === "0x") return {};
  const d = FUND_MIGRATIONS[proxy];
  if (!d) return { problem: `the upgrade carries data ${data.slice(0, 10)}...: the ${proxy} proxy has no v0.9.0 migration, so its upgrade is upgradeToAndCall(new, "") only` };
  if (data.slice(0, 10).toLowerCase() !== d.selector) return { problem: `the upgrade data's selector ${data.slice(0, 10)} is not the ${proxy} proxy's ${d.signature} (${d.selector})` };
  let args: readonly unknown[];
  try { args = (decodeFunctionData({ abi: abiOf(d), data }).args ?? []) as readonly unknown[]; } catch (e) { return { problem: `the upgrade data does not decode as ${d.signature}: ${(e as Error).message.split("\n")[0]}` }; }
  const strs = args.map((a) => String(a));
  // Re-encode: trailing bytes or a non-canonical encoding is not the migration.
  if (fundMigrationData(proxy, strs).toLowerCase() !== data.toLowerCase()) return { problem: `the upgrade data is not the canonical encoding of ${d.signature}` };
  return { record: { name: `${proxy}-v090`, function: "migrateV090", signature: d.signature, selector: d.selector, args: strs, data, data_hash: keccak256(data) } };
}

/** Offline problems of a recorded `fund_migration` on a proxy_upgrades entry of `proxyName`. */
export function fundMigrationRecordProblems(rec: unknown, proxyName: string): string[] {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return ["fund_migration is not an object"];
  const r = rec as Record<string, unknown>;
  const d = FUND_MIGRATIONS[proxyName];
  if (!d) return [`fund_migration on the ${proxyName} proxy, which has no v0.9.0 migration`];
  const data = String(r.data ?? "") as Hex;
  const dec = /^0x([0-9a-fA-F]{2})+$/.test(data) ? decodeFundMigration(proxyName, data) : { problem: "fund_migration data is not hex" };
  if (dec.problem || !dec.record) return [dec.problem ?? "fund_migration data is empty"];
  const p: string[] = [];
  const w = dec.record;
  if (r.name !== w.name) p.push(`fund_migration name ${String(r.name)} is not ${w.name}`);
  if (r.signature !== w.signature) p.push(`fund_migration signature ${String(r.signature)} is not ${w.signature}`);
  if (String(r.selector ?? "").toLowerCase() !== w.selector) p.push(`fund_migration selector ${String(r.selector)} is not ${w.selector}`);
  if (String(r.data_hash ?? "").toLowerCase() !== w.data_hash.toLowerCase()) p.push("fund_migration data_hash is not the keccak256 of its data");
  if (!Array.isArray(r.args) || r.args.map(String).join(",").toLowerCase() !== w.args.join(",").toLowerCase()) p.push(`fund_migration args ${JSON.stringify(r.args)} are not the decoded data (${w.args.join(", ")})`);
  return p;
}
