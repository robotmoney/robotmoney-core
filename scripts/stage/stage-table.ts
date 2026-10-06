// Reads scripts/deploy/stage-table.json (version 1), the data the publish-contracts CLI drives the deploy from.
// This is only a reader for the stage tools in this folder. The one deploy driver is publish-contracts/src/cli.ts.
// The shape check is the CLI's own (publish-contracts/src/stage-table.ts), so the two never disagree.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStageTable, type StageTable } from "../../publish-contracts/src/stage-table.ts";

export type { StageTable };
export const TABLE_PATH = join(import.meta.dir, "..", "deploy", "stage-table.json");

/** Reads and validates the stage table. `path` defaults to the repo's own table. */
export function loadStageTable(path: string = TABLE_PATH): StageTable {
  return parseStageTable(JSON.parse(readFileSync(path, "utf8")), path);
}
