// Canonical: docs/architecture.md §5.3 — Human Dapp (faucet UX)

/**
 * FaucetTabView — pure render layer of the testnet/devnet faucet (issue
 * #261, extended in #365 for RM token drip). All data flows in via props;
 * the only external effects are (a) calling the injected drip functions and
 * (b) reading from `window.ethereum` via `getInjectedProvider` for the
 * broadcast transport. RTL tests render this component directly with stub
 * data and fake drip handlers, so no wagmi/QueryClient fixture is needed.
 *
 * The USDC button-disabled logic encodes the "simulate before write" gate:
 * the user can only submit once `harnessBalance >= FAUCET_DRIP_AMOUNT_USDC`,
 * which is the strict equivalent of a simulateContract preflight given
 * the dapp's no-RPC topology (see docs/security/dapp-topology.md §2).
 *
 * The RM button is additionally gated on `rmTokenAddress` being provided and
 * `harnessRmBalance >= FAUCET_DRIP_AMOUNT_RM` (issue #365 AC).
 */
import { useState, type FormEvent } from "react";
import { type Address, type Hex, getAddress, isAddress } from "viem";
import {
  FAUCET_DRIP_AMOUNT_LABEL,
  FAUCET_DRIP_AMOUNT_RM,
  FAUCET_DRIP_AMOUNT_RM_LABEL,
  FAUCET_DRIP_AMOUNT_USDC,
} from "../lib/chainClassifier";
import type { DripRmTokenArgs, DripUsdcArgs } from "../lib/faucetClient";
import { getInjectedProvider } from "../lib/syncDevnetChain";

type DripStatus =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "success"; hash: Hex }
  | { kind: "error"; message: string };

export type Props = Readonly<{
  usdcAddress: Address;
  chainId: number;
  walletAddresses: ReadonlyArray<Address>;
  harnessPrivateKey: Hex | null;
  harnessBalance: bigint | undefined;
  harnessBalancePending: boolean;
  harnessBalanceError: Error | null;
  recipientBalance: bigint | undefined;
  refetchRecipientBalance: () => Promise<unknown>;
  drip: (args: DripUsdcArgs) => Promise<Hex>;
  /** RM token contract address. When provided and env is not mainnet, renders the RM drip button. */
  rmTokenAddress?: Address;
  /** Harness RM token balance for the preflight gate. */
  harnessRmBalance?: bigint;
  /** Injected RM drip handler. */
  dripRm?: (args: DripRmTokenArgs) => Promise<Hex>;
}>;

export function FaucetTabView(props: Props) {
  const [selected, setSelected] = useState<string>(props.walletAddresses[0] ?? "");
  const [status, setStatus] = useState<DripStatus>({ kind: "idle" });
  const [rmStatus, setRmStatus] = useState<DripStatus>({ kind: "idle" });

  if (props.harnessPrivateKey === null) {
    return (
      <section data-testid="faucet-unavailable" className="faucet-tab">
        <h2>Faucet unavailable</h2>
        <p>
          This build was produced without a harness funding key, so the testnet/devnet faucet is not
          reachable. Mainnet builds intentionally omit this surface.
        </p>
      </section>
    );
  }

  const harnessFunded =
    props.harnessBalance !== undefined && props.harnessBalance >= FAUCET_DRIP_AMOUNT_USDC;
  const validRecipient = isAddress(selected);
  const canDrip = validRecipient && harnessFunded && status.kind !== "pending";

  const harnessRmFunded =
    props.harnessRmBalance !== undefined && props.harnessRmBalance >= FAUCET_DRIP_AMOUNT_RM;
  const canDripRm =
    validRecipient && harnessRmFunded && rmStatus.kind !== "pending" && !!props.rmTokenAddress;

  const onDrip = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canDrip) return;
    const provider = getInjectedProvider();
    if (!provider) {
      setStatus({
        kind: "error",
        message: "No injected wallet provider (window.ethereum is undefined).",
      });
      return;
    }
    setStatus({ kind: "pending" });
    void props
      .drip({
        usdcAddress: props.usdcAddress,
        recipient: getAddress(selected),
        provider,
        harnessPrivateKey: props.harnessPrivateKey as Hex,
        chainId: props.chainId,
      })
      .then((hash) => {
        setStatus({ kind: "success", hash });
        void props.refetchRecipientBalance();
      })
      .catch((err: unknown) => {
        const message =
          typeof err === "object" && err !== null && "shortMessage" in err
            ? String((err as { shortMessage: unknown }).shortMessage)
            : err instanceof Error
              ? err.message
              : String(err);
        setStatus({ kind: "error", message });
      });
  };

  const onDripRm = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canDripRm || !props.rmTokenAddress || !props.dripRm) return;
    const provider = getInjectedProvider();
    if (!provider) {
      setRmStatus({
        kind: "error",
        message: "No injected wallet provider (window.ethereum is undefined).",
      });
      return;
    }
    setRmStatus({ kind: "pending" });
    void props
      .dripRm({
        rmTokenAddress: props.rmTokenAddress,
        recipient: getAddress(selected),
        provider,
        harnessPrivateKey: props.harnessPrivateKey as Hex,
        chainId: props.chainId,
      })
      .then((hash) => {
        setRmStatus({ kind: "success", hash });
      })
      .catch((err: unknown) => {
        const message =
          typeof err === "object" && err !== null && "shortMessage" in err
            ? String((err as { shortMessage: unknown }).shortMessage)
            : err instanceof Error
              ? err.message
              : String(err);
        setRmStatus({ kind: "error", message });
      });
  };

  return (
    <section data-testid="faucet-tab" className="faucet-tab">
      <h2>Faucet</h2>
      <p>
        Drip a fixed <strong>{FAUCET_DRIP_AMOUNT_LABEL}</strong> into one of your wallets from the
        smoke-test harness holder. Amount is hard-coded — no input field.
      </p>
      <form onSubmit={onDrip}>
        <label>
          Recipient wallet
          <select
            data-testid="faucet-wallet-select"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {props.walletAddresses.length === 0 && (
              <option value="" disabled>
                (no wallets connected)
              </option>
            )}
            {props.walletAddresses.map((addr) => (
              <option key={addr} value={addr}>
                {addr}
              </option>
            ))}
          </select>
        </label>
        <p
          data-testid="faucet-harness-balance"
          className="hint"
          data-harness-funded={harnessFunded ? "true" : "false"}
        >
          {props.harnessBalancePending && "Checking harness balance…"}
          {props.harnessBalanceError &&
            `Harness balance error: ${props.harnessBalanceError.message}`}
          {props.harnessBalance !== undefined &&
            `Harness balance: ${props.harnessBalance.toString()} (base units)`}
        </p>
        <button type="submit" data-testid="faucet-drip-submit" disabled={!canDrip}>
          Drip {FAUCET_DRIP_AMOUNT_LABEL}
        </button>
      </form>
      {status.kind === "pending" && (
        <p data-testid="faucet-drip-pending" className="hint">
          Signing and broadcasting drip…
        </p>
      )}
      {status.kind === "success" && (
        <p data-testid="faucet-drip-success" className="hint">
          Drip sent — tx <code>{status.hash}</code>
        </p>
      )}
      {status.kind === "error" && (
        <p data-testid="faucet-drip-error" className="unsafe-banner">
          <strong>Drip failed:</strong> {status.message}
        </p>
      )}
      {props.recipientBalance !== undefined && validRecipient && (
        <p data-testid="faucet-recipient-balance" className="hint">
          Recipient balance now: {props.recipientBalance.toString()} (base units)
        </p>
      )}

      {props.rmTokenAddress ? (
        <form onSubmit={onDripRm} style={{ marginTop: "1rem" }}>
          <p>
            Get <strong>{FAUCET_DRIP_AMOUNT_RM_LABEL}</strong> voting tokens to participate in
            Router Governance.
          </p>
          <button type="submit" data-testid="faucet-rm-drip-button" disabled={!canDripRm}>
            Get RM tokens
          </button>
          {rmStatus.kind === "pending" && (
            <p data-testid="faucet-rm-drip-pending" className="hint">
              Signing and broadcasting RM drip…
            </p>
          )}
          {rmStatus.kind === "success" && (
            <p data-testid="faucet-rm-drip-success" className="hint">
              RM drip sent — tx <code>{rmStatus.hash}</code>
            </p>
          )}
          {rmStatus.kind === "error" && (
            <p data-testid="faucet-rm-drip-error" className="unsafe-banner">
              <strong>RM drip failed:</strong> {rmStatus.message}
            </p>
          )}
        </form>
      ) : null}
    </section>
  );
}
