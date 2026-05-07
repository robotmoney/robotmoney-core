/**
 * Playwright E2E — fork-anvil round-trip + scripted `rmpc self-check`.
 *
 * Acceptance criterion source: issue #85.
 *
 * Flow:
 *   1. The harness (clients/dapp/scripts/run-fork-roundtrip.sh) boots
 *      anvil locally, deploys the gateway via `forge script Deploy.s.sol`,
 *      builds rmpc + rmpc-keystore-import, mints a keystore for the
 *      pre-funded anvil agent EOA, and writes an rmpc.toml. All of
 *      those paths/addresses are forwarded into this spec via env
 *      vars (ROUNDTRIP_*).
 *   2. The Playwright spec drives the dapp UI to authorize the agent
 *      against the deployed gateway, polls the RPC until the on-chain
 *      AGENT_ROLE bit is set, then revokes the agent and polls again
 *      until the role is cleared.
 *   3. After the revoke confirms, the spec shells out to `rmpc
 *      self-check` and asserts:
 *        - exit code 2 (EXIT_PREFLIGHT_FAIL — see clients/rust-payment-
 *          client/src/commands/self_check.rs)
 *        - stdout JSON `error` field equals `"ErrAgentNotAuthorized"`
 *      — i.e. the documented refusal path.
 *   4. As a negative-control (also automated), the spec re-authorizes
 *      the agent and asserts `rmpc self-check` exits 0 — proving the
 *      refusal in step 3 was caused by the revoke and not by some
 *      unrelated misconfiguration in the harness.
 *
 * The whole spec is gated by ROUNDTRIP_ENABLED=1. Without that flag
 * the test is skipped so the existing default `pnpm test:e2e` run
 * (which boots only a bare anvil with no gateway deployed) stays
 * green.
 */
import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

// Anvil pre-funded agent — account[1]. Address derived from the
// deterministic anvil mnemonic; matches the private key the harness
// imports into the rmpc keystore.
const AGENT_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
// Anvil account[2] — share-receiver in the authorize policy.
const SHARE_RECEIVER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

// Required env (all set by clients/dapp/scripts/run-fork-roundtrip.sh).
const ENABLED = process.env.ROUNDTRIP_ENABLED === "1";
const RPC_URL = process.env.ROUNDTRIP_RPC_URL ?? "http://127.0.0.1:8545";
const GATEWAY_ADDRESS = process.env.ROUNDTRIP_GATEWAY_ADDRESS ?? "";
const RMPC_BIN = process.env.ROUNDTRIP_RMPC_BIN ?? "";
const RMPC_CONFIG = process.env.ROUNDTRIP_RMPC_CONFIG ?? "";
const RMPC_PASSPHRASE = process.env.ROUNDTRIP_RMPC_PASSPHRASE ?? "";

// Documented exit codes from clients/rust-payment-client/src/commands/self_check.rs
const SELF_CHECK_EXIT_OK = 0;
const SELF_CHECK_EXIT_PREFLIGHT_FAIL = 2;

// keccak256("AGENT_ROLE") — matches contracts/gateway/AccessRoles.sol
// (`bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE")`). We
// could `eth_call` `AGENT_ROLE()` to read it from the deployed gateway,
// but that adds an extra round-trip per role check; the constant is
// stable so we hard-code it and rely on a one-time sanity assertion in
// `beforeAll` to detect any contract-side drift.
const AGENT_ROLE = "0xcab5a0bfe0b79d2c4b1c2e02599fa044d115b7511f9659307cb4276950967709";

test.describe("fork-roundtrip — authorize, revoke, rmpc self-check refuses", () => {
  test.skip(!ENABLED, "ROUNDTRIP_ENABLED=1 not set; harness not booted.");

  test.beforeAll(async () => {
    // All harness-supplied envs are required when the gate is on.
    for (const [k, v] of Object.entries({
      ROUNDTRIP_GATEWAY_ADDRESS: GATEWAY_ADDRESS,
      ROUNDTRIP_RMPC_BIN: RMPC_BIN,
      ROUNDTRIP_RMPC_CONFIG: RMPC_CONFIG,
      ROUNDTRIP_RMPC_PASSPHRASE: RMPC_PASSPHRASE,
    })) {
      if (!v) throw new Error(`fork-roundtrip: required env ${k} is empty`);
    }
    // One-time drift assertion: read AGENT_ROLE() from the deployed
    // gateway so we fail loudly if the contract-side constant ever
    // changes (instead of silently always-false hasRole queries).
    // selector for AGENT_ROLE() == bytes4(keccak256("AGENT_ROLE()")) = 0x22459e18
    const onChain = await ethCall(RPC_URL, GATEWAY_ADDRESS, "0x22459e18");
    if (onChain.toLowerCase() !== AGENT_ROLE.toLowerCase()) {
      throw new Error(`AGENT_ROLE constant drift: hard-coded ${AGENT_ROLE}, on-chain ${onChain}`);
    }
  });

  test("authorize then revoke then self-check refuses then re-authorize then self-check accepts", async ({
    page,
  }) => {
    // ---- 1. Authorize via the dapp UI -------------------------------
    await page.goto("/");
    await page.getByTestId("connect-mock").click();
    await expect(page.getByTestId("connected-address")).toBeVisible();

    await page.getByTestId("agent-input").fill(AGENT_ADDRESS);
    await page.getByTestId("shareReceiver-input").fill(SHARE_RECEIVER);

    const authorizePreview = page.locator('[data-testid="tx-preview"][data-ok="true"]').first();
    await expect(authorizePreview).toBeVisible();

    await page.getByTestId("authorize-submit").click();

    // Wait for AGENT_ROLE to flip on-chain. The wagmi mock connector
    // routes `eth_sendTransaction` to the unlocked anvil account, so
    // anvil mines the tx synchronously — but we still poll because
    // the dapp queues the broadcast inside a wagmi mutation tick.
    await waitUntilHasRole({
      rpc: RPC_URL,
      role: AGENT_ROLE,
      account: AGENT_ADDRESS,
      expect: true,
    });

    // ---- 2. Revoke via the dapp UI ----------------------------------
    await page.getByTestId("revoke-submit").click();
    await waitUntilHasRole({
      rpc: RPC_URL,
      role: AGENT_ROLE,
      account: AGENT_ADDRESS,
      expect: false,
    });

    // ---- 3. rmpc self-check must refuse with ErrAgentNotAuthorized --
    const refusal = runSelfCheck();
    expect(refusal.code).toBe(SELF_CHECK_EXIT_PREFLIGHT_FAIL);
    const refusalJson = parseJsonStrict(refusal.stdout);
    expect(refusalJson.ok).toBe(false);
    expect(refusalJson.error).toBe("ErrAgentNotAuthorized");

    // ---- 4. Re-authorize and confirm self-check now accepts (the ----
    //         negative-control half of the AC).
    await page.getByTestId("authorize-submit").click();
    await waitUntilHasRole({
      rpc: RPC_URL,
      role: AGENT_ROLE,
      account: AGENT_ADDRESS,
      expect: true,
    });

    const accept = runSelfCheck();
    expect(accept.code).toBe(SELF_CHECK_EXIT_OK);
    const acceptJson = parseJsonStrict(accept.stdout);
    expect(acceptJson.ok).toBe(true);
    expect(acceptJson.error).toBeUndefined();
  });
});

// -- helpers ---------------------------------------------------------

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runSelfCheck(): RunResult {
  const out = spawnSync(RMPC_BIN, ["self-check", "--config", RMPC_CONFIG, "--pretty"], {
    env: {
      ...process.env,
      RMPC_KEYSTORE_PASSPHRASE: RMPC_PASSPHRASE,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  if (out.error) {
    throw new Error(`rmpc self-check spawn failed: ${out.error.message}`);
  }
  return {
    code: out.status ?? -1,
    stdout: out.stdout ?? "",
    stderr: out.stderr ?? "",
  };
}

function parseJsonStrict(stdout: string): {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
} {
  try {
    return JSON.parse(stdout);
  } catch (e) {
    throw new Error(
      `rmpc self-check stdout is not valid JSON: ${(e as Error).message}\n` +
        `stdout was:\n${stdout}`,
    );
  }
}

async function waitUntilHasRole(args: {
  rpc: string;
  role: string;
  account: string;
  expect: boolean;
}) {
  const deadline = Date.now() + 30_000;
  let last: boolean | null = null;
  while (Date.now() < deadline) {
    const has = await hasRole(args.rpc, args.role, args.account);
    last = has;
    if (has === args.expect) return;
    await sleep(500);
  }
  throw new Error(
    `timed out waiting for hasRole(${args.role.slice(0, 10)}…, ${args.account}) === ` +
      `${args.expect}; last observed value: ${last}`,
  );
}

async function hasRole(rpc: string, role: string, account: string): Promise<boolean> {
  // hasRole(bytes32,address) selector = 0x91d14854.
  const accountPadded = account.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const rolePadded = role.toLowerCase().replace(/^0x/, "");
  const data = `0x91d14854${rolePadded}${accountPadded}`;
  const result = await ethCall(rpc, GATEWAY_ADDRESS, data);
  // Right-aligned bool: last hex char is 0 or 1.
  return /1$/.test(result.trim());
}

async function ethCall(rpc: string, to: string, data: string): Promise<string> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to, data }, "latest"],
  };
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`eth_call HTTP ${res.status}`);
  const j = (await res.json()) as { result?: string; error?: { message: string } };
  if (j.error) throw new Error(`eth_call error: ${j.error.message}`);
  return j.result ?? "0x";
}
