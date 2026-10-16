// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * OnboardingWizard — first-run flow for wallets that have never authorized
 * an agent on this gateway. Three steps:
 *
 *   1. Bootstrap the agent runtime. The user picks OpenCode / OpenClaw /
 *      Claude Code and copies the matching paragraph from BOOTSTRAP.md
 *      into a fresh agent session. The agent downloads `rmpc`, writes its
 *      operator config, and prints its public address.
 *
 *      On testnet/devnet, step 1 also shows a "Drip test assets" button
 *      when the connected wallet has zero balance for USDC or Base ETH —
 *      removing the chicken-and-egg friction for brand-new
 *      wallets (issue #614). The button fires both drip handlers in
 *      parallel and shows per-asset status feedback. The gate mirrors the
 *      FaucetTab: harness key must be present, chain must not be mainnet.
 *
 *   2. Paste the agent's address + shareReceiver + policy caps.
 *
 *   3. Two-step permissionless authorization (commit/reveal):
 *      a. Commit — generates a random salt, computes
 *         commitHash = keccak256(abi.encode(agent, caller, salt)), and calls
 *         commitAuthorization(commitHash). This does NOT require ADMIN_ROLE.
 *      b. Reveal — after at least one block has passed, calls
 *         revealAuthorization(agent, salt, policy). Once its
 *         receipt says success (never on wallet acceptance alone, QA plan U5)
 *         we mark this wallet registered (see useVaultRegistration) and
 *         unmount.
 *      An agent other than this wallet must consent (core 1791): the reveal
 *      screen shows the consent hash the agent commits from its own key
 *      (`AgentConsentNotice`) before the reveal can succeed.
 *      Each step previews the call it signs, built from the same inputs as
 *      the write (QA plan U4): the commit screen shows commitAuthorization and
 *      the reveal it leads to, and the reveal screen shows the reveal again.
 *
 * Browser-side keypair generation is intentionally NOT a supported path;
 * see docs/technical/dapp-credential-decisions.md §3.1.
 */
import { useEffect, useState, type FormEvent } from "react";
import {
  useAccount,
  useBalance,
  useBlockNumber,
  useChainId,
  useReadContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { useGuardedWriteContract } from "../lib/useGuardedWriteContract";
import { isAddress, type Address, type Hex } from "viem";
import { gatewayAbi, erc20Abi } from "../lib/abi";
import { buildPreview, type AgentPolicy, type PreviewContext } from "../lib/preview";
import {
  commitAuthorizationCall,
  computeConsentHash,
  generateSalt,
  policyTuple,
  revealAuthorizationCall,
  type CommitInputs,
  type RevealInputs,
} from "../lib/commitReveal";
import { markRegistered } from "../lib/useVaultRegistration";
import { AgentConsentNotice } from "./AgentConsentNotice";
import { BOOTSTRAP_PROMPT, BOOTSTRAP_DOC_URL } from "../lib/bootstrapPrompts";
import { seedOnboardingUsdc, type SeedResult } from "../lib/onboardingSeed";
import { getInjectedProvider } from "../lib/syncDevnetChain";
import {
  dripUsdc,
  dripEth,
  readHarnessPrivateKey,
  type DripUsdcArgs,
  type DripEthArgs,
} from "../lib/faucetClient";
import { classifyChain } from "../lib/chainClassifier";
import { PolicyFields } from "./PolicyFields";
import { TxPreview } from "./TxPreview";
import { WriteStatus } from "./WriteStatus";

type DripStatus =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "success"; hash: Hex }
  | { kind: "error"; message: string };

type Props = Readonly<{
  gatewayAddress: Address;
  ctx: PreviewContext;
  /** Vite build env. Read here only to look up VITE_FAUCET_HARNESS_PRIVATE_KEY for the testnet seed step. */
  env: Record<string, string | undefined>;
  now: number;
  onDismiss?: () => void;
  /**
   * Injected USDC drip handler for tests. Production uses `dripUsdc` from faucetClient.
   * @internal
   */
  dripUsdcFn?: (args: DripUsdcArgs) => Promise<Hex>;
  /**
   * Injected Base ETH drip handler for tests. Production uses `dripEth` from faucetClient.
   * @internal
   */
  dripEthFn?: (args: DripEthArgs) => Promise<Hex>;
}>;

type Step = 1 | 2 | 3;
type AuthPhase = "commit" | "reveal";

export function OnboardingWizard(props: Props) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  // One hook per step, so each step shows its own refusal and receipt (QA plan U5).
  const commitWrite = useGuardedWriteContract();
  const revealWrite = useGuardedWriteContract();
  const isPending = commitWrite.isPending || revealWrite.isPending;
  const [seedResult, setSeedResult] = useState<SeedResult | null>(null);

  // Drip button state — per-asset status for step-1 inline feedback (issue #614).
  const [usdcDripStatus, setUsdcDripStatus] = useState<DripStatus>({ kind: "idle" });
  const [ethDripStatus, setEthDripStatus] = useState<DripStatus>({ kind: "idle" });

  // Read the USDC contract address from the gateway so the seed drip
  // targets the same canonical token AdminFlow does. Enabled only once
  // the wallet is connected — otherwise wagmi noises about a missing
  // chain context.
  const { data: usdcData } = useReadContract({
    address: props.gatewayAddress,
    abi: gatewayAbi,
    functionName: "usdc",
    query: { enabled: isConnected },
  });

  const usdcAddress = (usdcData as Address | undefined) ?? null;

  // Balance checks for the connected wallet — used to decide whether the
  // "Drip test assets" button should render on step 1 (issue #614).
  const { data: usdcBalance } = useReadContract({
    address: usdcAddress ?? undefined,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId,
    query: { enabled: isConnected && !!usdcAddress && !!address, retry: 0 },
  });

  const { data: ethBalanceResult } = useBalance({
    address: address ?? undefined,
    chainId,
    query: { enabled: isConnected && !!address, retry: 0 },
  });
  const ethBalance = ethBalanceResult?.value;

  // Faucet drip button gate logic (issue #614):
  // - must be on testnet/devnet (classifyChain)
  // - must have a harness key in the build env
  // - button shows if the USDC or ETH balance is zero
  const harnessPrivateKey = readHarnessPrivateKey(props.env);
  const isTestnet = classifyChain(chainId) === "testnet";
  const usdcIsZero = usdcBalance !== undefined && (usdcBalance as bigint) === 0n;
  const ethIsZero = ethBalance !== undefined && ethBalance === 0n;
  const anyBalanceZero = usdcIsZero || ethIsZero;
  const showDripButton = isTestnet && !!harnessPrivateKey && anyBalanceZero;

  const isDripping = usdcDripStatus.kind === "pending" || ethDripStatus.kind === "pending";

  const onDrip = () => {
    if (!address || !harnessPrivateKey) return;
    const provider = getInjectedProvider();
    if (!provider) return;

    const dripUsdcHandler = props.dripUsdcFn ?? dripUsdc;
    const dripEthHandler = props.dripEthFn ?? dripEth;

    // USDC drip
    if (usdcAddress && isAddress(usdcAddress)) {
      setUsdcDripStatus({ kind: "pending" });
      void dripUsdcHandler({
        usdcAddress,
        recipient: address,
        provider,
        harnessPrivateKey,
        chainId,
      })
        .then((hash) => setUsdcDripStatus({ kind: "success", hash }))
        .catch((err: unknown) => {
          const message =
            typeof err === "object" && err !== null && "shortMessage" in err
              ? String((err as { shortMessage: unknown }).shortMessage)
              : err instanceof Error
                ? err.message
                : String(err);
          setUsdcDripStatus({ kind: "error", message });
        });
    }

    // Base ETH drip
    setEthDripStatus({ kind: "pending" });
    void dripEthHandler({
      recipient: address,
      provider,
      harnessPrivateKey,
      chainId,
    })
      .then((hash) => setEthDripStatus({ kind: "success", hash }))
      .catch((err: unknown) => {
        const message =
          typeof err === "object" && err !== null && "shortMessage" in err
            ? String((err as { shortMessage: unknown }).shortMessage)
            : err instanceof Error
              ? err.message
              : String(err);
        setEthDripStatus({ kind: "error", message });
      });
  };

  const [step, setStep] = useState<Step>(1);
  const [authPhase, setAuthPhase] = useState<AuthPhase>("commit");
  const [agent, setAgent] = useState("");
  const [shareReceiver, setShareReceiver] = useState("");
  const [validUntil, setValidUntil] = useState(() =>
    Math.floor(props.now / 1000 + 86400).toString(),
  );
  const [maxPerPayment, setMaxPerPayment] = useState("100000000");
  const [maxPerWindow, setMaxPerWindow] = useState("1000000000");

  // Commit/reveal state — persisted between the two sub-steps of step 3.
  // The salt exists before the commit so its preview shows the exact
  // commitHash; `committed` freezes what the commit bound for the reveal.
  const [salt] = useState<Hex>(generateSalt);
  const [committed, setCommitted] = useState<RevealInputs | null>(null);
  // commitTxHash is set when the commit tx hash comes back from the wallet.
  // We wait for its receipt to get the actual on-chain block number.
  const [commitTxHash, setCommitTxHash] = useState<Hex | null>(null);
  const [revealTxHash, setRevealTxHash] = useState<Hex | null>(null);

  // strict: false — some wallets and rmpc print lowercase addresses without
  // EIP-55 checksum casing. The default strict check rejected those and left
  // "Next: review & sign" silently disabled.
  const validAgent = isAddress(agent, { strict: false });
  const validReceiver = isAddress(shareReceiver, { strict: false });

  const policy: AgentPolicy | null =
    validAgent && validReceiver
      ? {
          active: true,
          validUntil: BigInt(validUntil),
          maxPerPayment: BigInt(maxPerPayment),
          maxPerWindow: BigInt(maxPerWindow),
          shareReceiver: shareReceiver as Address,
          allowedDestinations: [],
          assetRecipient: "0x0000000000000000000000000000000000000000" as Address,
          maxWithdrawPerPayment: 0n,
          maxWithdrawPerWindow: 0n,
          allowedSourceVaults: [],
        }
      : null;

  // Each preview is built from the same inputs its write uses (QA plan U4, DR-4).
  const commitInputs: CommitInputs | null =
    address && validAgent && policy ? { agent: agent as Address, committer: address, salt } : null;
  const revealInputs: RevealInputs | null =
    committed ?? (validAgent && policy ? { agent: agent as Address, salt, policy } : null);

  const commitPreview = commitInputs
    ? buildPreview({ kind: "commitAuthorization", ...commitInputs }, props.ctx)
    : null;
  const revealPreview = revealInputs
    ? buildPreview({ kind: "revealAuthorization", ...revealInputs }, props.ctx)
    : null;

  // Wait for the commit tx receipt to learn the exact block it mined in.
  // This is needed to correctly gate the reveal: the contract rejects reveals
  // in the same block as the commit (CommitmentTooRecent).
  const commitReceipt = useWaitForTransactionReceipt({
    hash: commitTxHash ?? undefined,
    query: { enabled: commitTxHash !== null },
  });
  const revealReceipt = useWaitForTransactionReceipt({
    hash: revealTxHash ?? undefined,
    query: { enabled: revealTxHash !== null },
  });
  const commitReverted = commitReceipt.data?.status === "reverted";
  const revealMined = revealReceipt.data?.status === "success";

  // The block the commit actually mined in (from the receipt). A reverted
  // commit recorded nothing, so it never opens the reveal.
  const commitBlockNumber = commitReverted ? null : (commitReceipt.data?.blockNumber ?? null);

  // Current block number — polled while on step 3 reveal phase to detect
  // when at least one block has passed since the commit.
  const { data: currentBlock } = useBlockNumber({
    watch: step === 3 && authPhase === "reveal",
    query: { enabled: step === 3 && authPhase === "reveal" },
  });

  // Reveal is safe once block.number > commitBlockNumber (at least one block).
  const revealReady =
    authPhase === "reveal" &&
    commitBlockNumber !== null &&
    currentBlock !== undefined &&
    currentBlock > commitBlockNumber;

  const onCommit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!commitInputs || !revealInputs || commitPreview?.ok !== true) return;
    // Captured in the closure: onSuccess freezes exactly what this commit bound.
    const snapshot = revealInputs;
    commitWrite.writeContract(
      {
        address: props.gatewayAddress,
        abi: gatewayAbi,
        ...commitAuthorizationCall(commitInputs),
      },
      {
        onSuccess: (txHash) => {
          setCommitted(snapshot);
          setCommitTxHash(txHash);
          setAuthPhase("reveal");
        },
      },
    );
  };

  const onReveal = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!committed || revealPreview?.ok !== true) return;
    revealWrite.writeContract(
      {
        address: props.gatewayAddress,
        abi: gatewayAbi,
        ...revealAuthorizationCall(committed),
      },
      { onSuccess: (txHash) => setRevealTxHash(txHash) },
    );
  };

  // Registered only once the reveal is mined (QA plan U5): a reveal the wallet
  // accepted but the chain reverted binds nothing, and the wizard stays up to
  // say so.
  const [registeredDone, setRegisteredDone] = useState(false);
  useEffect(() => {
    if (!revealMined || registeredDone || !address) return;
    setRegisteredDone(true);
    markRegistered(address);
    // Testnet/devnet only — seedOnboardingUsdc itself classifies the
    // active chain and returns `skipped-mainnet` on canonical mainnet
    // IDs, so this call is safe to issue unconditionally here.
    if (!usdcAddress || !isAddress(usdcAddress)) return;
    void seedOnboardingUsdc({
      chainId,
      recipient: address,
      usdcAddress,
      env: props.env,
      provider: getInjectedProvider(),
    }).then(setSeedResult);
  }, [revealMined, registeredDone, address, usdcAddress, chainId, props.env]);

  return (
    <main className="onboarding-wizard" data-testid="onboarding-wizard">
      <header>
        <div className="wizard-header-row">
          <h1>Set up your first agent</h1>
          {props.onDismiss && (
            <button
              type="button"
              data-testid="wizard-dismiss"
              className="wizard-dismiss"
              onClick={props.onDismiss}
              aria-label="Dismiss onboarding and open admin"
            >
              Dismiss Onboarding
            </button>
          )}
        </div>
        <ol className="wizard-steps" data-testid="wizard-steps" aria-label="Onboarding progress">
          <li data-active={step === 1}>1. Bootstrap agent</li>
          <li data-active={step === 2}>2. Agent address &amp; policy</li>
          <li data-active={step === 3}>3. Authorize on-chain</li>
        </ol>
      </header>

      {step === 1 && (
        <>
          <section data-testid="wizard-step-1">
            <h2>Bootstrap your agent</h2>
            <p>
              Paste the prompt below into a fresh session of any supported agent runtime. The agent
              will follow <a href={BOOTSTRAP_DOC_URL}>BOOTSTRAP.md</a> to install <code>rmpc</code>,
              write its operator config, and print its public address — copy that address;
              you&apos;ll paste it on the next step.
            </p>
            <pre data-testid="bootstrap-prompt" className="bootstrap-prompt">
              {BOOTSTRAP_PROMPT}
            </pre>
            <button
              type="button"
              data-testid="copy-prompt"
              onClick={() => navigator.clipboard?.writeText(BOOTSTRAP_PROMPT)}
            >
              Copy prompt
            </button>
            {showDripButton && (
              <div className="wizard-drip-section">
                <p className="hint">
                  Your wallet has zero balance for one or more required assets. Drip testnet assets
                  before you start.
                </p>
                <button
                  type="button"
                  data-testid="onboarding-drip-button"
                  disabled={isDripping}
                  onClick={onDrip}
                >
                  Drip test assets
                </button>
                <div className="wizard-drip-statuses">
                  {usdcDripStatus.kind !== "idle" && (
                    <p
                      data-testid="onboarding-drip-usdc-status"
                      data-status={usdcDripStatus.kind}
                      className="hint"
                    >
                      {usdcDripStatus.kind === "pending" && "USDC: dripping…"}
                      {usdcDripStatus.kind === "success" &&
                        `USDC: sent (tx ${usdcDripStatus.hash})`}
                      {usdcDripStatus.kind === "error" &&
                        `USDC: failed — ${usdcDripStatus.message}`}
                    </p>
                  )}
                  {ethDripStatus.kind !== "idle" && (
                    <p
                      data-testid="onboarding-drip-eth-status"
                      data-status={ethDripStatus.kind}
                      className="hint"
                    >
                      {ethDripStatus.kind === "pending" && "Base ETH: dripping…"}
                      {ethDripStatus.kind === "success" &&
                        `Base ETH: sent (tx ${ethDripStatus.hash})`}
                      {ethDripStatus.kind === "error" &&
                        `Base ETH: failed — ${ethDripStatus.message}`}
                    </p>
                  )}
                </div>
              </div>
            )}
            <div className="wizard-nav">
              <button type="button" data-testid="step-1-next" onClick={() => setStep(2)}>
                I&apos;ve started the agent — next
              </button>
            </div>
          </section>
          <p className="hint">
            We never generate or hold private keys in the dapp. Any vendor-specific nuances are
            documented inline in <code>BOOTSTRAP.md</code>.
          </p>
        </>
      )}

      {step === 2 && (
        <section data-testid="wizard-step-2">
          <h2>Paste the agent&apos;s public address</h2>
          <p>
            Once your agent has bootstrapped, it printed a public address (an <code>0x…</code>
            string). Paste it here along with the wallet that should receive rmUSDC shares, then set
            the policy caps.
          </p>
          <label>
            Agent address
            <input
              data-testid="wizard-agent-input"
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              placeholder="0x..."
            />
          </label>
          <PolicyFields
            validUntil={validUntil}
            setValidUntil={setValidUntil}
            maxPerPayment={maxPerPayment}
            setMaxPerPayment={setMaxPerPayment}
            maxPerWindow={maxPerWindow}
            setMaxPerWindow={setMaxPerWindow}
            shareReceiver={shareReceiver}
            setShareReceiver={setShareReceiver}
            testIdPrefix="wizard-"
          />
          <div className="wizard-nav">
            <button type="button" data-testid="step-2-back" onClick={() => setStep(1)}>
              Back
            </button>
            <button
              type="button"
              data-testid="step-2-next"
              disabled={!validAgent || !validReceiver}
              onClick={() => setStep(3)}
            >
              Next: review &amp; sign
            </button>
          </div>
        </section>
      )}

      {step === 3 && authPhase === "commit" && (
        <section data-testid="wizard-step-3">
          <h2>Authorize the agent on-chain — step 1 of 2: commit</h2>
          <p>
            This permissionless two-step flow does not require admin access. First, submit a
            commitment transaction. After it confirms, you will sign the reveal transaction in the
            next step.
          </p>
          {commitPreview && (
            <div data-testid="wizard-commit-preview">
              <TxPreview preview={commitPreview} />
            </div>
          )}
          {revealPreview && (
            <div data-testid="wizard-next-reveal-preview">
              <p className="hint">
                Step 2 signs this reveal, with this policy, after the commit mines:
              </p>
              <TxPreview preview={revealPreview} />
            </div>
          )}
          <form data-testid="wizard-commit-form" onSubmit={onCommit}>
            <div className="wizard-nav">
              <button type="button" data-testid="step-3-back" onClick={() => setStep(2)}>
                Back
              </button>
              <button
                type="submit"
                data-testid="wizard-commit-submit"
                disabled={
                  !isConnected ||
                  isPending ||
                  !validAgent ||
                  !validReceiver ||
                  commitPreview?.ok !== true ||
                  revealPreview?.ok !== true
                }
              >
                Sign commit transaction
              </button>
            </div>
            {/* A refused or rejected commit says why (QA plan U5, finding DR-9). */}
            <WriteStatus
              testId="wizard-commit"
              label="Commit"
              write={{ error: commitWrite.error, isPending: commitWrite.isPending }}
            />
          </form>
        </section>
      )}

      {step === 3 && authPhase === "reveal" && (
        <section data-testid="wizard-step-3-reveal">
          <h2>Authorize the agent on-chain — step 2 of 2: reveal</h2>
          <p>
            {commitBlockNumber === null
              ? "Commit transaction submitted — waiting for it to mine…"
              : "Commitment confirmed. Waiting for one block to pass before the reveal can be submitted."}
            {!revealReady && (
              <span data-testid="wizard-reveal-waiting">
                {commitBlockNumber === null ? "Mining…" : "Waiting for next block…"}
              </span>
            )}
          </p>
          {/* The policy preview again, for the call this button signs (QA plan U4). */}
          {revealPreview && (
            <div data-testid="wizard-reveal-preview">
              <TxPreview preview={revealPreview} />
            </div>
          )}
          {/* Core 1791: the agent consents from its own key to exactly this reveal. */}
          <AgentConsentNotice
            testId="wizard-consent-hash"
            hash={
              address && committed
                ? computeConsentHash(
                    address,
                    committed.agent,
                    committed.salt,
                    policyTuple(committed.policy),
                  )
                : null
            }
          />
          <form data-testid="wizard-reveal-form" onSubmit={onReveal}>
            <div className="wizard-nav">
              <button
                type="submit"
                data-testid="wizard-reveal-submit"
                disabled={
                  !isConnected ||
                  isPending ||
                  !revealReady ||
                  !committed ||
                  revealPreview?.ok !== true ||
                  revealTxHash !== null
                }
              >
                Sign reveal transaction
              </button>
            </div>
            {/* The commit's receipt (a reverted commit never opens the reveal) and the
                reveal's refusal, wallet error and receipt (QA plan U5, finding DR-9). */}
            <WriteStatus
              testId="wizard-commit"
              label="Commit"
              write={{ error: commitWrite.error, data: commitTxHash ?? undefined }}
              receipt={commitReceipt}
            />
            <WriteStatus
              testId="wizard-reveal"
              label="Reveal"
              write={{
                error: revealWrite.error,
                isPending: revealWrite.isPending,
                data: revealTxHash ?? undefined,
              }}
              receipt={revealReceipt}
            />
          </form>
          {seedResult && (
            <p
              data-testid="wizard-seed-result"
              data-seed-status={seedResult.status}
              className="hint"
            >
              {seedResult.status === "seeded" &&
                `Funded account with 100 USDC (tx ${seedResult.hash}).`}
              {seedResult.status === "skipped-mainnet" &&
                "Skipped USDC seed: connected wallet is on a mainnet chain."}
              {seedResult.status === "skipped-no-harness" &&
                "Skipped USDC seed: this build has no harness funding key."}
              {seedResult.status === "skipped-no-provider" &&
                "Skipped USDC seed: no injected wallet provider."}
              {seedResult.status === "failed" && `USDC seed failed: ${seedResult.message}`}
            </p>
          )}
        </section>
      )}
    </main>
  );
}
