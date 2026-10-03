#!/usr/bin/env bun
// Stage versus mainnet parity: the two diff checks over the REAL outputs of a Twin chain run.
//   labels: the verifier label set the stage run printed must equal the mainnet verifier label set.
//   sheet:  the stage sheet must differ from the production sheet only in parameter and identity lines.
// Producers: the Twin chain smoke job (testing/smoke-test/tests/twin_publish.rs) writes the verifier
// output to SMOKE_TEST_VERIFY_OUT and the run sheet to SMOKE_TEST_SHEET_OUT. The mainnet side is the
// devops production fixtures directory (verifier-labels.txt, production-sheet.env), given as an input.
// A missing or empty input FAILS with its path. It is never skipped.
//
// Usage:
//   bun scripts/stage/parity.ts --stage-labels F --stage-sheet F --fixtures-dir DIR
//   bun scripts/stage/parity.ts --stage-labels F --stage-sheet F --mainnet-labels F --production-sheet F
// Exit: 0 parity holds, 1 a difference or a missing input, 64 usage.
// Canonical: robotmoney/devops issue 53 / core issue 1499 (S8, S9; core 1488).
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { labelDiff, parseLabels } from "./label-diff.ts";
import { parseSheet, violations } from "./sheet-diff.ts";

export const MAINNET_LABELS_FILE = "verifier-labels.txt";
export const PRODUCTION_SHEET_FILE = "production-sheet.env";

export interface ParityInputs {
  stageLabels: string;
  stageSheet: string;
  mainnetLabels: string;
  productionSheet: string;
}

export interface ParityResult {
  ok: boolean;
  messages: string[];
}

/** One message per input that is absent or empty. */
export function missingInputs(inp: ParityInputs): string[] {
  const named: [string, string][] = [
    ["stage verifier labels", inp.stageLabels],
    ["stage sheet", inp.stageSheet],
    ["mainnet verifier labels", inp.mainnetLabels],
    ["production sheet", inp.productionSheet],
  ];
  const out: string[] = [];
  for (const [what, p] of named) {
    if (!p || !existsSync(p) || !statSync(p).isFile() || statSync(p).size === 0) {
      out.push(`parity input missing or empty: ${what} (${p || "no path given"})`);
    }
  }
  return out;
}

export function labelParity(stageText: string, mainnetText: string): ParityResult {
  const stage = parseLabels(stageText);
  const mainnet = parseLabels(mainnetText);
  if (stage.length === 0 || mainnet.length === 0) {
    return {
      ok: false,
      messages: [`label-diff: an empty label set (stage ${stage.length}, mainnet ${mainnet.length}) proves nothing`],
    };
  }
  const d = labelDiff(stage, mainnet);
  const messages = [
    ...d.onlyStage.map((l) => `label-diff: only on stage: ${l}`),
    ...d.onlyMainnet.map((l) => `label-diff: only on mainnet: ${l}`),
  ];
  if (messages.length === 0) messages.push(`label-diff: ${new Set(stage).size} labels, identical on stage and mainnet`);
  return { ok: d.onlyStage.length === 0 && d.onlyMainnet.length === 0, messages };
}

export function sheetParity(stageText: string, productionText: string): ParityResult {
  const v = violations(parseSheet(stageText), parseSheet(productionText));
  if (v.length) return { ok: false, messages: v.map((m) => `sheet-diff: ${m}`) };
  return { ok: true, messages: ["sheet-diff: the stage and production sheets differ only in parameter lines"] };
}

/** Runs both checks over files. Every problem is reported, not just the first. */
export function runParity(inp: ParityInputs): ParityResult {
  const missing = missingInputs(inp);
  if (missing.length) return { ok: false, messages: missing };
  const l = labelParity(readFileSync(inp.stageLabels, "utf8"), readFileSync(inp.mainnetLabels, "utf8"));
  const s = sheetParity(readFileSync(inp.stageSheet, "utf8"), readFileSync(inp.productionSheet, "utf8"));
  return { ok: l.ok && s.ok, messages: [...l.messages, ...s.messages] };
}

export function inputsFromFixturesDir(dir: string, stageLabels: string, stageSheet: string): ParityInputs {
  return {
    stageLabels,
    stageSheet,
    mainnetLabels: join(dir, MAINNET_LABELS_FILE),
    productionSheet: join(dir, PRODUCTION_SHEET_FILE),
  };
}

const USAGE =
  "usage: bun scripts/stage/parity.ts --stage-labels F --stage-sheet F (--fixtures-dir DIR | --mainnet-labels F --production-sheet F)";

if (import.meta.main) {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args: process.argv.slice(2),
      options: {
        "stage-labels": { type: "string" },
        "stage-sheet": { type: "string" },
        "fixtures-dir": { type: "string" },
        "mainnet-labels": { type: "string" },
        "production-sheet": { type: "string" },
      },
      strict: true,
    }).values;
  } catch (e) {
    console.error(`parity: ${(e as Error).message}\n${USAGE}`);
    process.exit(64);
  }
  const stageLabels = String(values["stage-labels"] ?? "");
  const stageSheet = String(values["stage-sheet"] ?? "");
  const dir = values["fixtures-dir"] ? String(values["fixtures-dir"]) : "";
  const inp: ParityInputs = dir
    ? inputsFromFixturesDir(dir, stageLabels, stageSheet)
    : {
        stageLabels,
        stageSheet,
        mainnetLabels: String(values["mainnet-labels"] ?? ""),
        productionSheet: String(values["production-sheet"] ?? ""),
      };
  if (!stageLabels || !stageSheet || (!dir && (!inp.mainnetLabels || !inp.productionSheet))) {
    console.error(USAGE);
    process.exit(64);
  }
  const r = runParity(inp);
  for (const m of r.messages) (r.ok ? console.log : console.error)(m);
  process.exit(r.ok ? 0 : 1);
}
