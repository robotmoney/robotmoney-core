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
 *   3. Owner-consented registration (issue 1890). Every wallet takes the same
 *      sequence; the gateway has no admin shortcut:
 *      a. The inputs are frozen (agent, policy, salt, wallet, chain).
 *      b. An agent other than this wallet consents first: it commits the
 *         consent hash shown on screen from its own key. The wizard reads that
 *         commitment from the gateway and keeps the owner commit disabled until
 *         it is there (`AgentConsentNotice`, `RegistrationSteps`).
 *      c. This wallet commits (commitAuthorization), then reveals
 *         (revealAuthorization) one block later and within 256 blocks of both
 *         commitments. Once the reveal receipt says success (never on wallet
 *         acceptance alone, QA plan U5) we mark this wallet registered (see
 *         useVaultRegistration).
 *      Each step previews the call it signs, built from the frozen inputs the
 *      write uses (QA plan U4). Any edit after the freeze disables every step.
 *
 * Browser-side keypair generation is intentionally NOT a supported path;
 * see docs/technical/dapp-credential-decisions.md §3.1.
 */
import { useEffect, useState } from "react";
import { useAccount, useBalance, useChainId, useReadContract } from "wagmi";
import { isAddress, type Address, type Hex } from "viem";
import { gatewayAbi, erc20Abi } from "../lib/abi";
import { type AgentPolicy, type PreviewContext } from "../lib/preview";
import { useConsentedRegistration } from "../lib/useConsentedRegistration";
import { markRegistered } from "../lib/useVaultRegistration";
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
import { RegistrationSteps, registrationIds } from "./RegistrationSteps";
import { DestinationPicker } from "./DestinationPicker";
import { tryDepositOnlyPolicy } from "../lib/agentDestinations";

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
  /** The Portfolio Router is never an agent destination. */
  routerAddress?: string;
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

const WIZARD_IDS = registrationIds("wizard");

export function OnboardingWizard(props: Props) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
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
  const [agent, setAgent] = useState("");
  const [shareReceiver, setShareReceiver] = useState("");
  // The owner's explicit vault selection. Nothing is pre-selected.
  const [destinations, setDestinations] = useState<string[]>([]);
  const [validUntil, setValidUntil] = useState(() =>
    Math.floor(props.now / 1000 + 86400).toString(),
  );
  const [maxPerPayment, setMaxPerPayment] = useState("100000000");
  const [maxPerWindow, setMaxPerWindow] = useState("1000000000");

  // strict: false — some wallets and rmpc print lowercase addresses without
  // EIP-55 checksum casing. The default strict check rejected those and left
  // "Next: review & sign" silently disabled.
  const validAgent = isAddress(agent, { strict: false });
  const validReceiver = isAddress(shareReceiver, { strict: false });

  const policy: AgentPolicy | null =
    validAgent && validReceiver
      ? tryDepositOnlyPolicy(
          {
            validUntil: BigInt(validUntil),
            maxPerPayment: BigInt(maxPerPayment),
            maxPerWindow: BigInt(maxPerWindow),
            shareReceiver: shareReceiver as Address,
            destinations,
          },
          props.routerAddress,
        )
      : null;

  // Every wallet takes the same consented sequence (issue 1890): the agent's consent, this
  // wallet's commit, then the reveal. The hook freezes the exact inputs first.
  const r = useConsentedRegistration({
    gatewayAddress: props.gatewayAddress,
    ctx: props.ctx,
    agent,
    policy,
  });
  const revealMined = r.revealMined;

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
          <DestinationPicker
            testIdPrefix="wizard-"
            selected={destinations}
            setSelected={setDestinations}
            routerAddress={props.routerAddress}
          />
          <div className="wizard-nav">
            <button type="button" data-testid="step-2-back" onClick={() => setStep(1)}>
              Back
            </button>
            <button
              type="button"
              data-testid="step-2-next"
              disabled={!validAgent || !validReceiver || policy === null}
              onClick={() => setStep(3)}
            >
              Next: review &amp; sign
            </button>
          </div>
        </section>
      )}

      {step === 3 && (
        <section data-testid="wizard-step-3">
          <h2>Authorize the agent on-chain</h2>
          <p>
            Every wallet registers an agent the same way, with no admin shortcut. First the agent
            consents from its own key. Then this wallet commits. Then, one block later, this wallet
            reveals. This wallet becomes the agent&apos;s owner and the share receiver.
          </p>
          <RegistrationSteps r={r} ids={WIZARD_IDS} />
          <div className="wizard-nav">
            <button type="button" data-testid="step-3-back" onClick={() => setStep(2)}>
              Back
            </button>
          </div>
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
