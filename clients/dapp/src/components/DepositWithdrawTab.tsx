import { useState } from "react";

export function DepositWithdrawTab() {
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");

  return (
    <div className="form-grid">
      <section data-testid="deposit-form">
        <h2>Deposit USDC</h2>
        <p>Send USDC to the gateway. Receive vault shares.</p>
        <label>
          Amount (USDC)
          <input
            data-testid="deposit-amount"
            value={depositAmount}
            onChange={(e) => setDepositAmount(e.target.value)}
            placeholder="0.00"
          />
        </label>
        {/* TODO: vault ABI not yet wired — see src/lib/abi.ts */}
        <button type="button" data-testid="deposit-submit" disabled>
          Sign deposit with wallet
        </button>
        <p className="hint">Vault integration pending.</p>
      </section>
      <section data-testid="withdraw-form">
        <h2>Withdraw</h2>
        <p>Burn vault shares. Receive USDC.</p>
        <label>
          Shares
          <input
            data-testid="withdraw-amount"
            value={withdrawAmount}
            onChange={(e) => setWithdrawAmount(e.target.value)}
            placeholder="0.00"
          />
        </label>
        <button type="button" data-testid="withdraw-submit" disabled>
          Sign withdraw with wallet
        </button>
        <p className="hint">Vault integration pending.</p>
      </section>
    </div>
  );
}
