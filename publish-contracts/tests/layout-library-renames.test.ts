// PR 2042: the layout gate applies a reviewed library source-path rename (libraryRenames) to the deployed snapshot's library names only.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { layoutExtensionProblems, libraryRenames } from "../src/upgrade-rows.ts";

const REPO = join(import.meta.dir, "..", "..");
const OLD = "contracts/test/prototype/src/lib/FundAdminLib.sol:FundAdminLib";
const NEW = "contracts/lib/FundAdminLib.sol:FundAdminLib";
const layout = (libs: string[]) => ({ storage: [], structs: {}, namespaces: {}, libraries: libs });

describe("layout gate: reviewed library path renames (PR 2042)", () => {
  test("the committed renames map the old fund library path to the new one", () => {
    expect(libraryRenames(REPO)).toContainEqual(expect.objectContaining({ from: OLD, to: NEW }));
  });
  test("a reviewed rename extends a deployed snapshot that names the old path", () => {
    expect(layoutExtensionProblems(layout([OLD]), layout([NEW]), [], "RobotMoneyFund", libraryRenames(REPO))).toEqual([]);
  });
  test("an unlisted path change still fails", () => {
    const old = "contracts/unlisted/FundAdminLib.sol:FundAdminLib";
    expect(layoutExtensionProblems(layout([old]), layout([NEW]), [], "RobotMoneyFund", libraryRenames(REPO))).toEqual([`library ${old} is no longer linked`]);
  });
  test("without the renames the old path fails, as before", () => {
    expect(layoutExtensionProblems(layout([OLD]), layout([NEW]))).toEqual([`library ${OLD} is no longer linked`]);
  });
});
