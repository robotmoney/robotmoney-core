/**
 * Unit tests — RoleTab component (issue #254).
 *
 * Focus:
 *  - data-testid slugs render correctly for both ADMIN_ROLE and PAUSER_ROLE.
 *  - Both grant and revoke buttons are disabled when simulate has not
 *    returned a result (network boundary mocked to return undefined).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { RoleTab } from "../../../src/components/RoleTab";
import type { PreviewContext } from "../../../src/lib/preview";
import type { RoleName } from "../../../src/lib/abi";

vi.mock("wagmi", () => ({
  useAccount: () => ({ isConnected: false }),
  useSimulateContract: () => ({ data: undefined }),
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

describe("RoleTab — ADMIN_ROLE slug and button gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
