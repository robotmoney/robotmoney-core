/**
 * Unit tests for the localStorage-backed onboarding dismissal helpers.
 *
 * Covers issue #613 acceptance criteria:
 *   (a) dismiss flag is written on dismiss
 *   (b) flag causes wizard to be skipped on subsequent render
 *   (c) flag is wallet-address-scoped
 *   (d) graceful fallback when localStorage throws
 */
import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { markOnboardingDismissed, isOnboardingDismissed } from "../../src/lib/useVaultRegistration";

const ADDR_A = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const ADDR_B = "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb";

function storageKey(addr: string): string {
  return `rm:onboarding-dismissed:${addr.toLowerCase()}`;
}

describe("onboarding dismissal helpers", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // (a) dismiss flag is written on dismiss
  it("markOnboardingDismissed writes '1' to localStorage under the correct key", () => {
    markOnboardingDismissed(ADDR_A);
    expect(localStorage.getItem(storageKey(ADDR_A))).toBe("1");
  });

  it("markOnboardingDismissed lowercases the address", () => {
    markOnboardingDismissed(ADDR_A.toUpperCase());
    expect(localStorage.getItem(storageKey(ADDR_A))).toBe("1");
  });

  // (b) flag causes wizard to be skipped on subsequent render
  it("isOnboardingDismissed returns false before dismissal and true after", () => {
    expect(isOnboardingDismissed(ADDR_A)).toBe(false);
    markOnboardingDismissed(ADDR_A);
    expect(isOnboardingDismissed(ADDR_A)).toBe(true);
  });

  // (c) flag is wallet-address-scoped
  it("dismissal of one wallet address does not affect another", () => {
    markOnboardingDismissed(ADDR_A);
    expect(isOnboardingDismissed(ADDR_A)).toBe(true);
    expect(isOnboardingDismissed(ADDR_B)).toBe(false);
  });

  it("each wallet address has its own independent dismiss flag", () => {
    markOnboardingDismissed(ADDR_A);
    markOnboardingDismissed(ADDR_B);
    expect(isOnboardingDismissed(ADDR_A)).toBe(true);
    expect(isOnboardingDismissed(ADDR_B)).toBe(true);
    // clearing A does not affect B
    localStorage.removeItem(storageKey(ADDR_A));
    expect(isOnboardingDismissed(ADDR_A)).toBe(false);
    expect(isOnboardingDismissed(ADDR_B)).toBe(true);
  });

  // (d) graceful fallback when localStorage throws
  it("markOnboardingDismissed does not throw when localStorage.setItem throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(() => markOnboardingDismissed(ADDR_A)).not.toThrow();
  });

  it("isOnboardingDismissed returns false when localStorage.getItem throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("SecurityError");
    });
    expect(isOnboardingDismissed(ADDR_A)).toBe(false);
  });

  // dispatches a custom event on successful dismiss
  it("markOnboardingDismissed dispatches rm:onboarding-dismissed-changed event", () => {
    const listener = vi.fn();
    window.addEventListener("rm:onboarding-dismissed-changed", listener);
    markOnboardingDismissed(ADDR_A);
    window.removeEventListener("rm:onboarding-dismissed-changed", listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("markOnboardingDismissed does not dispatch event when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    const listener = vi.fn();
    window.addEventListener("rm:onboarding-dismissed-changed", listener);
    markOnboardingDismissed(ADDR_A);
    window.removeEventListener("rm:onboarding-dismissed-changed", listener);
    expect(listener).not.toHaveBeenCalled();
  });
});
