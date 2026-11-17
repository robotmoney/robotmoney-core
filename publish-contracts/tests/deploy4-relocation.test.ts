import { expect, test } from "bun:test";
import { relocate } from "../../scripts/runbook/relocate-deploy4-v080.ts";

const record = () => ({ system: "fund", coreSha: "7c23569f85e96232fc75bbba32ebbd469da31966", proxy_upgrades: [
  { proxy_name: "fund", to_implementation: "0x1e69cc84b698b84129e3adb43ba6f59a242d040c", build: "/old", schedule_tx: "s", execute_tx: "e" },
  { proxy_name: "queue", to_implementation: "0x5e627b6e4402f753fb7ffa54a72897ed06a5018d", build: "/old", schedule_tx: "s", execute_tx: "e" },
] });
test("relocates only the known history and preserves its original paths", () => {
  const m = relocate(record(), "/new");
  expect(m.coreSha).toBe("7c23569f85e96232fc75bbba32ebbd469da31966");
  expect(m.proxy_upgrades.map((e: any) => [e.original_build, e.build])).toEqual([["/old", "/new"], ["/old", "/new"]]);
  expect(relocate(m, "/newer").proxy_upgrades[0].original_build).toBe("/old");
});
test("refuses unexpected deployment history", () => {
  const m = record();
  m.proxy_upgrades[0]!.to_implementation = "0xwrong";
  expect(() => relocate(m, "/new")).toThrow();
  expect(() => relocate({ ...record(), proxy_upgrades: [] }, "/new")).toThrow();
});
