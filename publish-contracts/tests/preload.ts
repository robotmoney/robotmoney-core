import { setDefaultTimeout } from "bun:test";
// Slow runner tests spawn stub forge and cast. bunfig.toml sets the same 60 s; this bun version needs it set here too.
setDefaultTimeout(60_000);
// Loads the stage table from the repo root (scripts/deploy/stage-table.json) before any test module reads the stage list.
import { loadStageTable } from "../src/stage-table.ts";
import { useStageTable } from "../src/stages.ts";
import { CORE_DIR } from "./core-dir.ts";

useStageTable(loadStageTable(CORE_DIR));
