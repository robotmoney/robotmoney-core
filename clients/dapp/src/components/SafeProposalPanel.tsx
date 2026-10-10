// Canonical: docs/technical/dapp-credential-decisions.md §3.2 (Safe-signable admin proposals), §3.3

/**
 * SafeProposalPanel — "Create Safe proposal" (core 1544).
 *
 * Replaces the direct wallet transaction for an admin action. After the timelock
 * handover only the Safe acts through the timelock, so this panel builds
 * `timelock.schedule(...)` (or `timelock.execute(...)`) wrapped as a SafeTx and
 * asks the connected owner wallet to sign its EIP-712 typed data with
 * `eth_signTypedData_v4`. It never uses `eth_sign`, `personal_sign` or raw calldata
 * signing, and it holds no key. The signature bundle is exported as
 * `robotmoney-safe-tx/1` JSON, a second owner's bundle is imported, and once the
 * Safe threshold is reached any connected wallet may send `execTransaction`.
 *
 * It refuses before it asks the wallet when: the Safe or timelock address is not
 * configured (no button at all), the Safe is not canonical SafeL2 v1.4.1, the
 * connected address is not a Safe owner, the Safe lacks PROPOSER_ROLE (schedule)
 * or EXECUTOR_ROLE (execute), or the local digest differs from
 * `Safe.getTransactionHash`. The dapp is not a Safe web app and runs no signer
 * service: exported bundles move between owners out of band.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { useGuardedWriteContract, useWriteChainGuard } from "../lib/useGuardedWriteContract";
import { WrongChainError } from "../lib/writeChainGuard";
import { getAddress, type Address, type Hex } from "viem";
import {
  SafeProposalError,
  ZERO_BYTES32,
  addSignature,
  buildSafeTx,
  encodeExecute,
  encodeSchedule,
  execTransactionArgs,
  exportBundle,
  importSignatures,
  newBundle,
  proposalSalt,
  recoverSigner,
  safeAbi,
  timelockOperationId,
  toSafeSignature,
  type SafeTxBuild,
  type SafeTxBundle,
  type TimelockOperation,
} from "../lib/safeProposal";
import {
  assessSafeContext,
  loadSafeContext,
  verifyDigestOnChain,
  type SafeChainReader,
  type SafeContext,
} from "../lib/safeProposalChain";

export type SafeProposalRequest =
  | {
      readonly kind: "schedule";
      readonly target: Address;
      /** The inner call the timelock performs on `target` (what the preview decoded). */
      readonly data: Hex;
      readonly action: string;
      readonly description: string;
    }
  | {
      readonly kind: "execute";
      readonly target: Address;
      readonly data: Hex;
      readonly predecessor: Hex;
      readonly salt: Hex;
      readonly action: string;
      readonly description: string;
    };

type Props = Readonly<{
  /** Prefix for every data-testid; the primary button is `${testId}-submit`. */
  testId: string;
  safeAddress?: Address;
  timelockAddress?: Address;
  request: SafeProposalRequest;
}>;

interface Eip1193 {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
}

type PublicClientLike = NonNullable<ReturnType<typeof usePublicClient>>;

function toReader(pc: PublicClientLike): SafeChainReader {
  return {
    chainId: () => pc.getChainId(),
    getCode: (address) => pc.getCode({ address }),
    getStorageAt: (address, slot) => pc.getStorageAt({ address, slot }),
    read: (a) => pc.readContract(a as never),
  };
}

const lc = (s: string): string => s.toLowerCase();

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

interface Model {
  readonly op: TimelockOperation;
  readonly calldata: Hex;
  readonly build: SafeTxBuild;
  readonly operationId: Hex;
}

function makeModel(ctx: SafeContext, request: SafeProposalRequest): Model {
  const op: TimelockOperation =
    request.kind === "schedule"
      ? {
          target: request.target,
          data: request.data,
          predecessor: ZERO_BYTES32,
          salt: proposalSalt({
            chainId: ctx.chainId,
            safe: ctx.safe,
            nonce: ctx.nonce,
            target: request.target,
            data: request.data,
          }),
        }
      : {
          target: request.target,
          data: request.data,
          predecessor: request.predecessor,
          salt: request.salt,
        };
  const calldata =
    request.kind === "schedule" ? encodeSchedule(op, ctx.minDelay) : encodeExecute(op);
  const build = buildSafeTx({
    chainId: ctx.chainId,
    safe: ctx.safe,
    timelock: ctx.timelock,
    to: ctx.timelock,
    data: calldata,
    nonce: ctx.nonce,
  });
  return { op, calldata, build, operationId: timelockOperationId(op) };
}

export function SafeProposalPanel(props: Props) {
  if (!props.safeAddress || !props.timelockAddress) {
    const missing = !props.safeAddress
      ? "Safe address (VITE_SAFE_ADDRESS)"
      : "timelock address (VITE_TIMELOCK_ADDRESS)";
    return (
      <section
        data-testid={`${props.testId}-safe-blocked`}
        className="tx-preview tx-preview--refusal"
      >
        <h3>Safe proposal blocked</h3>
        <p data-testid={`${props.testId}-safe-blocked-reason`}>
          The {missing} is not configured for this deployment, so the dapp cannot build a Safe
          {" -> "}Timelock proposal and will not offer a signing button. Use the governance runbook.
        </p>
      </section>
    );
  }
  return (
    <ActiveSafeProposal
      testId={props.testId}
      request={props.request}
      safeAddress={props.safeAddress}
      timelockAddress={props.timelockAddress}
    />
  );
}

type ActiveProps = Readonly<{
  testId: string;
  safeAddress: Address;
  timelockAddress: Address;
  request: SafeProposalRequest;
}>;

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly ctx: SafeContext };

function ActiveSafeProposal(props: ActiveProps) {
  const { testId, safeAddress, timelockAddress, request } = props;
  const { address, connector } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useGuardedWriteContract();
  const chainGuard = useWriteChainGuard();
  const reader = useMemo(() => (publicClient ? toReader(publicClient) : undefined), [publicClient]);

  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [bundle, setBundle] = useState<SafeTxBundle | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [execHash, setExecHash] = useState<Hex | null>(null);
  const [execError, setExecError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<SafeContext | null> => {
    if (!reader) return null;
    try {
      const ctx = await loadSafeContext(reader, { safe: safeAddress, timelock: timelockAddress });
      setLoad({ status: "ready", ctx });
      return ctx;
    } catch (e) {
      setLoad({ status: "error", message: messageOf(e) });
      return null;
    }
  }, [reader, safeAddress, timelockAddress]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const model = useMemo(() => {
    if (load.status !== "ready") return null;
    try {
      return { ok: true as const, value: makeModel(load.ctx, request) };
    } catch (e) {
      return { ok: false as const, message: messageOf(e) };
    }
  }, [load, request]);

  const assessment =
    load.status === "ready"
      ? assessSafeContext(load.ctx, { account: address, kind: request.kind })
      : null;

  const submitLabel = "Create Safe proposal";

  async function onCreate() {
    if (!reader || !connector || !address) return;
    if (chainGuard.blocked) {
      // Signing the Safe typed data on the wrong chain is as unsafe as a write (issue 1729).
      setNotice(new WrongChainError(chainGuard.state).message);
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      // Re-read the chain at click time: the nonce, owners and roles may have moved.
      const ctx = await refresh();
      if (!ctx)
        throw new SafeProposalError(
          "BAD_INPUT",
          "Could not read the Safe. Nothing was sent to the wallet.",
        );
      const verdict = assessSafeContext(ctx, { account: address, kind: request.kind });
      if (!verdict.ok) {
        setNotice(verdict.reason);
        return;
      }
      const m = makeModel(ctx, request);
      await verifyDigestOnChain(reader, ctx, m.build);
      const provider = (await connector.getProvider()) as Eip1193;
      const raw = await provider.request({
        method: "eth_signTypedData_v4",
        params: [address, m.build.typedDataJson],
      });
      const signature = toSafeSignature(String(raw));
      const signer = await recoverSigner(m.build.safeTxHash, signature);
      if (lc(signer) !== lc(address)) {
        throw new SafeProposalError(
          "SIGNATURE_INVALID",
          `The wallet returned a signature from ${signer}, not from the connected ${address}.`,
        );
      }
      const base =
        bundle && lc(bundle.safe_tx_hash) === lc(m.build.safeTxHash)
          ? bundle
          : newBundle({
              chainId: ctx.chainId,
              safe: ctx.safe,
              timelock: ctx.timelock,
              to: ctx.timelock,
              data: m.calldata,
              nonce: ctx.nonce,
              safeTxHash: m.build.safeTxHash,
              action: request.action,
              description: request.description,
              operationId: m.operationId,
              minDelay: ctx.minDelay,
              threshold: ctx.threshold,
              owners: ctx.owners,
              proposedAt: new Date().toISOString(),
            });
      setBundle({
        ...base,
        signatures: addSignature(base.signatures, { owner: getAddress(address), signature }),
      });
    } catch (e) {
      setNotice(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function onImport() {
    setImportError(null);
    if (!model || !model.ok || load.status !== "ready") return;
    try {
      const ctx = load.ctx;
      const base =
        bundle ??
        newBundle({
          chainId: ctx.chainId,
          safe: ctx.safe,
          timelock: ctx.timelock,
          to: ctx.timelock,
          data: model.value.calldata,
          nonce: ctx.nonce,
          safeTxHash: model.value.build.safeTxHash,
          action: request.action,
          description: request.description,
          operationId: model.value.operationId,
          minDelay: ctx.minDelay,
          threshold: ctx.threshold,
          owners: ctx.owners,
          proposedAt: new Date().toISOString(),
        });
      setBundle(await importSignatures(base, importText));
      setImportText("");
    } catch (e) {
      setImportError(messageOf(e));
    }
  }

  async function onExecute() {
    setExecError(null);
    if (!bundle || !publicClient || !address) return;
    try {
      const ctx = await refresh();
      if (ctx && BigInt(bundle.nonce) !== ctx.nonce) {
        throw new SafeProposalError(
          "BUNDLE_INVALID",
          `Stale bundle: it was built for Safe nonce ${bundle.nonce}, the Safe is at nonce ${ctx.nonce}. Create the proposal again.`,
        );
      }
      const args = execTransactionArgs(bundle);
      const sim = await publicClient.simulateContract({
        address: bundle.safe,
        abi: safeAbi,
        functionName: "execTransaction",
        args,
        account: address,
      });
      const hash = await writeContractAsync(sim.request as never);
      await publicClient.waitForTransactionReceipt({ hash });
      setExecHash(hash);
      await refresh();
    } catch (e) {
      setExecError(messageOf(e));
    }
  }

  if (load.status === "loading") {
    return (
      <section data-testid={`${testId}-safe-loading`} className="tx-preview">
        <p className="hint">Reading the Safe and the timelock...</p>
      </section>
    );
  }
  if (load.status === "error") {
    return (
      <section data-testid={`${testId}-safe-error`} className="tx-preview tx-preview--refusal">
        <h3>Safe proposal blocked</h3>
        <p data-testid={`${testId}-safe-error-message`}>{load.message}</p>
      </section>
    );
  }

  const ctx = load.ctx;
  const refusal = notice ?? (assessment && !assessment.ok ? assessment.reason : null);
  const m = model && model.ok ? model.value : null;
  const bundleJson = bundle ? exportBundle(bundle) : "";
  const thresholdReached = bundle ? bundle.signatures.length >= bundle.threshold : false;

  return (
    <section data-testid={`${testId}-safe-proposal`} className="tx-preview">
      <h3>
        Safe {" -> "} Timelock proposal ({request.kind})
      </h3>
      <dl>
        <dt>Safe</dt>
        <dd data-testid={`${testId}-safe-address`}>{ctx.safe}</dd>
        <dt>Threshold</dt>
        <dd data-testid={`${testId}-safe-threshold`}>
          {ctx.threshold} of {ctx.owners.length}
        </dd>
        <dt>Owners</dt>
        <dd>
          <ul data-testid={`${testId}-safe-owners`}>
            {ctx.owners.map((o) => (
              <li key={o}>
                <code>{o}</code>
              </li>
            ))}
          </ul>
        </dd>
        <dt>Safe nonce</dt>
        <dd data-testid={`${testId}-safe-nonce`}>{ctx.nonce.toString()}</dd>
        <dt>Timelock</dt>
        <dd data-testid={`${testId}-timelock-address`}>{ctx.timelock}</dd>
        <dt>Min delay</dt>
        <dd data-testid={`${testId}-timelock-min-delay`}>{ctx.minDelay.toString()} seconds</dd>
        {m && (
          <>
            <dt>Salt</dt>
            <dd data-testid={`${testId}-timelock-salt`}>{m.op.salt}</dd>
            <dt>Predecessor</dt>
            <dd data-testid={`${testId}-timelock-predecessor`}>{m.op.predecessor}</dd>
            <dt>Operation id</dt>
            <dd data-testid={`${testId}-timelock-operation-id`}>{m.operationId}</dd>
            <dt>Safe transaction hash</dt>
            <dd data-testid={`${testId}-safe-tx-hash`}>{m.build.safeTxHash}</dd>
          </>
        )}
      </dl>
      {model && !model.ok && (
        <p className="error" data-testid={`${testId}-safe-refusal`}>
          {model.message}
        </p>
      )}
      {m && (
        <details data-testid={`${testId}-typed-data-details`}>
          <summary>EIP-712 typed data the wallet will sign (eth_signTypedData_v4)</summary>
          <pre data-testid={`${testId}-typed-data`}>
            {JSON.stringify(m.build.typedData, null, 2)}
          </pre>
        </details>
      )}
      {refusal && (
        <p className="error" data-testid={`${testId}-safe-refusal`}>
          {refusal}
        </p>
      )}
      <button
        type="button"
        data-testid={`${testId}-submit`}
        disabled={!m || !address || busy || (assessment !== null && !assessment.ok)}
        onClick={() => {
          void onCreate();
        }}
      >
        {submitLabel}
      </button>

      {bundle && (
        <div data-testid={`${testId}-bundle`}>
          <p data-testid={`${testId}-signature-count`}>
            Signatures: {bundle.signatures.length} of {bundle.threshold}
          </p>
          <label>
            Signature bundle (robotmoney-safe-tx/1)
            <textarea readOnly rows={8} data-testid={`${testId}-bundle-json`} value={bundleJson} />
          </label>
          <a
            data-testid={`${testId}-bundle-download`}
            download={`robotmoney-safe-tx-${bundle.nonce}.json`}
            href={`data:application/json;charset=utf-8,${encodeURIComponent(bundleJson)}`}
          >
            Download bundle
          </a>
        </div>
      )}

      <div>
        <label>
          Import another owner&apos;s bundle
          <textarea
            rows={4}
            data-testid={`${testId}-import-input`}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder="Paste a robotmoney-safe-tx/1 bundle or { signatures: [...] }"
          />
        </label>
        <button
          type="button"
          data-testid={`${testId}-import`}
          disabled={importText.trim() === "" || !m}
          onClick={() => {
            void onImport();
          }}
        >
          Import signatures
        </button>
        {importError && (
          <p className="error" data-testid={`${testId}-import-error`}>
            {importError}
          </p>
        )}
      </div>

      {bundle && thresholdReached && (
        <div data-testid={`${testId}-exec-section`}>
          <p className="hint">
            The Safe threshold is reached. Any connected wallet may send execTransaction; it needs
            gas only and is not a signer.
          </p>
          <button
            type="button"
            data-testid={`${testId}-exec`}
            disabled={!address || execHash !== null}
            onClick={() => {
              void onExecute();
            }}
          >
            Execute Safe transaction
          </button>
          {execHash && <p data-testid={`${testId}-exec-hash`}>Executed in {execHash}</p>}
          {execError && (
            <p className="error" data-testid={`${testId}-exec-error`}>
              {execError}
            </p>
          )}
          <details data-testid={`${testId}-handoff`}>
            <summary>Hand off to the publish-contracts Safe tool</summary>
            <code>
              bun publish-contracts/src/safe/cli.ts execute --rpc RPC_URL --chain-id {ctx.chainId}{" "}
              --bundle BUNDLE_FILE --signer keystore:PATH:PASSFILE
            </code>
          </details>
        </div>
      )}
    </section>
  );
}
