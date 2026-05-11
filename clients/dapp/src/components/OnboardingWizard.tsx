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
import { useAccount, useSimulateContract, useWriteContract } from "wagmi";
import { isAddress, type Address } from "viem";
import { gatewayAbi } from "../lib/abi";
import { buildPreview, type AdminAction, type PreviewContext } from "../lib/preview";
import { markRegistered } from "../lib/useVaultRegistration";
import { BOOTSTRAP_PROMPTS, type AgentRuntime } from "../lib/bootstrapPrompts";
import { PolicyFields } from "./PolicyFields";
import { TxPreview } from "./TxPreview";

type Props = Readonly<{
  gatewayAddress: Address;
  ctx: PreviewContext;
  now: number;
}>;

type Step = 1 | 2 | 3;

export function OnboardingWizard(props: Props) {
  const { address, isConnected } = useAccount();
  const { writeContract, isPending } = useWriteContract();

  const [step, setStep] = useState<Step>(1);
  const [runtime, setRuntime] = useState<AgentRuntime>("opencode");
  const [agent, setAgent] = useState("");
  const [shareReceiver, setShareReceiver] = useState("");
  const [validUntil, setValidUntil] = useState(() =>
    Math.floor(props.now / 1000 + 86400).toString(),
  );
  const [maxPerPayment, setMaxPerPayment] = useState("100000000");
  const [maxPerWindow, setMaxPerWindow] = useState("1000000000");

  const validAgent = isAddress(agent);
  const validReceiver = isAddress(shareReceiver);

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
    writeContract(sim.request);
    if (address) markRegistered(address);
  };

  const activePrompt = BOOTSTRAP_PROMPTS.find((p) => p.id === runtime) ?? BOOTSTRAP_PROMPTS[0];
  if (!activePrompt) throw new Error("BOOTSTRAP_PROMPTS is empty");

  return (
    <main className="onboarding-wizard" data-testid="onboarding-wizard">
      <header>
        <h1>Set up your first agent</h1>
        <ol className="wizard-steps" data-testid="wizard-steps" aria-label="Onboarding progress">
          <li data-active={step === 1}>1. Bootstrap agent</li>
          <li data-active={step === 2}>2. Agent address &amp; policy</li>
          <li data-active={step === 3}>3. Authorize on-chain</li>
        </ol>
      </header>

      {step === 1 && (
        <section data-testid="wizard-step-1">
          <h2>Bootstrap your agent runtime</h2>
          <p>
            Pick the agent runtime you&apos;ll be using. Paste the prompt below into a fresh session
            of that agent. The agent will download <code>rmpc</code>, write its operator config, and
            print its public address — copy that address; you&apos;ll paste it on the next step.
          </p>
          <p className="hint">
            We never generate or hold private keys in the dapp. See <code>BOOTSTRAP.md</code> for
            the canonical copy of these prompts.
          </p>
          <label>
            Agent runtime
            <select
              data-testid="runtime-select"
              value={runtime}
              onChange={(e) => setRuntime(e.target.value as AgentRuntime)}
            >
              {BOOTSTRAP_PROMPTS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <pre data-testid="bootstrap-prompt" className="bootstrap-prompt">
            {activePrompt.prompt}
          </pre>
          <button
            type="button"
            data-testid="copy-prompt"
            onClick={() => navigator.clipboard?.writeText(activePrompt.prompt)}
          >
            Copy prompt
          </button>
          <div className="wizard-nav">
            <button type="button" data-testid="step-1-next" onClick={() => setStep(2)}>
              I&apos;ve started the agent — next
            </button>
          </div>
        </section>
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
        </section>
      )}
    </main>
  );
}
