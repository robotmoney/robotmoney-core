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
 *      when the connected wallet has zero balance for USDC, Base ETH, or
 *      RM tokens — removing the chicken-and-egg friction for brand-new
 *      wallets (issue #614). The button fires all three drip handlers in
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
 *         revealAuthorization(agent, salt, policy). On success we mark this
 *         wallet registered (see useVaultRegistration) and unmount.
 *
 * Browser-side keypair generation is intentionally NOT a supported path;
 * see docs/technical/dapp-credential-decisions.md §3.1.
 */
import { useState, type FormEvent } from "react";
import {
  useAccount,
  useBalance,
  useBlockNumber,
  useChainId,
  useReadContract,
  useWriteContract,
} from "wagmi";
import { isAddress, keccak256, encodeAbiParameters, type Address, type Hex } from "viem";
import { gatewayAbi, erc20Abi } from "../lib/abi";
import { buildPreview, type AdminAction, type AgentPolicy, type PreviewContext } from "../lib/preview";
import { markRegistered } from "../lib/useVaultRegistration";
import { BOOTSTRAP_PROMPT, BOOTSTRAP_DOC_URL } from "../lib/bootstrapPrompts";
import { seedOnboardingUsdc, type SeedResult } from "../lib/onboardingSeed";
import { getInjectedProvider } from "../lib/syncDevnetChain";
import {
  dripUsdc,
  dripEth,
  dripRmToken,
  readHarnessPrivateKey,
  type DripUsdcArgs,
  type DripEthArgs,
  type DripRmTokenArgs,
} from "../lib/faucetClient";
import { classifyChain } from "../lib/chainClassifier";
import { PolicyFields } from "./PolicyFields";
import { TxPreview } from "./TxPreview";

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
  /** RM token address. When provided, the drip button also drips RM tokens (issue #614). */
  rmTokenAddress?: Address;
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
  /**
   * Injected RM drip handler for tests. Production uses `dripRmToken` from faucetClient.
   * @internal
   */
  dripRmFn?: (args: DripRmTokenArgs) => Promise<Hex>;
}>;

type Step = 1 | 2 | 3;
type AuthPhase = "commit" | "reveal";

export function OnboardingWizard(props: Props) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { writeContract, isPending } = useWriteContract();
  const [seedResult, setSeedResult] = useState<SeedResult | null>(null);

  // Drip button state — per-asset status for step-1 inline feedback (issue #614).
  const [usdcDripStatus, setUsdcDripStatus] = useState<DripStatus>({ kind: "idle" });
  const [ethDripStatus, setEthDripStatus] = useState<DripStatus>({ kind: "idle" });
  const [rmDripStatus, setRmDripStatus] = useState<DripStatus>({ kind: "idle" });

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

  const { data: rmBalance } = useReadContract({
    address: props.rmTokenAddress ?? undefined,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId,
    query: { enabled: isConnected && !!props.rmTokenAddress && !!address, retry: 0 },
  });

  // Faucet drip button gate logic (issue #614):
  // - must be on testnet/devnet (classifyChain)
  // - must have a harness key in the build env
  // - button shows if any of USDC, ETH, or RM token balance is zero
  const harnessPrivateKey = readHarnessPrivateKey(props.env);
  const isTestnet = classifyChain(chainId) === "testnet";
  const usdcIsZero = usdcBalance !== undefined && (usdcBalance as bigint) === 0n;
  const ethIsZero = ethBalance !== undefined && ethBalance === 0n;
  const rmIsZero =
    props.rmTokenAddress !== undefined && rmBalance !== undefined && (rmBalance as bigint) === 0n;
  const anyBalanceZero = usdcIsZero || ethIsZero || rmIsZero;
  const showDripButton = isTestnet && !!harnessPrivateKey && anyBalanceZero;

  const isDripping =
    usdcDripStatus.kind === "pending" ||
    ethDripStatus.kind === "pending" ||
    rmDripStatus.kind === "pending";

  const onDrip = () => {
    if (!address || !harnessPrivateKey) return;
    const provider = getInjectedProvider();
    if (!provider) return;

    const dripUsdcHandler = props.dripUsdcFn ?? dripUsdc;
    const dripEthHandler = props.dripEthFn ?? dripEth;
    const dripRmHandler = props.dripRmFn ?? dripRmToken;

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

    // RM token drip
    if (props.rmTokenAddress) {
      setRmDripStatus({ kind: "pending" });
      void dripRmHandler({
        rmTokenAddress: props.rmTokenAddress,
        recipient: address,
        provider,
        harnessPrivateKey,
        chainId,
      })
        .then((hash) => setRmDripStatus({ kind: "success", hash }))
        .catch((err: unknown) => {
          const message =
            typeof err === "object" && err !== null && "shortMessage" in err
              ? String((err as { shortMessage: unknown }).shortMessage)
              : err instanceof Error
                ? err.message
                : String(err);
          setRmDripStatus({ kind: "error", message });
        });
    }
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
  const [salt, setSalt] = useState<Hex | null>(null);
  const [commitBlockNumber, setCommitBlockNumber] = useState<bigint | null>(null);

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

  const action: AdminAction | null =
    validAgent && validReceiver && policy
      ? {
          kind: "authorizeAgent",
          agent: agent as Address,
          policy,
        }
      : null;

  const preview = action ? buildPreview(action, props.ctx) : null;

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

  // Compute commitHash = keccak256(abi.encode(agent, caller, salt)).
  // Matches the on-chain computation in revealAuthorization.
  function computeCommitHash(agentAddr: Address, caller: Address, saltHex: Hex): Hex {
    return keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "bytes32" }],
        [agentAddr, caller, saltHex],
      ),
    );
  }

  // Generate a fresh random salt for use in the commit/reveal pair.
  function generateSalt(): Hex {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return ("0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")) as Hex;
  }

  const onCommit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!address || !validAgent) return;
    const newSalt = generateSalt();
    // Capture newSalt in closure so onSuccess can set it even before React
    // re-renders (React state updates are async).
    const actualHash = computeCommitHash(agent as Address, address, newSalt);
    writeContract(
      {
        address: props.gatewayAddress,
        abi: gatewayAbi,
        functionName: "commitAuthorization",
        args: [actualHash],
      },
      {
        onSuccess: () => {
          setSalt(newSalt);
          // Record the block we submitted in so reveal can wait for block+1.
          // We store currentBlock at commit time; the chain will advance.
          // Note: currentBlock may be undefined here if the subscription
          // hasn't fired yet — we use 0n as a safe lower bound (reveal will
          // wait for currentBlock > 0n, which is always true after 1 block).
          setCommitBlockNumber(currentBlock ?? 0n);
          setAuthPhase("reveal");
        },
      },
    );
  };

  const onReveal = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!salt || !action) return;
    writeContract(
      {
        address: props.gatewayAddress,
        abi: gatewayAbi,
        functionName: "revealAuthorization",
        args: [action.agent, salt, action.policy],
      },
      {
        onSuccess: () => {
          if (!address) return;
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
        },
      },
    );
  };

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
                  {props.rmTokenAddress && rmDripStatus.kind !== "idle" && (
                    <p
                      data-testid="onboarding-drip-rm-status"
                      data-status={rmDripStatus.kind}
                      className="hint"
                    >
                      {rmDripStatus.kind === "pending" && "RM token: dripping…"}
                      {rmDripStatus.kind === "success" &&
                        `RM token: sent (tx ${rmDripStatus.hash})`}
                      {rmDripStatus.kind === "error" &&
                        `RM token: failed — ${rmDripStatus.message}`}
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
          {preview && <TxPreview preview={preview} />}
          <form data-testid="wizard-commit-form" onSubmit={onCommit}>
            <div className="wizard-nav">
              <button type="button" data-testid="step-3-back" onClick={() => setStep(2)}>
                Back
              </button>
              <button
                type="submit"
                data-testid="wizard-commit-submit"
                disabled={!isConnected || isPending || !validAgent || !validReceiver}
              >
                Sign commit transaction
              </button>
            </div>
          </form>
        </section>
      )}

      {step === 3 && authPhase === "reveal" && (
        <section data-testid="wizard-step-3-reveal">
          <h2>Authorize the agent on-chain — step 2 of 2: reveal</h2>
          <p>
            Commitment confirmed. Waiting for one block to pass before the reveal can be
            submitted.{" "}
            {!revealReady && (
              <span data-testid="wizard-reveal-waiting">Waiting for next block…</span>
            )}
          </p>
          <form data-testid="wizard-reveal-form" onSubmit={onReveal}>
            <div className="wizard-nav">
              <button
                type="submit"
                data-testid="wizard-reveal-submit"
                disabled={!isConnected || isPending || !revealReady || !salt || !action}
              >
                Sign reveal transaction
              </button>
            </div>
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
