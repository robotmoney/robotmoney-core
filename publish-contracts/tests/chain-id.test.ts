import { describe, expect, test } from "bun:test";
import { PublishError } from "../src/errors.ts";
import { assertChainIds, assertFloors, readRpcChainId } from "../src/floors.ts";
import { callerInputs, parseSheet } from "../src/sheet.ts";
import { sheetText } from "./fixtures.ts";

const sheet = (chain: string, expected = chain) => parseSheet(sheetText({ CHAIN_ID: chain, EXPECTED_CHAIN_ID: expected }));
const kind = (f: () => void): string | undefined => { try { f(); } catch (e) { return (e as PublishError).kind + ": " + (e as Error).message; } return undefined; };

describe("one chain-id source: the RPC", () => {
  test("a sheet CHAIN_ID that differs from the RPC chain id is refused", () => {
    const r = kind(() => assertChainIds({ rpcChainId: 8453, sheet: sheet("918453") }));
    expect(r).toContain("CHAIN");
    expect(r).toContain("differs from the chain id 8453 read from the RPC");
  });
  test("a sheet CHAIN_ID of 8453 against a Twin RPC is refused", () => {
    expect(kind(() => assertChainIds({ rpcChainId: 918453, sheet: sheet("8453") }))).toContain("CHAIN");
  });
  test("EXPECTED_CHAIN_ID is required: a sheet without it does not parse", () => {
    expect(() => parseSheet(sheetText({ EXPECTED_CHAIN_ID: null }))).toThrow(PublishError);
  });
  test("--chain must equal the RPC chain id", () => {
    expect(kind(() => assertChainIds({ rpcChainId: 918453, sheet: sheet("918453"), argChainId: 8453 }))).toContain("--chain");
    expect(kind(() => assertChainIds({ rpcChainId: 918453, sheet: sheet("918453"), argChainId: 918453 }))).toBeUndefined();
  });
  test("a matching chain id passes the full floor check", () => {
    expect(kind(() => assertFloors({ rpcChainId: 918453, sheet: sheet("918453"), caller: callerInputs({}) }))).toBeUndefined();
  });
  test("the chain id is read from the RPC with cast chain-id", async () => {
    const calls: string[][] = [];
    expect(await readRpcChainId(async (a) => { calls.push(a); return "918453\n"; })).toBe(918453);
    expect(calls).toEqual([["chain-id"]]);
    await expect(readRpcChainId(async () => "not a number")).rejects.toThrow(PublishError);
  });
});
