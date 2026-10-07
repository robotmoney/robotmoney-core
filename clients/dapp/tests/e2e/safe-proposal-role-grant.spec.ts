/**
 * Playwright E2E — Safe -> Timelock proposals from the dapp admin tabs (core 1544).
 *
 * Runs in the `safe-governance` project against the smoke-test full-stack devnet
 * on the Twin chain (918453): a real 2-of-3 SafeL2 v1.4.1 created through the
 * canonical factory, the real TimelockController, and the three encrypted Safe
 * owner keystores the harness minted. After the handover only the Safe acts
 * through the timelock, so the dapp builds a Safe-signable proposal instead of a
 * wallet transaction (docs/technical/dapp-credential-decisions.md §3.2).
 *
 * Covers, in order:
 *   1. digest parity: the safeTxHash the dapp renders equals Safe.getTransactionHash;
 *   2. a non-owner wallet is refused and no signature request reaches the provider;
 *   3. a DEPOSIT_PAUSER_ROLE grant is scheduled with two owner signatures (the
 *      first made in the dapp, the dapp-exported bundle imported through the
 *      publish-contracts Safe tool, the second signed there), time is advanced
 *      past getMinDelay, the dapp's execute proposal is signed by two owners in
 *      two browser contexts and executed through the Safe, and the role is
 *      held on chain and shown by the dapp.
 *
 * The role is DEPOSIT_PAUSER_ROLE, the gateway's deposit-pauser role.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createPublicClient,
  http,
  keccak256,
  parseAbi,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { test, expect } from "./helpers/fixtures";
import { loadEndpoints, type DevnetEndpoints } from "./helpers/devnet";
import { openDapp, openTab, type RpcRequest } from "./helpers/wallet";
import { loadOwnerKeys, runSafeCli, warpChain, type OwnerKey } from "./helpers/safeGovernance";

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const DEPOSIT_PAUSER_ROLE = keccak256(toBytes("DEPOSIT_PAUSER_ROLE"));

const safeAbi = parseAbi([
  "function nonce() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
]);
const timelockAbi = parseAbi([
  "function getMinDelay() view returns (uint256)",
  "function isOperationPending(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
]);
const gatewayAbi = parseAbi([
  "function hasRole(bytes32 role, address account) view returns (bool)",
]);

test.describe.configure({ mode: "serial" });

let endpoints: DevnetEndpoints;
let owners: OwnerKey[];
let chain: ReturnType<typeof createPublicClient>;
let ownerA: OwnerKey;
let ownerB: OwnerKey;

test.beforeAll(async () => {
  endpoints = loadEndpoints();
  owners = loadOwnerKeys(endpoints);
  chain = createPublicClient({ transport: http(endpoints.rpc_url) });
  const [a, b] = owners;
  if (!a || !b) throw new Error("the harness minted fewer than two Safe owner keystores");
  ownerA = a;
  ownerB = b;
  // Prove the precondition on chain: the keystores ARE the Safe's owners, threshold 2.
  const onchainOwners = (await chain.readContract({
    address: endpoints.safe_addr as Address,
    abi: safeAbi,
    functionName: "getOwners",
  })) as readonly Address[];
  for (const o of owners) {
    expect(onchainOwners.map((x) => x.toLowerCase())).toContain(o.address.toLowerCase());
  }
  expect(
    await chain.readContract({
      address: endpoints.safe_addr as Address,
      abi: safeAbi,
      functionName: "getThreshold",
    }),
  ).toBe(2n);
});

/** The typed data the dapp shows for a proposal, parsed. */
async function renderedTypedData(
  page: import("@playwright/test").Page,
  prefix: string,
): Promise<{ message: { to: Address; data: Hex; nonce: string } }> {
  const text = await page.getByTestId(`${prefix}-typed-data`).textContent();
  return JSON.parse(text ?? "{}") as { message: { to: Address; data: Hex; nonce: string } };
}

async function safeTxHashOnChain(message: { to: Address; data: Hex; nonce: string }): Promise<Hex> {
  return chain.readContract({
    address: endpoints.safe_addr as Address,
    abi: safeAbi,
    functionName: "getTransactionHash",
    args: [message.to, 0n, message.data, 0, 0n, 0n, 0n, ZERO, ZERO, BigInt(message.nonce)],
  });
}

test.describe("Safe -> Timelock proposal from the dapp admin tabs", () => {
  test("renders the Safe and timelock rows and a safeTxHash equal to Safe.getTransactionHash", async ({
    page,
  }) => {
    const signRequests: RpcRequest[] = [];
    await openDapp(page, endpoints, { privateKey: ownerA.privateKey, signRequests });
    await openTab(page, "pauser-role");
    await page
      .getByTestId("pauser-account-input")
      .fill(privateKeyToAccount(generatePrivateKey()).address);

    const button = page.getByTestId("grant-pauser-submit");
    await expect(button).toBeEnabled({ timeout: 90_000 });
    await expect(button).toHaveText("Create Safe proposal");

    // The harness prints lowercase addresses; the dapp renders EIP-55 checksummed ones.
    await expect(page.getByTestId("grant-pauser-safe-address")).toHaveText(
      new RegExp(`^${endpoints.safe_addr}$`, "i"),
    );
    await expect(page.getByTestId("grant-pauser-safe-threshold")).toHaveText("2 of 3");
    await expect(page.getByTestId("grant-pauser-timelock-address")).toHaveText(
      new RegExp(`^${endpoints.timelock_addr}$`, "i"),
    );
    const minDelay = await chain.readContract({
      address: endpoints.timelock_addr as Address,
      abi: timelockAbi,
      functionName: "getMinDelay",
    });
    await expect(page.getByTestId("grant-pauser-timelock-min-delay")).toContainText(
      minDelay.toString(),
    );
    for (const o of owners) {
      await expect(page.getByTestId("grant-pauser-safe-owners")).toContainText(o.address);
    }
    await expect(page.getByTestId("grant-pauser-timelock-salt")).toHaveText(/^0x[0-9a-f]{64}$/);
    await expect(page.getByTestId("grant-pauser-timelock-predecessor")).toHaveText(
      `0x${"00".repeat(32)}`,
    );
    await expect(page.getByTestId("grant-pauser-timelock-operation-id")).toHaveText(
      /^0x[0-9a-f]{64}$/,
    );

    const typed = await renderedTypedData(page, "grant-pauser");
    const dappHash = await page.getByTestId("grant-pauser-safe-tx-hash").textContent();
    expect(typed.message.to.toLowerCase()).toBe(endpoints.timelock_addr.toLowerCase());
    expect(dappHash).toBe(await safeTxHashOnChain(typed.message));
    // Rendering a proposal is not asking the wallet for anything.
    expect(signRequests).toHaveLength(0);
  });

  test("a non-owner wallet gets the refusal and no signature request reaches the provider", async ({
    page,
  }) => {
    const signRequests: RpcRequest[] = [];
    // admin_* is the harness USDC holder: a plain funded EOA, not a Safe owner.
    await openDapp(page, endpoints, { signRequests });
    await openTab(page, "pauser-role");
    await page
      .getByTestId("pauser-account-input")
      .fill(privateKeyToAccount(generatePrivateKey()).address);

    const refusal = page.getByTestId("grant-pauser-safe-refusal");
    await expect(refusal).toBeVisible({ timeout: 90_000 });
    await expect(refusal).toContainText("not an owner of the Safe");
    await expect(page.getByTestId("grant-pauser-submit")).toBeDisabled();
    expect(signRequests).toHaveLength(0);
  });

  test("schedules a DEPOSIT_PAUSER_ROLE grant with two owner signatures, then executes it through the Safe", async ({
    page,
    context,
    browser,
  }) => {
    test.setTimeout(20 * 60 * 1000);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "safe-proposal-e2e-"));
    const holderKey = generatePrivateKey();
    const holder = privateKeyToAccount(holderKey).address;
    const safe = endpoints.safe_addr as Address;
    const timelock = endpoints.timelock_addr as Address;
    const signA: RpcRequest[] = [];

    // ── 1. Owner A creates the schedule proposal in the dapp ────────────────
    await openDapp(page, endpoints, { privateKey: ownerA.privateKey, signRequests: signA });
    await openTab(page, "pauser-role");
    await page.getByTestId("pauser-account-input").fill(holder);
    const grant = page.getByTestId("grant-pauser-submit");
    await expect(grant).toBeEnabled({ timeout: 90_000 });
    const operationId = (await page
      .getByTestId("grant-pauser-timelock-operation-id")
      .textContent()) as Hex;
    const salt = (await page.getByTestId("grant-pauser-timelock-salt").textContent()) as Hex;
    const innerData = (await page
      .getByTestId("grant-pauser-preview-wrap")
      .getByTestId("tx-preview-calldata")
      .textContent()) as Hex;
    const dappHash = await page.getByTestId("grant-pauser-safe-tx-hash").textContent();
    await grant.click();
    await expect(page.getByTestId("grant-pauser-signature-count")).toContainText("1 of 2", {
      timeout: 60_000,
    });
    // Exactly one wallet request, and it was typed data.
    expect(signA.map((r) => r.method)).toEqual(["eth_signTypedData_v4"]);
    const bundleFromDapp = await page.getByTestId("grant-pauser-bundle-json").inputValue();
    const dappBundleFile = path.join(work, "dapp-bundle.json");
    fs.writeFileSync(dappBundleFile, bundleFromDapp);
    expect((JSON.parse(bundleFromDapp) as { format: string }).format).toBe("robotmoney-safe-tx/1");

    // ── 2. Hand off to the publish-contracts Safe tool ──────────────────────
    // The tool builds the same SafeTx from the same fields, imports the dapp's signature through
    // importSignatureBundle (which recovers it against THIS transaction hash), adds owner B's
    // keystore signature and sends execTransaction from owner C's keystore (gas only).
    const toolBundle = path.join(work, "tool-bundle.json");
    runSafeCli(endpoints, "propose", [
      "--safe",
      safe,
      "--timelock",
      timelock,
      "--action",
      "schedule",
      "--target",
      endpoints.gateway_addr,
      "--data",
      innerData,
      "--salt",
      salt,
      "--description",
      "dapp e2e: grant DEPOSIT_PAUSER_ROLE",
      "--out",
      toolBundle,
    ]);
    const proposed = JSON.parse(fs.readFileSync(toolBundle, "utf8")) as {
      safe_tx_hash: string;
      timelock_operation_id: string;
    };
    expect(proposed.safe_tx_hash).toBe(dappHash);
    expect(proposed.timelock_operation_id).toBe(operationId);
    runSafeCli(endpoints, "import", ["--bundle", toolBundle, "--signatures", dappBundleFile]);
    runSafeCli(endpoints, "sign", ["--bundle", toolBundle, "--signer", ownerB.signerSpec]);
    const third = owners.find((o) => o !== ownerA && o !== ownerB);
    if (!third) throw new Error("no third owner keystore to pay gas");
    runSafeCli(endpoints, "execute", ["--bundle", toolBundle, "--signer", third.signerSpec]);

    expect(
      await chain.readContract({
        address: timelock,
        abi: timelockAbi,
        functionName: "isOperationPending",
        args: [operationId],
      }),
    ).toBe(true);
    expect(
      await chain.readContract({
        address: endpoints.gateway_addr as Address,
        abi: gatewayAbi,
        functionName: "hasRole",
        args: [DEPOSIT_PAUSER_ROLE, holder],
      }),
    ).toBe(false);

    // ── 3. Advance time past getMinDelay (evm_increaseTime) ─────────────────
    const minDelay = await chain.readContract({
      address: timelock,
      abi: timelockAbi,
      functionName: "getMinDelay",
    });
    await warpChain(endpoints.rpc_url, Number(minDelay) + 5);

    // ── 4. The dapp's execute proposal, signed by owners A and B ────────────
    const execPrefix = `timelock-exec-${operationId}`;
    const pageA = await context.newPage();
    await openDapp(pageA, endpoints, { privateKey: ownerA.privateKey });
    await openTab(pageA, "timelock");
    const prepareA = pageA.getByTestId(`timelock-op-execute-${operationId}`);
    await expect(prepareA).toBeVisible({ timeout: 120_000 });
    await prepareA.click();
    await expect(pageA.getByTestId(`${execPrefix}-submit`)).toBeEnabled({ timeout: 90_000 });
    await pageA.getByTestId(`${execPrefix}-submit`).click();
    await expect(pageA.getByTestId(`${execPrefix}-signature-count`)).toContainText("1 of 2", {
      timeout: 60_000,
    });
    const execBundleA = await pageA.getByTestId(`${execPrefix}-bundle-json`).inputValue();

    const ctxB = await browser.newContext();
    try {
      const pageB = await ctxB.newPage();
      await openDapp(pageB, endpoints, { privateKey: ownerB.privateKey });
      await openTab(pageB, "timelock");
      const prepareB = pageB.getByTestId(`timelock-op-execute-${operationId}`);
      await expect(prepareB).toBeVisible({ timeout: 120_000 });
      await prepareB.click();
      await expect(pageB.getByTestId(`${execPrefix}-submit`)).toBeEnabled({ timeout: 90_000 });
      await pageB.getByTestId(`${execPrefix}-submit`).click();
      await expect(pageB.getByTestId(`${execPrefix}-signature-count`)).toContainText("1 of 2", {
        timeout: 60_000,
      });

      // Owner B imports owner A's bundle, reaching the threshold, and executes from any wallet.
      await pageB.getByTestId(`${execPrefix}-import-input`).fill(execBundleA);
      await pageB.getByTestId(`${execPrefix}-import`).click();
      await expect(pageB.getByTestId(`${execPrefix}-signature-count`)).toContainText("2 of 2", {
        timeout: 30_000,
      });
      await pageB.getByTestId(`${execPrefix}-exec`).click();
      await expect(pageB.getByTestId(`${execPrefix}-exec-hash`)).toBeVisible({ timeout: 120_000 });
    } finally {
      await ctxB.close();
    }

    // ── 5. The role is held on chain, and the dapp shows the holder ─────────
    await expect
      .poll(
        async () =>
          chain.readContract({
            address: endpoints.gateway_addr as Address,
            abi: gatewayAbi,
            functionName: "hasRole",
            args: [DEPOSIT_PAUSER_ROLE, holder],
          }),
        { timeout: 60_000 },
      )
      .toBe(true);
    expect(
      await chain.readContract({
        address: timelock,
        abi: timelockAbi,
        functionName: "isOperationDone",
        args: [operationId],
      }),
    ).toBe(true);

    const holderPage = await context.newPage();
    await openDapp(holderPage, endpoints, { privateKey: holderKey });
    await openTab(holderPage, "pause");
    await expect(holderPage.getByTestId("pause-role-status")).toContainText("yes", {
      timeout: 60_000,
    });
  });
});
