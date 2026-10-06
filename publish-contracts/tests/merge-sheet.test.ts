import { describe, expect, test } from "bun:test";
import { mergeSheet } from "../src/ci/merge-sheet.ts";
import { parseSheet } from "../src/sheet.ts";
import { exampleText } from "./fixtures.ts";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
describe("merge-sheet", () => {
  test("fragment names replace the template lines and the result parses", () => {
    const frag = `CHAIN_ID=918453\nADMIN_ADDRESS=${A(0x1111)}\nRECEIPT_ADMIN_ADDRESS=${A(0x1111)}\nPAUSER_ADDRESS=${A(0x2222)}\nEMERGENCY_ADDRESS=${A(0x3333)}\nAGENT_ADDRESS=${A(0x4444)}\n`
      + `VOTER_ADDRESSES=${A(0x5551)},${A(0x5552)}\nSAFE_OWNERS=${A(0x6661)},${A(0x6662)},${A(0x6663)}\nSAFE_THRESHOLD=2\n`;
    const out = mergeSheet(exampleText(), frag);
    expect(parseSheet(out).admin.toLowerCase()).toBe(A(0x1111));
    expect(out).not.toContain(A(0xa001));
  });
  test("an empty fragment is refused and a fragment that breaks the sheet fails in the parser", () => {
    expect(() => mergeSheet(exampleText(), "\n")).toThrow();
    expect(() => mergeSheet(exampleText(), "PRIVATE_KEY=0x01\n")).toThrow();
  });
});
