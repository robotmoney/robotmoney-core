/**
 * Unit tests for VaultPositionCard (issue #381 — shared vault UI library).
 *
 * Acceptance criteria exercised:
 *   - Renders receipt token count from the shares prop.
 *   - Renders estimated USD value from the usdcValue prop.
 *   - Shows "—" for USDC when usdcValue is not provided.
 *   - Renders vault name and optional risk label.
 */
import { describe, it, expect } from "vitest";
import { render } from "../helpers/render";
import { VaultPositionCard } from "../../../src/components/shared/VaultPositionCard";

const VAULT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("VaultPositionCard", () => {
  it("renders vault name", () => {
    const { getByTestId } = render(
      <VaultPositionCard vaultAddress={VAULT} vaultName="Alpha Vault" shares="1000000" />,
    );
    expect(getByTestId("vault-position-card-name").textContent).toBe("Alpha Vault");
  });

  it("renders receipt token (shares) count from mocked on-chain hook data", () => {
    const { getByTestId } = render(
      <VaultPositionCard vaultAddress={VAULT} vaultName="Alpha Vault" shares="1500000" />,
    );
    expect(getByTestId("vault-position-card-shares").textContent).toBe("1500000");
  });

  it("renders estimated USD value when usdcValue is provided", () => {
    const { getByTestId } = render(
      <VaultPositionCard
        vaultAddress={VAULT}
        vaultName="Alpha Vault"
        shares="1000000"
        usdcValue="999000"
      />,
    );
    expect(getByTestId("vault-position-card-usdc").textContent).toBe("999000");
  });

  it("shows dash for USDC when usdcValue is not provided", () => {
    const { getByTestId } = render(
      <VaultPositionCard vaultAddress={VAULT} vaultName="Alpha Vault" shares="1000000" />,
    );
    expect(getByTestId("vault-position-card-usdc").textContent).toBe("—");
  });

  it("renders the vault address", () => {
    const { getByTestId } = render(
      <VaultPositionCard vaultAddress={VAULT} vaultName="Alpha Vault" shares="500000" />,
    );
    expect(getByTestId("vault-position-card-address").textContent).toContain(VAULT);
  });

  it("renders risk label when provided", () => {
    const { getByTestId } = render(
      <VaultPositionCard
        vaultAddress={VAULT}
        vaultName="Alpha Vault"
        shares="500000"
        riskLabel="stable-yield"
      />,
    );
    expect(getByTestId("vault-position-card-risk").textContent).toBe("stable-yield");
  });

  it("does not render risk label when omitted", () => {
    const { queryByTestId } = render(
      <VaultPositionCard vaultAddress={VAULT} vaultName="Alpha Vault" shares="500000" />,
    );
    expect(queryByTestId("vault-position-card-risk")).toBeNull();
  });

  it("has the expected data-testid on the article", () => {
    const { getByTestId } = render(
      <VaultPositionCard vaultAddress={VAULT} vaultName="Alpha Vault" shares="1000000" />,
    );
    expect(getByTestId("vault-position-card")).toBeTruthy();
  });
});
