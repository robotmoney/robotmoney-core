/**
 * Unit tests — RoleTab component (issue #254).
 *
 * Focus:
 *  - data-testid slugs render correctly for both ADMIN_ROLE and PAUSER_ROLE.
 *  - Both grant and revoke buttons are disabled when simulate has not
 *    returned a result (network boundary mocked to return undefined).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "../helpers/render";
import { RoleTab } from "../../../src/components/RoleTab";
import type { PreviewContext } from "../../../src/lib/preview";
import type { RoleName } from "../../../src/lib/abi";

// Per-test wagmi state. Default: not connected, no role read, no simulate data.
const wagmiState = vi.hoisted(() => ({
  account: { isConnected: false } as { isConnected: boolean; address?: `0x${string}` },
  hasRoleAdmin: undefined as boolean | undefined,
  simData: undefined as unknown,
}));

vi.mock("wagmi", () => ({
  useAccount: () => wagmiState.account,
  useReadContract: () => ({ data: wagmiState.hasRoleAdmin }),
  useSimulateContract: () => ({ data: wagmiState.simData }),
  useWriteContract: () => ({ writeContract: vi.fn(), isPending: false }),
}));

const GATEWAY = "0x1111111111111111111111111111111111111111" as const;
const ctx: PreviewContext = {
  gateway: GATEWAY,
  gatewayCodeHashVerified: true,
  envClass: "fork",
};

function renderTab(role: RoleName) {
  return render(
    <RoleTab
      role={role}
      gatewayAddress={GATEWAY}
      ctx={ctx}
      description={<span>Role description</span>}
    />,
  );
}

function resetWagmi() {
  wagmiState.account = { isConnected: false };
  wagmiState.hasRoleAdmin = undefined;
  wagmiState.simData = undefined;
}

describe("RoleTab — ADMIN_ROLE slug and button gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWagmi();
  });

  it("renders data-testid with admin slug for ADMIN_ROLE", () => {
    renderTab("ADMIN_ROLE");
    expect(screen.getByTestId("admin-role-form")).toBeInTheDocument();
    expect(screen.getByTestId("admin-account-input")).toBeInTheDocument();
    expect(screen.getByTestId("grant-admin-submit")).toBeInTheDocument();
    expect(screen.getByTestId("revoke-admin-submit")).toBeInTheDocument();
  });

  it("grant button is disabled when simulate returns undefined (ADMIN_ROLE)", () => {
    renderTab("ADMIN_ROLE");
    expect(screen.getByTestId("grant-admin-submit")).toBeDisabled();
  });

  it("revoke button is disabled when simulate returns undefined (ADMIN_ROLE)", () => {
    renderTab("ADMIN_ROLE");
    expect(screen.getByTestId("revoke-admin-submit")).toBeDisabled();
  });
});

describe("RoleTab — PAUSER_ROLE slug and button gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWagmi();
  });

  it("renders data-testid with pauser slug for PAUSER_ROLE", () => {
    renderTab("PAUSER_ROLE");
    expect(screen.getByTestId("pauser-role-form")).toBeInTheDocument();
    expect(screen.getByTestId("pauser-account-input")).toBeInTheDocument();
    expect(screen.getByTestId("grant-pauser-submit")).toBeInTheDocument();
    expect(screen.getByTestId("revoke-pauser-submit")).toBeInTheDocument();
  });

  it("grant button is disabled when simulate returns undefined (PAUSER_ROLE)", () => {
    renderTab("PAUSER_ROLE");
    expect(screen.getByTestId("grant-pauser-submit")).toBeDisabled();
  });

  it("revoke button is disabled when simulate returns undefined (PAUSER_ROLE)", () => {
    renderTab("PAUSER_ROLE");
    expect(screen.getByTestId("revoke-pauser-submit")).toBeDisabled();
  });

  it("no ADMIN_ROLE slugs appear when rendering PAUSER_ROLE", () => {
    renderTab("PAUSER_ROLE");
    expect(screen.queryByTestId("admin-role-form")).toBeNull();
    expect(screen.queryByTestId("grant-admin-submit")).toBeNull();
  });

  it("no PAUSER_ROLE slugs appear when rendering ADMIN_ROLE", () => {
    renderTab("ADMIN_ROLE");
    expect(screen.queryByTestId("pauser-role-form")).toBeNull();
    expect(screen.queryByTestId("grant-pauser-submit")).toBeNull();
  });
});

describe("RoleTab — wallet without DEFAULT_ADMIN_ROLE (post timelock handover)", () => {
  const WALLET = "0x2222222222222222222222222222222222222222" as const;
  const TARGET = "0x3333333333333333333333333333333333333333";

  beforeEach(() => {
    vi.clearAllMocks();
    resetWagmi();
  });

  it.each([
    ["ADMIN_ROLE", "admin"],
    ["PAUSER_ROLE", "pauser"],
  ] as const)(
    "%s: shows the refusal reason and keeps both buttons disabled even when simulate returns data",
    (role, slug) => {
      wagmiState.account = { isConnected: true, address: WALLET };
      wagmiState.hasRoleAdmin = false;
      // A stale or mocked simulate result must not re-enable signing.
      wagmiState.simData = { request: {} };
      renderTab(role);
      fireEvent.change(screen.getByTestId(`${slug}-account-input`), {
        target: { value: TARGET },
      });

      const reason = screen.getByTestId(`${slug}-role-wallet-refusal`);
      expect(reason.textContent).toMatch(/lacks DEFAULT_ADMIN_ROLE/);
      expect(reason.textContent).toContain(role);
      expect(reason.textContent).toContain("Safe -> Timelock");
      expect(screen.getByTestId(`grant-${slug}-submit`)).toBeDisabled();
      expect(screen.getByTestId(`revoke-${slug}-submit`)).toBeDisabled();
      // The structured preview still renders.
      expect(screen.getByTestId(`grant-${slug}-preview-wrap`)).toBeInTheDocument();
    },
  );

  it("shows no refusal while the role read is pending", () => {
    wagmiState.account = { isConnected: true, address: WALLET };
    wagmiState.hasRoleAdmin = undefined;
    renderTab("ADMIN_ROLE");
    expect(screen.queryByTestId("admin-role-wallet-refusal")).toBeNull();
  });

  it("enables signing for a wallet that holds DEFAULT_ADMIN_ROLE once simulate succeeds", () => {
    wagmiState.account = { isConnected: true, address: WALLET };
    wagmiState.hasRoleAdmin = true;
    wagmiState.simData = { request: {} };
    renderTab("ADMIN_ROLE");
    fireEvent.change(screen.getByTestId("admin-account-input"), { target: { value: TARGET } });
    expect(screen.queryByTestId("admin-role-wallet-refusal")).toBeNull();
    expect(screen.getByTestId("grant-admin-submit")).toBeEnabled();
    expect(screen.getByTestId("revoke-admin-submit")).toBeEnabled();
  });
});
