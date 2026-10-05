// The tests read the stage table from this repo's root: publish-contracts lives inside core, so core is the directory two levels up.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const CORE_DIR: string = resolve(import.meta.dir, "..", "..");
export const coreTablePath = (dir: string = CORE_DIR): string => join(dir, "scripts", "deploy", "stage-table.json");
export const coreAvailable = (dir: string = CORE_DIR): boolean => existsSync(coreTablePath(dir));
