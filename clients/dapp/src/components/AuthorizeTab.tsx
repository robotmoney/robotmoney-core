// Canonical: docs/architecture.md §5.2 — Agent Permissions Gateway

import { useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { useAccount, useBlockNumber, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { isAddress, keccak256, encodeAbiParameters, type Address, type Hex } from "viem";
import { gatewayAbi } from "../lib/abi";
import {
  buildPreview,
  type AdminAction,
  type AgentPolicy,
  type PreviewContext,
} from "../lib/preview";
import { markRegistered } from "../lib/useVaultRegistration";
import { TxPreview } from "./TxPreview";
import { PolicyFields } from "./PolicyFields";

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
  const { writeContract, isPending } = useWriteContract();

  const [authPhase, setAuthPhase] = useState<AuthPhase>("commit");
  const [salt, setSalt] = useState<Hex | null>(null);
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

  const action: AdminAction | null =
    validAgent && validReceiver && policy
      ? {
          kind: "authorizeAgent",
          agent: props.agent as Address,
          policy,
        }
      : null;

  const preview = action ? buildPreview(action, props.ctx) : null;

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
    return ("0x" +
      Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")) as Hex;
  }

  const onCommit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!address || !validAgent) return;
    const newSalt = generateSalt();
    const actualHash = computeCommitHash(props.agent as Address, address, newSalt);
    writeContract(
      {
        address: props.gatewayAddress,
        abi: gatewayAbi,
        functionName: "commitAuthorization",
        args: [actualHash],
      },
      {
        onSuccess: (txHash) => {
          setSalt(newSalt);
          setCommitTxHash(txHash);
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
        <button
          type="submit"
          data-testid="authorize-reveal-submit"
          disabled={!isConnected || isPending || !revealReady || !salt || !action}
        >
          Sign reveal transaction
        </button>
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
      {preview && <TxPreview preview={preview} />}
      <button
        type="submit"
        data-testid="authorize-submit"
        disabled={!isConnected || !validAgent || !validReceiver || isPending}
      >
        Sign commit transaction
      </button>
    </form>
  );
}
