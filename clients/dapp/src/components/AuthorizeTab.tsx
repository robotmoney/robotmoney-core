// Canonical: docs/architecture.md §5.2 — Agent Permissions Gateway

import { useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { useAccount, useBlockNumber, useWaitForTransactionReceipt } from "wagmi";
import { useGuardedWriteContract } from "../lib/useGuardedWriteContract";
import { isAddress, type Address, type Hex } from "viem";
import { gatewayAbi } from "../lib/abi";
import { buildPreview, type AgentPolicy, type PreviewContext } from "../lib/preview";
import {
  commitAuthorizationCall,
  generateSalt,
  revealAuthorizationCall,
  type CommitInputs,
  type RevealInputs,
} from "../lib/commitReveal";
import { markRegistered } from "../lib/useVaultRegistration";
import { TxPreview } from "./TxPreview";
import { PolicyFields } from "./PolicyFields";
import { WriteStatus } from "./WriteStatus";

type AuthPhase = "commit" | "reveal";

type Props = Readonly<{
  gatewayAddress: Address;
  ctx: PreviewContext;
  agent: string;
  setAgent: Dispatch<SetStateAction<string>>;
  shareReceiver: string;
  setShareReceiver: Dispatch<SetStateAction<string>>;
  now: number;
}>;

export function AuthorizeTab(props: Props) {
  const { address, isConnected } = useAccount();
  const write = useGuardedWriteContract();
  const { writeContract, isPending } = write;

  const [authPhase, setAuthPhase] = useState<AuthPhase>("commit");
  // The salt the next commit uses. It exists before the commit so the commit
  // preview can show the exact commitHash the wallet will sign (QA plan U4).
  const [salt] = useState<Hex>(generateSalt);
  // What the commit bound, frozen when the wallet accepts it. The reveal
  // preview and the reveal write both read this one object.
  const [committed, setCommitted] = useState<RevealInputs | null>(null);
  // commitTxHash is set when the commit tx hash comes back from the wallet.
  // We wait for its receipt to get the actual on-chain block number, which
  // is used to gate the reveal (must be in a strictly later block).
  const [commitTxHash, setCommitTxHash] = useState<Hex | null>(null);

  const [validUntil, setValidUntil] = useState(() =>
    Math.floor(props.now / 1000 + 86400).toString(),
  );
  const [maxPerPayment, setMaxPerPayment] = useState("100000000");
  const [maxPerWindow, setMaxPerWindow] = useState("1000000000");

  // strict: false — accept lowercase addresses (rmpc + some wallets omit
  // EIP-55 checksum casing).
  const validAgent = isAddress(props.agent, { strict: false });
  const validReceiver = isAddress(props.shareReceiver, { strict: false });

  const policy: AgentPolicy | null =
    validAgent && validReceiver
      ? {
          active: true,
          validUntil: BigInt(validUntil),
          maxPerPayment: BigInt(maxPerPayment),
          maxPerWindow: BigInt(maxPerWindow),
          shareReceiver: props.shareReceiver as Address,
          allowedDestinations: [],
          assetRecipient: "0x0000000000000000000000000000000000000000" as Address,
          maxWithdrawPerPayment: 0n,
          maxWithdrawPerWindow: 0n,
          allowedSourceVaults: [],
        }
      : null;

  // Step 1 signs commitAuthorization; step 2 signs revealAuthorization. Each
  // preview is built from the same inputs its write uses (QA plan U4, DR-4).
  const commitInputs: CommitInputs | null =
    address && validAgent && policy
      ? { agent: props.agent as Address, committer: address, salt }
      : null;
  const revealInputs: RevealInputs | null =
    committed ?? (validAgent && policy ? { agent: props.agent as Address, salt, policy } : null);

  const commitPreview = commitInputs
    ? buildPreview({ kind: "commitAuthorization", ...commitInputs }, props.ctx)
    : null;
  const revealPreview = revealInputs
    ? buildPreview({ kind: "revealAuthorization", ...revealInputs }, props.ctx)
    : null;

  // Wait for the commit tx receipt to learn the exact block it mined in.
  // This is needed to correctly gate the reveal: the contract rejects reveals
  // in the same block as the commit (CommitmentTooRecent).
  const { data: commitReceipt } = useWaitForTransactionReceipt({
    hash: commitTxHash ?? undefined,
    query: { enabled: commitTxHash !== null },
  });

  // The block the commit actually mined in (from the receipt).
  const commitBlockNumber = commitReceipt?.blockNumber ?? null;

  // Current block number — polled while in reveal phase to detect when
  // at least one block has passed since the commit.
  const { data: currentBlock } = useBlockNumber({
    watch: authPhase === "reveal",
    query: { enabled: authPhase === "reveal" },
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
    // Freeze what this commit binds: a later edit of the shared agent field
    // must not change the reveal that follows it.
    const snapshot = revealInputs;
    writeContract(
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
    writeContract(
      {
        address: props.gatewayAddress,
        abi: gatewayAbi,
        ...revealAuthorizationCall(committed),
      },
      {
        onSuccess: () => {
          if (address) markRegistered(address);
        },
      },
    );
  };

  if (authPhase === "reveal") {
    return (
      <form data-testid="authorize-reveal-form" onSubmit={onReveal}>
        <h2>Authorize agent — step 2 of 2: reveal</h2>
        <p>
          {commitBlockNumber === null
            ? "Commit transaction submitted — waiting for it to mine…"
            : "Commitment confirmed. Waiting for one block to pass before the reveal can be submitted."}
          {!revealReady && (
            <span data-testid="authorize-reveal-waiting">
              {commitBlockNumber === null ? "Mining…" : "Waiting for next block…"}
            </span>
          )}
        </p>
        {/* The policy preview again, for the call this button signs (QA plan U4). */}
        {revealPreview && (
          <div data-testid="authorize-reveal-preview">
            <TxPreview preview={revealPreview} />
          </div>
        )}
        <button
          type="submit"
          data-testid="authorize-reveal-submit"
          disabled={
            !isConnected || isPending || !revealReady || !committed || revealPreview?.ok !== true
          }
        >
          Sign reveal transaction
        </button>
        {/* A refused or rejected reveal says why (QA plan U5, finding DR-9). */}
        <WriteStatus
          testId="authorize-reveal"
          label="Reveal"
          write={{ error: write.error, isPending }}
        />
      </form>
    );
  }

  return (
    <form data-testid="authorize-form" onSubmit={onCommit}>
      <h2>Authorize agent — step 1 of 2: commit</h2>
      <label>
        Agent address
        <input
          data-testid="agent-input"
          value={props.agent}
          onChange={(e) => props.setAgent(e.target.value)}
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
        shareReceiver={props.shareReceiver}
        setShareReceiver={props.setShareReceiver}
      />
      {commitPreview && (
        <div data-testid="authorize-commit-preview">
          <TxPreview preview={commitPreview} />
        </div>
      )}
      {revealPreview && (
        <div data-testid="authorize-next-reveal-preview">
          <p className="hint">
            Step 2 signs this reveal, with this policy, after the commit mines:
          </p>
          <TxPreview preview={revealPreview} />
        </div>
      )}
      <button
        type="submit"
        data-testid="authorize-submit"
        disabled={
          !isConnected ||
          !validAgent ||
          !validReceiver ||
          isPending ||
          commitPreview?.ok !== true ||
          revealPreview?.ok !== true
        }
      >
        Sign commit transaction
      </button>
      {/* A refused or rejected commit says why (QA plan U5, finding DR-9). */}
      <WriteStatus
        testId="authorize-commit"
        label="Commit"
        write={{ error: write.error, isPending }}
      />
    </form>
  );
}
