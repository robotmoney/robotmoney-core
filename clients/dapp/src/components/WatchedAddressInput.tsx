// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * WatchedAddressInput — issue #319, account layer.
 *
 * Allows the user to enter any Ethereum address (watched-address mode) for
 * read-only portfolio inspection without connecting a wallet. A connected
 * wallet address may also be passed in as the `defaultAddress` prop, which
 * pre-fills the input on mount.
 *
 * On submit the `onAddress` callback receives the validated lowercase
 * 0x-prefixed address. Validation is purely syntactic (42-char hex prefix);
 * the API surfaces semantic errors (e.g. unknown address returns empty arrays,
 * not a 404).
 */
import { useState, type FormEvent } from "react";
import type { Address } from "viem";

export interface WatchedAddressInputProps {
  /** Pre-fill value (e.g. connected wallet address). Optional. */
  readonly defaultAddress?: Address;
  /** Called with the validated address when the user submits. */
  readonly onAddress: (address: Address) => void;
}

function isValidAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

export function WatchedAddressInput({ defaultAddress, onAddress }: WatchedAddressInputProps) {
  const [value, setValue] = useState<string>(defaultAddress ?? "");
  const [error, setError] = useState<string | undefined>(undefined);

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!isValidAddress(trimmed)) {
      setError("Enter a valid 0x-prefixed Ethereum address (42 characters).");
      return;
    }
    setError(undefined);
    onAddress(trimmed.toLowerCase() as Address);
  };

  return (
    <form data-testid="watched-address-form" onSubmit={handleSubmit}>
      <label>
        Address to inspect
        <input
          data-testid="watched-address-input"
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="0x…"
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <button type="submit" data-testid="watched-address-submit">
        View portfolio
      </button>
      {error && (
        <p data-testid="watched-address-error" className="unsafe-banner">
          {error}
        </p>
      )}
    </form>
  );
}
