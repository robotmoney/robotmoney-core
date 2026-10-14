// Canonical: docs/technical/single-vault-redeploy.md §§7–8.
// Original deployment manifests remain immutable. Only verified execution selects a current generation.
import { type RedeployRecord } from "./redeploy-vault.ts";
export interface MigrationOverlay {
  schema: "robotmoney-vault-generations-v1";
  chain_id: number;
  verified_block: string;
  generations: { vault: string; old_address: string; current_address: string; old_runtime_hash: string; current_runtime_hash: string; operation_id: string; execution_tx: string }[];
}
export function buildMigrationOverlay(chainId: number, block: bigint, records: RedeployRecord[], hashes: Record<string, string>): MigrationOverlay {
  const generations = records.map((r) => {
    if (r.status !== "governed" || !r.new_vault || !r.execute_tx || !r.operation_id) throw new Error("migration has no verified execution");
    const oldHash = hashes[r.old_vault.toLowerCase()], newHash = hashes[r.new_vault.toLowerCase()];
    if (!/^0x[0-9a-f]{64}$/i.test(oldHash ?? "") || !/^0x[0-9a-f]{64}$/i.test(newHash ?? "")) throw new Error("migration runtime hashes missing");
    return { vault: r.vault, old_address: r.old_vault, current_address: r.new_vault, old_runtime_hash: oldHash!, current_runtime_hash: newHash!, operation_id: r.operation_id, execution_tx: r.execute_tx };
  });
  return { schema: "robotmoney-vault-generations-v1", chain_id: chainId, verified_block: String(block), generations };
}
export function currentGeneration(overlay: MigrationOverlay, chainId: number, vault: string, original: string): string {
  if (overlay.schema !== "robotmoney-vault-generations-v1" || overlay.chain_id !== chainId || !/^[0-9]+$/.test(overlay.verified_block)) throw new Error("invalid migration overlay");
  let current = original;
  for (const r of overlay.generations.filter((r) => r.vault === vault)) {
    if (r.old_address.toLowerCase() !== current.toLowerCase() || r.old_address.toLowerCase() === r.current_address.toLowerCase() || !/^0x[0-9a-f]{40}$/i.test(r.current_address) || !/^0x[0-9a-f]{64}$/i.test(r.current_runtime_hash) || !/^0x[0-9a-f]{64}$/i.test(r.operation_id) || !/^0x[0-9a-f]{64}$/i.test(r.execution_tx)) throw new Error("migration overlay generation does not extend the original address history");
    current = r.current_address;
  }
  return current;
}
