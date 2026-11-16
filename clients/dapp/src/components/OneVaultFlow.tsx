// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isAddress, parseAbi, parseAbiItem, type Address, type Hash } from "viem";
import { useAccount, usePublicClient, useReadContract, useWaitForTransactionReceipt } from "wagmi";
import { useGuardedWriteContract } from "../lib/useGuardedWriteContract";
import { FLOW_QUEUE_TERMS_ABI } from "../lib/flowQueueTerms";
import { formatTokenBalance, parseTokenAmount } from "../lib/format";
import { FlowQueueTermsReadState } from "./FlowQueueTerms";
import { WriteStatus } from "./WriteStatus";

const abi = parseAbi([
  "function requestDeposit(uint256 usdc, address owner) returns (uint256)",
  "function requestRedeem(uint256 shares, address owner) returns (uint256)",
  "function cancel(uint256 requestId)",
  "function withdrawCredit() returns (uint256 usdc, uint256 shares)",
  "function creditOf(address owner) view returns (uint256 usdc, uint256 shares)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "function pendingDepositRequest(uint256 requestId, address controller) view returns (uint256)",
  "function claimableDepositRequest(uint256 requestId, address controller) view returns (uint256)",
  "function pendingRedeemRequest(uint256 requestId, address controller) view returns (uint256)",
  "function claimableRedeemRequest(uint256 requestId, address controller) view returns (uint256)",
  "function asset() view returns (address)",
  "function share() view returns (address)",
]);
const tokenAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const depositEvent = parseAbiItem(
  "event DepositRequested(uint256 indexed requestId, address indexed owner, address indexed sender, uint256 usdc, uint64 epoch)",
);
const redeemEvent = parseAbiItem(
  "event RedeemRequested(uint256 indexed requestId, address indexed owner, address indexed sender, uint256 shares, uint64 epoch)",
);

export function OneVaultFlow({
  queue,
  chainId,
  fromBlock,
}: {
  readonly queue: Address;
  readonly chainId: number;
  readonly fromBlock: bigint;
}) {
  const account = useAccount();
  const queryClient = useQueryClient();
  const client = usePublicClient({ chainId });
  const write = useGuardedWriteContract();
  const receipt = useWaitForTransactionReceipt({
    hash: write.data as Hash | undefined,
    query: { enabled: Boolean(write.data) },
  });
  useEffect(() => {
    if (receipt.data?.status === "success") void queryClient.invalidateQueries();
  }, [queryClient, receipt.data]);
  const [kind, setKind] = useState<"deposit" | "redeem">("deposit");
  const [amount, setAmount] = useState("");
  const [idInput, setIdInput] = useState("");
  const [requestIds, setRequestIds] = useState<readonly bigint[] | null>(null);
  const [requestsError, setRequestsError] = useState(false);
  const id = /^\d+$/.test(idInput) ? BigInt(idInput) : undefined;
  const enabled = account.isConnected && account.chainId === chainId && !!account.address;
  useEffect(() => {
    let active = true;
    setRequestIds(null);
    setRequestsError(false);
    if (!enabled || !client || !account.address) return;
    const owner = account.address;
    void (async () => {
      try {
        const head = await client.getBlockNumber();
        const found: bigint[] = [];
        for (let start = fromBlock; start <= head; start += 10000n) {
          const end = start + 9999n < head ? start + 9999n : head;
          const [deposits, redemptions] = await Promise.all([
            client.getLogs({
              address: queue,
              event: depositEvent,
              args: { owner },
              fromBlock: start,
              toBlock: end,
            }),
            client.getLogs({
              address: queue,
              event: redeemEvent,
              args: { owner },
              fromBlock: start,
              toBlock: end,
            }),
          ]);
          for (const log of [...deposits, ...redemptions])
            if (log.args.requestId !== undefined) found.push(log.args.requestId);
        }
        if (active) setRequestIds(found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
      } catch {
        if (active) setRequestsError(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [account.address, client, enabled, fromBlock, queue, receipt.data]);
  const asset = useReadContract({ address: queue, abi, functionName: "asset", query: { enabled } });
  const share = useReadContract({ address: queue, abi, functionName: "share", query: { enabled } });
  const token = kind === "deposit" ? asset.data : share.data;
  const shareDecimals = useReadContract({
    address: share.data,
    abi: tokenAbi,
    functionName: "decimals",
    query: { enabled: enabled && !!share.data },
  });
  const decimalsRead = useReadContract({
    address: token,
    abi: tokenAbi,
    functionName: "decimals",
    query: { enabled: enabled && !!token },
  });
  const value =
    decimalsRead.data === undefined
      ? undefined
      : (parseTokenAmount(amount, decimalsRead.data) ?? undefined);
  const allowance = useReadContract({
    address: token,
    abi: tokenAbi,
    functionName: "allowance",
    args: account.address ? [account.address, queue] : undefined,
    query: { enabled: enabled && !!token },
  });
  const quote = useReadContract({
    address: queue,
    abi: FLOW_QUEUE_TERMS_ABI,
    functionName: "quoteDeposit",
    args: [kind === "deposit" && value ? value : 0n],
    query: {
      enabled: enabled && kind === "deposit" && !!value,
      staleTime: 20_000,
      refetchInterval: 12_000,
    },
  });
  const live = useReadContract({
    address: queue,
    abi: FLOW_QUEUE_TERMS_ABI,
    functionName: "liveness",
    query: { enabled, staleTime: 20_000, refetchInterval: 12_000 },
  });
  const args = id !== undefined && account.address ? ([id, account.address] as const) : undefined;
  const credit = useReadContract({
    address: queue,
    abi,
    functionName: "creditOf",
    args: account.address ? [account.address] : undefined,
    query: { enabled },
  });
  const pd = useReadContract({
    address: queue,
    abi,
    functionName: "pendingDepositRequest",
    args,
    query: { enabled: enabled && !!args },
  });
  const cd = useReadContract({
    address: queue,
    abi,
    functionName: "claimableDepositRequest",
    args,
    query: { enabled: enabled && !!args },
  });
  const pr = useReadContract({
    address: queue,
    abi,
    functionName: "pendingRedeemRequest",
    args,
    query: { enabled: enabled && !!args },
  });
  const cr = useReadContract({
    address: queue,
    abi,
    functionName: "claimableRedeemRequest",
    args,
    query: { enabled: enabled && !!args },
  });
  const busy = write.isPending || receipt.isFetching;
  const goodTerms =
    !!quote.data &&
    !!live.data &&
    !quote.isError &&
    !live.isError &&
    !quote.isStale &&
    !live.isStale &&
    !live.data.queuePausedNow &&
    !live.data.depositsStoppedNow &&
    !live.data.windDownActive &&
    !quote.isFetching &&
    !live.isFetching;
  const ready =
    enabled &&
    !!value &&
    !busy &&
    !!token &&
    decimalsRead.data !== undefined &&
    !decimalsRead.isError;
  const send = (
    name:
      | "requestDeposit"
      | "requestRedeem"
      | "deposit"
      | "redeem"
      | "cancel"
      | "approve"
      | "withdrawCredit",
  ) => {
    if (!account.address || !enabled || busy) return;
    if (name === "withdrawCredit") {
      write.writeContract({ address: queue, abi, functionName: name, chainId });
      return;
    }
    if (name === "cancel") {
      if (id !== undefined)
        write.writeContract({ address: queue, abi, functionName: name, args: [id], chainId });
      return;
    }
    if (!value || !token) return;
    if (name === "approve") {
      write.writeContract({
        address: token,
        abi: tokenAbi,
        functionName: name,
        args: [queue, value],
        chainId,
      });
      return;
    }
    if (name === "redeem") {
      write.writeContract({
        address: queue,
        abi,
        functionName: name,
        args: [value, account.address, account.address],
        chainId,
      });
      return;
    }
    write.writeContract({
      address: queue,
      abi,
      functionName: name,
      args: [value, account.address],
      chainId,
    });
  };
  return (
    <section aria-label="One-vault flow">
      <h2>One-vault requests</h2>
      {!enabled && <p role="alert">Connect an account on the configured chain.</p>}
      <label>
        Action{" "}
        <select value={kind} onChange={(e) => setKind(e.target.value as "deposit" | "redeem")}>
          <option value="deposit">Deposit</option>
          <option value="redeem">Redeem</option>
        </select>
      </label>
      <label>
        Amount ({kind === "deposit" ? "USDC" : "shares"}){" "}
        <input value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      {kind === "deposit" && (
        <FlowQueueTermsReadState
          quote={quote.data}
          liveness={live.data}
          loading={quote.isLoading || live.isLoading}
          stale={quote.isStale || live.isStale || quote.isFetching || live.isFetching}
          error={quote.isError || live.isError}
        />
      )}
      <button
        type="button"
        disabled={
          !ready ||
          allowance.data === undefined ||
          allowance.isError ||
          allowance.isFetching ||
          allowance.data >= (value ?? 0n)
        }
        onClick={() => send("approve")}
      >
        Approve
      </button>
      <button
        type="button"
        disabled={
          !ready ||
          allowance.data === undefined ||
          allowance.isError ||
          allowance.isFetching ||
          allowance.data < (value ?? 0n) ||
          (kind === "deposit" && !goodTerms)
        }
        onClick={() => send(kind === "deposit" ? "requestDeposit" : "requestRedeem")}
      >
        Request {kind}
      </button>
      {enabled &&
        (requestsError ? (
          <p role="alert">Could not load your requests. Enter a request ID below.</p>
        ) : requestIds === null ? (
          <p>Loading your requests…</p>
        ) : (
          <div>
            <p>Your requests</p>
            {requestIds.length === 0 ? (
              <p>No requests found.</p>
            ) : (
              requestIds.map((requestId) => (
                <button
                  type="button"
                  key={requestId.toString()}
                  onClick={() => setIdInput(requestId.toString())}
                >
                  Request {requestId.toString()}
                </button>
              ))
            )}
          </div>
        ))}
      <label>
        Request ID <input value={idInput} onChange={(e) => setIdInput(e.target.value)} />
      </label>
      {args &&
        (pd.isError || cd.isError || pr.isError || cr.isError ? (
          <p role="alert">Request state unavailable.</p>
        ) : (
          <dl>
            <dt>Pending deposit</dt>
            <dd>{formatTokenBalance(pd.data, 6, "USDC")}</dd>
            <dt>Claimable deposit</dt>
            <dd>{formatTokenBalance(cd.data, 6, "USDC")}</dd>
            <dt>Pending redemption</dt>
            <dd>
              {shareDecimals.data === undefined || shareDecimals.isError
                ? "Unavailable"
                : formatTokenBalance(pr.data, shareDecimals.data, "shares")}
            </dd>
            <dt>Claimable redemption</dt>
            <dd>
              {shareDecimals.data === undefined || shareDecimals.isError
                ? "Unavailable"
                : formatTokenBalance(cr.data, shareDecimals.data, "shares")}
            </dd>
          </dl>
        ))}
      <button
        type="button"
        disabled={!enabled || id === undefined || busy}
        onClick={() => send("cancel")}
      >
        Cancel selected request
      </button>
      <p>Cancellation returns funds to queue credit; withdraw it to your wallet.</p>
      {credit.isError ? (
        <p role="alert">Credit unavailable.</p>
      ) : (
        <p>
          Credit:{" "}
          {credit.data
            ? `${formatTokenBalance(credit.data[0], 6, "USDC")}, ${shareDecimals.data === undefined || shareDecimals.isError ? "shares unavailable" : formatTokenBalance(credit.data[1], shareDecimals.data, "shares")}`
            : "Loading"}
        </p>
      )}
      <button
        type="button"
        disabled={
          !enabled ||
          busy ||
          !credit.data ||
          credit.isError ||
          credit.isFetching ||
          (credit.data[0] === 0n && credit.data[1] === 0n)
        }
        onClick={() => send("withdrawCredit")}
      >
        Withdraw credit
      </button>
      <p>Claims take the amount above from your oldest eligible claims and may span requests.</p>
      <button
        type="button"
        disabled={!ready}
        onClick={() => send(kind === "deposit" ? "deposit" : "redeem")}
      >
        Claim {kind}
      </button>
      <WriteStatus
        testId="one-vault"
        label="One-vault transaction"
        write={write}
        receipt={receipt}
      />
    </section>
  );
}

export function oneVaultConfig(
  env: Readonly<Record<string, string | undefined>>,
): { queue: Address; chainId: number; fromBlock: bigint } | undefined {
  const queue = env.VITE_ONE_VAULT_QUEUE_ADDRESS;
  const chainId = Number(env.VITE_ONE_VAULT_CHAIN_ID);
  const block = env.VITE_ONE_VAULT_DEPLOY_BLOCK;
  return queue &&
    isAddress(queue) &&
    !/^0x0{40}$/i.test(queue) &&
    Number.isSafeInteger(chainId) &&
    chainId > 0 &&
    block !== undefined &&
    /^\d+$/.test(block)
    ? { queue, chainId, fromBlock: BigInt(block) }
    : undefined;
}
