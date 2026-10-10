// Source scan (issue 1729): every write goes through useGuardedWriteContract.
// A module that reaches wagmi/viem write or signing APIs another way bypasses the
// wrong-chain guard. This is a static check, so it is deliberately strict: it
// fails on any import shape that could hide a write API, not only the obvious one.
// Runs in the vitest node project.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

/** The guard hook itself. The only module allowed to import wagmi's write hook. */
const GUARD = "lib/useGuardedWriteContract.ts";
/**
 * The faucet is refused on every mainnet-class chain (chainClassifier.ts, issue 261)
 * and the build refuses a faucet key on a mainnet bundle (buildEnvValidation.ts).
 */
const FAUCET = "lib/faucetClient.ts";
const RAW_API_ALLOWED = new Set([GUARD, FAUCET]);

/** Wagmi/viem names that send a transaction or ask the wallet to sign. */
const FORBIDDEN_NAMES = new Set([
  "writeContract",
  "writeContractAsync",
  "sendTransaction",
  "sendTransactionAsync",
  "sendRawTransaction",
  "signTypedData",
  "signMessage",
  "signTransaction",
  "useWriteContract",
  "useSendTransaction",
  "useSignMessage",
  "useSignTypedData",
  "useWalletClient",
  "createWalletClient",
  "getWalletClient",
  // Every other send/sign/write/client-returning export of wagmi 2.19 and viem (checked against the
  // installed exports): a client or sender from any of these can write without the guard.
  "writeContractSync",
  "sendTransactionSync",
  "sendCalls",
  "sendCallsSync",
  "deployContract",
  "getClient",
  "getConnectorClient",
  "walletActions",
  "useClient",
  "useConnectorClient",
  "useSendCalls",
  "useSendCallsSync",
  "useSendTransactionSync",
  "useWriteContracts",
  "useDeployContract",
]);

/** Whole packages that may not be imported outside the guard. The repo uses none of them today. */
const FORBIDDEN_PACKAGES = /^(@wagmi\/|ethers($|\/)|@ethersproject\/|web3($|\/))/;

/** Signing and sending JSON-RPC methods. */
const RAW_METHOD =
  /["'`](eth_sendTransaction|eth_sendRawTransaction|eth_signTransaction|eth_sign|personal_sign|eth_signTypedData(_v\d)?)["'`]/;

/**
 * Modules that touch the raw injected provider (`getInjectedProvider`, `getProvider()`,
 * `window.ethereum`). Each is READ-ONLY or chain-management except where noted.
 *   - lib/useGuardedWriteContract.ts: the guard itself, eth_getCode on the write target.
 *   - lib/syncDevnetChain.ts: wallet_addEthereumChain / wallet_switchEthereumChain.
 *   - lib/useGatewayVerifier.ts: eth_getCode.
 *   - DebugPage, DebugPanel, AgentsPanel: call syncDevnetChain (chain management only).
 *   - FaucetTabView, OnboardingWizard: the faucet path, refused on mainnet.
 *   - SafeProposalPanel: signs EIP-712 typed data. It checks the write guard
 *     (useWriteChainGuard) before it asks the wallet to sign.
 * Adding a module here is a review decision: say why in this comment.
 */
const RAW_PROVIDER_ALLOWED = new Set([
  GUARD,
  "lib/syncDevnetChain.ts",
  "lib/useGatewayVerifier.ts",
  "components/DebugPage.tsx",
  "components/DebugPanel.tsx",
  "components/AgentsPanel.tsx",
  "components/FaucetTabView.tsx",
  "components/OnboardingWizard.tsx",
  "components/SafeProposalPanel.tsx",
  FAUCET,
]);
/** Modules allowed to name a signing/sending RPC method. */
const RAW_METHOD_ALLOWED = new Set(["components/SafeProposalPanel.tsx", FAUCET]);

/** The exact set of modules that send transactions through the guarded hook. */
const KNOWN_WRITERS = [
  "components/AuthorizeTab.tsx",
  "components/DepositWithdrawTab.tsx",
  "components/GovernancePanel.tsx",
  "components/MultiVaultWithdrawalTab.tsx",
  "components/OnboardingWizard.tsx",
  "components/PauseFlow.tsx",
  "components/RevokeTab.tsx",
  "components/RouterDepositTab.tsx",
  "components/SafeProposalPanel.tsx",
  "components/VaultSelectorDepositTab.tsx",
  "lib/useRotationState.ts",
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const isWagmiOrViem = (spec: string) => /^(wagmi|viem)(\/|$)/.test(spec);

/** Problems with how one file imports wagmi/viem. Exported for the self-test. */
export function importViolations(rawText: string): string[] {
  const text = stripComments(rawText);
  const out: string[] = [];
  const statement = /\b(import|export)\b([^;'"`]*?)\bfrom\s*["']([^"']+)["']/g;
  for (const m of text.matchAll(statement)) {
    const [, kind, clause, spec] = m;
    if (FORBIDDEN_PACKAGES.test(spec)) out.push(`${kind} from ${spec}`);
    if (!isWagmiOrViem(spec)) continue;
    if (/^(wagmi|viem)\/actions\b/.test(spec)) out.push(`${kind} from ${spec}`);
    if (/\*\s*as\b/.test(clause)) out.push(`namespace ${kind} from ${spec}`);
    if (kind === "export" && !/^\s*type\b/.test(clause)) out.push(`re-export from ${spec}`);
    const named = /\{([^}]*)\}/.exec(clause);
    for (const part of (named?.[1] ?? "").split(",")) {
      const original = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        .trim();
      if (FORBIDDEN_NAMES.has(original)) out.push(`${original} from ${spec}`);
    }
  }
  // dynamic import() and require() of wagmi/viem or the forbidden packages, in any shape
  for (const m of text.matchAll(/\b(import|require)\s*\(\s*([^)]*)\)/g)) {
    if (/["'`](wagmi|viem|@wagmi|ethers)(\/|["'`])/.test(m[2]) || !/^["'`]/.test(m[2].trim())) {
      out.push(`${m[1]}(${m[2].trim()})`);
    }
  }
  // bare side-effect or default imports that pull a forbidden default name are not a thing; skip.
  return out;
}

describe("single guarded write path", () => {
  const files = walk(SRC).map((p) => [relative(SRC, p), readFileSync(p, "utf8")] as const);

  it("scans the source tree", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("no module outside the guard imports a wagmi/viem write or signing API in any shape", () => {
    const offenders = files
      .filter(([f]) => !RAW_API_ALLOWED.has(f))
      .flatMap(([f, s]) => importViolations(s).map((v) => `${f}: ${v}`));
    expect(offenders).toEqual([]);
  });

  it("no module outside the allowlist touches the raw wallet provider", () => {
    const offenders = files
      .filter(([f]) => !RAW_PROVIDER_ALLOWED.has(f))
      .filter(([, s]) =>
        /\b(getInjectedProvider|getProvider)\s*\(|window\s*\.\s*ethereum|globalThis\s*\.\s*ethereum/.test(
          stripComments(s),
        ),
      )
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it("no module outside the allowlist names a signing or sending RPC method", () => {
    const offenders = files
      .filter(([f]) => !RAW_METHOD_ALLOWED.has(f))
      .filter(([, s]) => RAW_METHOD.test(stripComments(s)))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it("the set of modules that write through the guarded hook is exactly the known list", () => {
    const writers = files
      .filter(([, s]) => /\buseGuardedWriteContract\s*\(/.test(stripComments(s)))
      .map(([f]) => f)
      .filter((f) => f !== GUARD)
      .sort();
    expect(writers).toEqual([...KNOWN_WRITERS].sort());
  });

  it("the scanner itself catches the evasions it exists for", () => {
    const bad = [
      `import { useWriteContract } from "wagmi";`,
      `import { useWriteContract as w } from "wagmi";`,
      `import { writeContract } from "wagmi/actions";`,
      `import * as wagmi from "wagmi";`,
      `import * as v from "viem";`,
      `export { useSendTransaction } from "wagmi";`,
      `export * from "viem";`,
      `const m = await import("wagmi");`,
      `const m = await import(name);`,
      `const m = require("viem");`,
      `import { createWalletClient } from "viem";`,
      `import { sendTransaction } from 'viem/actions';`,
      `import {\n  useSignTypedData,\n} from "wagmi";`,
      `import { useConnectorClient } from "wagmi";`,
      `import { useClient as c } from "wagmi";`,
      `import { useSendCalls } from "wagmi";`,
      `import { sendCallsSync } from "wagmi";`,
      `import { getConnectorClient } from "wagmi";`,
      `import { core } from "@wagmi/core";`,
      `import { ethers } from "ethers";`,
      `import { Wallet } from "@ethersproject/wallet";`,
      `const e = await import("ethers");`,
      `const w = require("@wagmi/core");`,
    ];
    for (const src of bad) expect(importViolations(src), src).not.toEqual([]);
    const good = [
      `import { useAccount, useReadContract } from "wagmi";`,
      `import { createPublicClient, type Address } from "viem";`,
      `// import { useWriteContract } from "wagmi";`,
      `export type { Address } from "viem";`,
    ];
    for (const src of good) expect(importViolations(src), src).toEqual([]);
  });
});
