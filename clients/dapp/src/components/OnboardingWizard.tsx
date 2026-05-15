/**
 * OnboardingWizard — first-run flow for wallets that have never authorized
 * an agent on this gateway. Three steps:
 *
 *   1. Bootstrap the agent runtime. The user picks OpenCode / OpenClaw /
 *      Claude Code and copies the matching paragraph from BOOTSTRAP.md
 *      into a fresh agent session. The agent downloads `rmpc`, writes its
 *      operator config, and prints its public address.
 *
 *   2. Paste the agent's address + shareReceiver + policy caps.
 *
 *   3. Preview and sign the on-chain `authorizeAgent` transaction.
 *      On success we mark this wallet registered (see useVaultRegistration)
 *      and unmount — AgentsPanel then renders the full AdminFlow.
 *
 * Browser-side keypair generation is intentionally NOT a supported path;
 * see docs/technical/dapp-credential-decisions.md §3.1.
 */
import { useState, type FormEvent } from "react";
import {
  useAccount,
  useChainId,
  useReadContract,
  useSimulateContract,
  useWriteContract,
} from "wagmi";
import { isAddress, type Address } from "viem";
import { gatewayAbi } from "../lib/abi";
import { buildPreview, type AdminAction, type PreviewContext } from "../lib/preview";
import { markRegistered } from "../lib/useVaultRegistration";
import { BOOTSTRAP_PROMPT, BOOTSTRAP_DOC_URL } from "../lib/bootstrapPrompts";
import { seedOnboardingUsdc, type SeedResult } from "../lib/onboardingSeed";
import { getInjectedProvider } from "../lib/syncDevnetChain";
import { PolicyFields } from "./PolicyFields";
import { TxPreview } from "./TxPreview";

type Props = Readonly<{
  gatewayAddress: Address;
  ctx: PreviewContext;
  /** Vite build env. Read here only to look up VITE_FAUCET_HARNESS_PRIVATE_KEY for the testnet seed step. */
  env: Record<string, string | undefined>;
  now: number;
  onDismiss?: () => void;
}>;

type Step = 1 | 2 | 3;

export function OnboardingWizard(props: Props) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { writeContract, isPending } = useWriteContract();
  const [seedResult, setSeedResult] = useState<SeedResult | null>(null);

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

  const [step, setStep] = useState<Step>(1);
  const [agent, setAgent] = useState("");
  const [shareReceiver, setShareReceiver] = useState("");
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

  const action: AdminAction | null =
    validAgent && validReceiver
      ? {
          kind: "authorizeAgent",
          agent: agent as Address,
          policy: {
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
          },
        }
      : null;

  const preview = action ? buildPreview(action, props.ctx) : null;

  const { data: sim } = useSimulateContract({
    address: props.gatewayAddress,
    abi: gatewayAbi,
    functionName: "authorizeAgent",
    args: action ? [action.agent, action.policy] : undefined,
    query: { enabled: step === 3 && isConnected && preview?.ok === true },
  });

  const onAuthorize = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!sim) return;
    writeContract(sim.request, {
      onSuccess: () => {
        if (!address) return;
        markRegistered(address);
        // Testnet/devnet only — seedOnboardingUsdc itself classifies the
        // active chain and returns `skipped-mainnet` on canonical mainnet
        // IDs, so this call is safe to issue unconditionally here.
        const usdcAddress = (usdcData as Address | undefined) ?? null;
        if (!usdcAddress || !isAddress(usdcAddress)) return;
        void seedOnboardingUsdc({
          chainId,
          recipient: address,
          usdcAddress,
          env: props.env,
          provider: getInjectedProvider(),
        }).then(setSeedResult);
      },
    });
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

      {step === 3 && (
        <section data-testid="wizard-step-3">
          <h2>Authorize the agent on-chain</h2>
          <p>
            This grants <code>AGENT_ROLE</code> on the gateway. Review the decoded transaction
            below, then sign with your wallet.
          </p>
          <form data-testid="wizard-authorize-form" onSubmit={onAuthorize}>
            {preview && <TxPreview preview={preview} />}
            <div className="wizard-nav">
              <button type="button" data-testid="step-3-back" onClick={() => setStep(2)}>
                Back
              </button>
              <button
                type="submit"
                data-testid="wizard-authorize-submit"
                disabled={!isConnected || !sim || isPending}
              >
                Sign authorizeAgent with wallet
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
