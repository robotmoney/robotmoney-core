// Tests for scripts/runbook/receipt-payload.ts: the Twin's receipt payload, with an optional session id of another receipt.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ENVELOPE, payloadOf, weightsOf } from "./receipt-payload.ts";

const envelope = JSON.parse(readFileSync(ENVELOPE, "utf8")) as Record<string, unknown>;
const weights = weightsOf("USDC:9500,PROTO:500,RWA:0");

test("the weights are every bucket, agent_tokens at 0, summing to 10000", () => {
  expect(weights.map((w) => `${w.bucket}:${w.weight_bps}`)).toEqual(["agent_tokens:0", "conservative_defi_yield:9500", "protocol_tokens:500", "real_world_assets:0"]);
  expect(() => weightsOf("USDC:9000,PROTO:500,RWA:0")).toThrow("not 10000");
});

test("the payload keeps the envelope; --session-id replaces only the session, and the receipt id changes with it", () => {
  const same = JSON.parse(payloadOf(envelope, weights)) as Record<string, unknown>;
  expect(same.session_id).toBe(envelope.session_id);
  const other = payloadOf(envelope, weights, "00000000-0000-4000-8000-000000000c01");
  const o = JSON.parse(other) as Record<string, unknown>;
  expect(o.session_id).toBe("00000000-0000-4000-8000-000000000c01");
  expect(o.subject_id).toBe(envelope.subject_id);
  expect({ ...o, session_id: envelope.session_id }).toEqual(same);
  expect(other.endsWith("}\n") && !other.endsWith("}\n\n")).toBe(true);
  expect(() => payloadOf(envelope, weights, "not-a-uuid")).toThrow("version 4 UUID");
});

test("the v0.6.0 upgrade flow records a receipt of another session than the envelope's", () => {
  const y = readFileSync(new URL("../../docs/runbooks/contract-qa/releases/v0.6.0.yaml", import.meta.url), "utf8");
  const step = y.slice(y.indexOf('id: "P8.19-v050-receipt-payload"'), y.indexOf('id: "P8.20-'));
  expect(step).toContain('"--session-id", "00000000-0000-4000-8000-000000000c01"');
  expect(String(envelope.session_id)).not.toBe("00000000-0000-4000-8000-000000000c01");
});
