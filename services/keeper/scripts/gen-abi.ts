// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1 ("The contract ABIs come from the release artifacts in out/").
// Writes src/abi.generated.json from the forge artifacts in <repo>/out: the functions the keeper calls, plus every error
// of the four contracts so a revert decodes by name. test-anvil/abi.test.ts regenerates it after `forge build` and fails
// when the committed file drifts from the contracts.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const USED: Record<string, string[]> = {
  FlowQueue: ["settle", "checkSettle", "liveness", "KEEPER_ROLE", "hasRole", "currentEpoch", "settleableAt", "settlementCount"],
  Rebalancer: ["step", "stepDelisted", "previewStep", "assetBackoffUntil", "fund", "KEEPER_ROLE", "hasRole"],
  KeeperAccount: ["execute", "isBotKey"],
  RobotMoneyFund: ["assetCount", "isAssetInSale", "executeDelistStep"],
};

type Item = { type: string; name?: string; inputs?: { type: string }[] };
const sig = (i: Item) => `${i.name}(${(i.inputs ?? []).map((x) => x.type).join(",")})`;

export function generate(outDir: string): Record<string, unknown> {
  const errors = new Map<string, Item>();
  const result: Record<string, unknown> = {};
  for (const [name, fns] of Object.entries(USED)) {
    const abi = JSON.parse(readFileSync(join(outDir, `${name}.sol`, `${name}.json`), "utf8")).abi as Item[];
    const picked = abi.filter((i) => i.type === "function" && fns.includes(i.name!));
    const missing = fns.filter((f) => !picked.some((p) => p.name === f));
    if (missing.length) throw new Error(`${name} has no function ${missing.join(", ")}`);
    result[name] = picked;
    for (const e of abi.filter((i) => i.type === "error")) errors.set(sig(e), e);
  }
  result.errors = [...errors.keys()].sort().map((k) => errors.get(k));
  return result;
}

export const render = (abi: Record<string, unknown>) => JSON.stringify(abi, null, 1) + "\n";

if (import.meta.main) {
  const outDir = process.argv[2] ?? join(import.meta.dir, "../../../out");
  writeFileSync(join(import.meta.dir, "../src/abi.generated.json"), render(generate(outDir)));
}
