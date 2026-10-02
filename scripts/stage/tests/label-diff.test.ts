import { expect, test } from "bun:test";
import { labelDiff, parseLabels } from "../label-diff.ts";

test("identical sets have no difference, JSON and PASS/FAIL formats agree", () => {
  const stage = parseLabels('{"label":"safe.threshold","ok":true}\n{"label":"vault.rmUSDC.paused","ok":true}\n');
  const main = parseLabels("PASS safe.threshold\nPASS vault.rmUSDC.paused\nRESULT: VERIFIED\n");
  expect(labelDiff(stage, main)).toEqual({ onlyStage: [], onlyMainnet: [] });
});

test("a label only on one side is reported", () => {
  const d = labelDiff(["a", "b"], ["a", "c"]);
  expect(d.onlyStage).toEqual(["b"]);
  expect(d.onlyMainnet).toEqual(["c"]);
});
