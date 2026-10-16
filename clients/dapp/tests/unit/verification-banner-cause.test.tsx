// QA plan U5, finding DR-9: the gateway verification banner names the cause of a refusal. A missing pin,
// a wallet on the wrong chain, an RPC failure and a hash mismatch used to print the same "unknown_revert".
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { VerificationBanner } from "../../src/components/VerificationBanner";
import {
  describeVerificationCause,
  refusedVerification,
  type VerificationCause,
} from "../../src/lib/gatewayVerifier";

const CAUSES: VerificationCause[] = [
  "pin-missing",
  "address-missing",
  "no-code",
  "hash-mismatch",
  "wrong-chain",
  "no-wallet",
  "rpc-failed",
];

describe("VerificationBanner names the refusal cause", () => {
  for (const cause of CAUSES) {
    it(`prints the ${cause} sentence, not the raw product code`, () => {
      const { getByTestId } = render(
        <VerificationBanner state={refusedVerification(cause)} refresh={() => undefined} />,
      );
      const shown = getByTestId("gateway-verification-cause");
      expect(shown.textContent).toBe(describeVerificationCause(cause));
      expect(shown.getAttribute("data-cause")).toBe(cause);
      expect(getByTestId("gateway-verification-refused").textContent).not.toContain(
        "unknown_revert",
      );
    });
  }
});
