import { expect, test } from "bun:test";
import { checkRows, parseRows } from "../govern-rows.ts";

const h = (c: string) => "0x" + c.repeat(64);

test("every row with a tx hash and status 1 passes", () => {
  const out = [
    "noise",
    JSON.stringify({ row: "set-quorum", txHash: h("a"), status: 1 }),
    JSON.stringify({ row: "set-voting-power", txHash: h("b"), status: "0x1" }),
  ].join("\n");
  expect(checkRows(parseRows(out))).toEqual([]);
});

test("a row without a tx hash fails", () => {
  const out = JSON.stringify({ row: "set-quorum", status: 1 });
  expect(checkRows(parseRows(out)).length).toBe(1);
});

test("a row with receipt status 0 fails", () => {
  const out = JSON.stringify({ row: "authorize-agent", txHash: h("c"), status: 0 });
  expect(checkRows(parseRows(out))[0]).toContain("status");
});

test("no rows at all fails", () => {
  expect(checkRows(parseRows("nothing\n")).length).toBe(1);
});
