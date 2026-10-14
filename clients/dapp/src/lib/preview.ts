// Canonical: docs/architecture.md §7.1 — Previews, §7.2 — Stable product reason codes

/**
 * Calldata-preview pipeline. Implements the fixed shape required by
 * docs/technical/dapp-credential-decisions.md §3.3 — every admin/policy
 * tx renders target, function, decoded args, role/policy effect, risk
 * class, and raw calldata. Decoder failure is a HARD refusal; callers
 * must never fall back to raw-calldata signing.
 *
 * Withdrawal-enabled policy surfacing (issue #429 / security review
 * `docs/code-review/20260518-code-review-internal-codex.md` §5): a non-zero
 * `maxWithdrawPerPayment` on an `authorizeAgent`/`setPolicy` tx means
 * an agent-key compromise can redeem shares to `assetRecipient` up to
 * the per-window cap. The preview surfaces this explicitly:
 *   - args include the withdrawal caps and `assetRecipient`
 *   - `effect` carries a one-line risk callout when withdrawals are
 *     enabled
 *   - the risk classifier upgrades withdrawal-enabled policies to
 *     "high"
 * so the user cannot sign a withdrawal-enabled policy without seeing
 * what it permits.
 *
 * Commit/reveal (QA plan U4, finding DR-4): a depositor signs
 * `commitAuthorization` and then `revealAuthorization`, never
 * `authorizeAgent`. Each has its own preview kind, encoded from the call
 * object in `commitReveal.ts` that the component also hands to the wallet,
 * so the previewed function and calldata are the signed ones.
 */
import { decodeFunctionData, encodeFunctionData, getAddress, toFunctionSelector } from "viem";
import type { Address, Hex } from "viem";
import { gatewayAbi, ROLE_HASH } from "./abi";
import type { AdminActionName, RoleName, RouterActionName, VaultActionName } from "./abi";
import type { ProductReasonCode } from "./productReasonCode";
export type { ProductReasonCode } from "./productReasonCode";
import { formatUsdc, formatShares } from "./format";
import {
  commitAuthorizationCall,
  revealAuthorizationCall,
  type CommitInputs,
  type RevealInputs,
} from "./commitReveal";

/**
 * Union of every function name that may appear in a structured Preview.
 * Gateway admin actions cover the depositor-owned authorize/revoke/policy
 * surface and the deposit-pause/role switches; vault actions cover the
 * ERC-4626 deposit/redeem entrypoints driven by the Deposit/Withdraw tab
 * (issue #257); router actions cover the router deposit and the one-leg
 * `redeemFor` the Withdraw tab signs (QA plan D9). All flow through the same
 * TxPreview component, so the preview success type accepts any of them.
 */
export type PreviewFunctionName = AdminActionName | VaultActionName | RouterActionName;

export type RiskClass = "low" | "medium" | "high" | "unsafe";

export interface AgentPolicy {
  active: boolean;
  validUntil: bigint;
  maxPerPayment: bigint;
  maxPerWindow: bigint;
  shareReceiver: Address;
  /** Whitelist of deposit destinations (vault or router). Empty array = open policy. */
  allowedDestinations: Address[];
  /** USDC recipient for agent-initiated withdrawals. Zero address = withdrawal disabled. */
  assetRecipient: Address;
  /** Max shares per withdrawal payment (0 = withdrawal disabled). */
  maxWithdrawPerPayment: bigint;
  /** Max shares per withdrawal window (0 = withdrawal disabled). */
  maxWithdrawPerWindow: bigint;
  /** Whitelist of source vaults for withdrawal. Empty = any registered vault. */
  allowedSourceVaults: Address[];
}

export type AdminAction =
  | { kind: "authorizeAgent"; agent: Address; policy: AgentPolicy }
  // The depositor path signs these two instead of `authorizeAgent` (QA plan U4,
  // finding DR-4): the preview must name the call the wallet actually signs.
  | ({ kind: "commitAuthorization" } & CommitInputs)
  | ({ kind: "revealAuthorization" } & RevealInputs)
  | { kind: "revokeAgent"; agent: Address }
  | { kind: "pauseDeposits" }
  | { kind: "unpauseDeposits" }
  | { kind: "grantRole"; role: RoleName; account: Address }
  | { kind: "revokeRole"; role: RoleName; account: Address };

interface PreviewArg {
  name: string;
  raw: string;
  gloss: string;
}

interface PreviewSuccess {
  ok: true;
  target: Address;
  targetCodeHashKnown: boolean;
  functionName: PreviewFunctionName;
  selector: Hex;
  args: PreviewArg[];
  effect: string;
  risk: RiskClass;
  calldata: Hex;
}

interface PreviewFailure {
  ok: false;
  /**
   * Typed stable product reason code (Architecture §7.2).
   * The free-form `string` surface has been replaced by this typed union so
   * that callers and tests can match on a stable finite set of codes.
   */
  reason: ProductReasonCode;
  /** Always present even on failure so the operator can paste into a second tool. */
  calldata?: Hex;
  /**
   * Optional sentence naming the actual cause when `reason` is the catch-all
   * (QA plan U5, finding DR-9): a vault or router preview refused because the
   * gateway is unverified says why the gateway is unverified.
   */
  detail?: string;
}

export type Preview = PreviewSuccess | PreviewFailure;

export interface PreviewContext {
  /** Gateway contract address. */
  gateway: Address;
  /** Whether the on-chain bytecode hash matches the pinned harness fixture. */
  gatewayCodeHashVerified: boolean;
  /** "fork" / "devnet" => low-stakes envs; mainnet/testnet => higher risk. */
  envClass: "fork" | "devnet" | "testnet" | "mainnet";
  /**
   * Lower-cased non-gateway addresses (vaults, router) whose runtime code hash
   * matched a build-time pin. A vault or router preview badges its target
   * "[bytecode verified]" only when the target is in this set: the gateway
   * hash proves nothing about them (QA plan U4, finding DR-5). AdminFlow fills it
   * from the build-time vault and router pins (`useVerifiedCodeTargets`, QA plan U5).
   * Keyed by address, so a context spread onto another vault stays correct.
   */
  verifiedTargets?: ReadonlySet<string>;
  /**
   * Why `gatewayCodeHashVerified` is false, in one sentence (gatewayVerifier.ts
   * `describeVerificationCause`). Vault and router previews refused on it carry
   * this as `detail`, so the refusal names the cause (QA plan U5).
   */
  gatewayRefusalDetail?: string;
}

/** True only when `target` matched its own code-hash pin (see `verifiedTargets`). */
export function targetCodeHashPinned(ctx: PreviewContext, target: Address): boolean {
  return ctx.verifiedTargets?.has(target.toLowerCase()) === true;
}

/**
 * Risk classifier. Implements the fixed table in §3.3:
 *   - unsafe: pauseDeposits/unpauseDeposits on non-fork without a recent
 *     self-check (we conservatively mark non-fork deposit pause/unpause as
 *     unsafe here; the self-check freshness check is enforced by rmpc, not
 *     the dapp).
 *   - high:   granting AGENT_ROLE policy with a per-window cap above
 *             threshold, or unverified bytecode.
 *   - medium: standard authorizeAgent below threshold.
 *   - low:    revokeAgent, pauseDeposits on a fork.
 */
const HIGH_CAP_THRESHOLD = 1_000_000_000n; // 1,000 USDC in 6dp

/**
 * True when the agent policy permits agent-initiated withdrawals. The
 * gateway treats `maxWithdrawPerPayment > 0` as the canonical
 * "withdrawals enabled" flag (`contracts/gateway/RobotMoneyGateway.sol`
 * `WithdrawalNotEnabled` guard). Issue #429: surfacing this is the
 * hinge for the high-risk classification and the user-facing warning.
 */
export function isWithdrawalEnabled(policy: AgentPolicy): boolean {
  return policy.maxWithdrawPerPayment > 0n;
}

export function classifyRisk(action: AdminAction, ctx: PreviewContext): RiskClass {
  if (!ctx.gatewayCodeHashVerified) return "unsafe";
  switch (action.kind) {
    case "pauseDeposits":
    case "unpauseDeposits":
      return ctx.envClass === "fork" ? "low" : "unsafe";
    case "revokeAgent":
      return "low";
    case "commitAuthorization":
      // A commitment stores a hash only. No role, policy or funds change until the reveal,
      // which is previewed and classified on its own.
      return "low";
    case "authorizeAgent":
    case "revealAuthorization":
      // Issue #429: any withdrawal-enabled policy is "high" risk —
      // a stolen agent key can redeem shares to `assetRecipient`
      // within the policy caps. This overrides the deposit-cap
      // threshold so even a modest withdrawal cap still surfaces.
      if (isWithdrawalEnabled(action.policy)) return "high";
      return action.policy.maxPerWindow > HIGH_CAP_THRESHOLD ? "high" : "medium";
    case "grantRole":
      // Granting any admin-tier role is "high" per ADR §3.3 risk table
      // ("granting any admin role"). DEPOSIT_PAUSER is treated identically —
      // it is privileged, even if its only power is `pauseDeposits()`.
      return "high";
    case "revokeRole":
      // Revoke is recoverable (admin can re-grant) and reduces blast
      // radius, so "low" — consistent with revokeAgent above. The
      // contract-side guard against revoking the only DEFAULT_ADMIN
      // holder lives in AccessRoles.sol; the dapp does not pre-check.
      return "low";
  }
}

/** Build the structured preview block. Returns a refusal on any failure. */
export function buildPreview(action: AdminAction, ctx: PreviewContext): Preview {
  if (!ctx.gatewayCodeHashVerified) {
    return {
      ok: false,
      reason: "unknown_revert",
    };
  }

  let calldata: Hex;
  let args: PreviewArg[];
  let effect: string;
  let functionName: AdminActionName;

  try {
    switch (action.kind) {
      case "authorizeAgent": {
        functionName = "authorizeAgent";
        calldata = encodeFunctionData({
          abi: gatewayAbi,
          functionName: "authorizeAgent",
          args: [
            getAddress(action.agent),
            {
              active: action.policy.active,
              validUntil: action.policy.validUntil,
              maxPerPayment: action.policy.maxPerPayment,
              maxPerWindow: action.policy.maxPerWindow,
              shareReceiver: getAddress(action.policy.shareReceiver),
              allowedDestinations: action.policy.allowedDestinations,
              assetRecipient: action.policy.assetRecipient,
              maxWithdrawPerPayment: action.policy.maxWithdrawPerPayment,
              maxWithdrawPerWindow: action.policy.maxWithdrawPerWindow,
              allowedSourceVaults: action.policy.allowedSourceVaults,
            },
          ],
        });
        args = [
          { name: "agent", raw: action.agent, gloss: `Agent EOA ${shorten(action.agent)}` },
          ...policyArgs(action.policy),
        ];
        effect = policyEffect(action.agent, action.policy);
        break;
      }
      case "commitAuthorization": {
        // Encoded from the same call object the wallet signs (commitReveal.ts).
        functionName = "commitAuthorization";
        const call = commitAuthorizationCall(action);
        calldata = encodeFunctionData({ abi: gatewayAbi, ...call });
        args = [
          {
            name: "commitHash",
            raw: call.args[0],
            gloss: `keccak256(abi.encode(agent ${shorten(action.agent)}, caller ${shorten(action.committer)}, salt ${shorten(action.salt)}))`,
          },
        ];
        effect =
          `Records a hidden commitment, bound to caller ${shorten(action.committer)}, to authorize agent ${shorten(action.agent)}. ` +
          "No role, policy or funds change yet. At least one block later, revealAuthorization(agent, salt, policy) grants AGENT_ROLE " +
          "with the policy shown in the reveal preview; that policy is not part of this commitment.";
        break;
      }
      case "revealAuthorization": {
        // Encoded from the same call object the wallet signs (commitReveal.ts).
        functionName = "revealAuthorization";
        calldata = encodeFunctionData({ abi: gatewayAbi, ...revealAuthorizationCall(action) });
        args = [
          { name: "agent", raw: action.agent, gloss: `Agent EOA ${shorten(action.agent)}` },
          {
            name: "salt",
            raw: action.salt,
            gloss:
              "salt of the step-1 commitment; keccak256(abi.encode(agent, caller, salt)) must equal it",
          },
          ...policyArgs(action.policy),
        ];
        effect = `Reveals the step-1 commitment; the signing wallet becomes this agent's recorded owner (agentOwner). ${policyEffect(action.agent, action.policy)}`;
        break;
      }
      case "revokeAgent":
        functionName = "revokeAgent";
        calldata = encodeFunctionData({
          abi: gatewayAbi,
          functionName: "revokeAgent",
          args: [getAddress(action.agent)],
        });
        args = [{ name: "agent", raw: action.agent, gloss: `Agent EOA ${shorten(action.agent)}` }];
        effect = `Address ${shorten(action.agent)} loses AGENT_ROLE and its policy is deleted; subsequent deposit() calls revert.`;
        break;
      case "pauseDeposits":
        functionName = "pauseDeposits";
        calldata = encodeFunctionData({
          abi: gatewayAbi,
          functionName: "pauseDeposits",
          args: [],
        });
        args = [];
        effect =
          "Gateway deposits are paused; deposit() and depositTo() revert with DepositsArePaused until unpauseDeposits() is called. Withdrawals stay open.";
        break;
      case "unpauseDeposits":
        functionName = "unpauseDeposits";
        calldata = encodeFunctionData({
          abi: gatewayAbi,
          functionName: "unpauseDeposits",
          args: [],
        });
        args = [];
        effect =
          "Gateway deposits resume; deposit() resumes for AGENT_ROLE holders within policy. Withdrawals were open throughout.";
        break;
      case "grantRole": {
        functionName = "grantRole";
        const roleHash = ROLE_HASH[action.role];
        calldata = encodeFunctionData({
          abi: gatewayAbi,
          functionName: "grantRole",
          args: [roleHash, getAddress(action.account)],
        });
        args = [
          {
            name: "role",
            raw: roleHash,
            gloss: `${action.role} (keccak256 of role string)`,
          },
          {
            name: "account",
            raw: action.account,
            gloss: `${action.role} holder ${shorten(action.account)}`,
          },
        ];
        effect = roleEffectGrant(action.role, action.account);
        break;
      }
      case "revokeRole": {
        functionName = "revokeRole";
        const roleHash = ROLE_HASH[action.role];
        calldata = encodeFunctionData({
          abi: gatewayAbi,
          functionName: "revokeRole",
          args: [roleHash, getAddress(action.account)],
        });
        args = [
          {
            name: "role",
            raw: roleHash,
            gloss: `${action.role} (keccak256 of role string)`,
          },
          {
            name: "account",
            raw: action.account,
            gloss: `${action.role} holder ${shorten(action.account)}`,
          },
        ];
        effect = roleEffectRevoke(action.role, action.account);
        break;
      }
    }
  } catch {
    return { ok: false, reason: "unknown_revert" };
  }

  // Re-decode round-trip to guarantee the preview shape stays consistent.
  let selector: Hex;
  try {
    const decoded = decodeFunctionData({ abi: gatewayAbi, data: calldata });
    if (decoded.functionName !== functionName) {
      return { ok: false, reason: "unknown_revert", calldata };
    }
    selector = toFunctionSelector(
      gatewayAbi.find((e) => e.type === "function" && e.name === functionName) as never,
    );
  } catch {
    return { ok: false, reason: "unknown_revert", calldata };
  }

  return {
    ok: true,
    target: ctx.gateway,
    targetCodeHashKnown: ctx.gatewayCodeHashVerified,
    functionName,
    selector,
    args,
    effect,
    risk: classifyRisk(action, ctx),
    calldata,
  };
}

/**
 * Decoded-arg rows for an agent policy. `authorizeAgent` and `revealAuthorization`
 * carry the same tuple, so both previews print it through this one function.
 */
function policyArgs(policy: AgentPolicy): PreviewArg[] {
  // Issue #429: surface withdrawal-policy fields and the assetRecipient
  // destination explicitly. These are decoded from the same calldata as the
  // deposit caps and form the agent-key compromise blast radius on the
  // withdraw path.
  const withdrawalsEnabled = isWithdrawalEnabled(policy);
  return [
    {
      name: "policy.active",
      raw: String(policy.active),
      gloss: policy.active ? "policy ACTIVE" : "policy INACTIVE",
    },
    {
      name: "policy.validUntil",
      raw: policy.validUntil.toString(),
      gloss: `expires ${new Date(Number(policy.validUntil) * 1000).toISOString()}`,
    },
    {
      name: "policy.maxPerPayment",
      raw: policy.maxPerPayment.toString(),
      gloss: `${formatUsdc(policy.maxPerPayment)} per deposit`,
    },
    {
      name: "policy.maxPerWindow",
      raw: policy.maxPerWindow.toString(),
      gloss: `${formatUsdc(policy.maxPerWindow)} per window`,
    },
    {
      name: "policy.shareReceiver",
      raw: policy.shareReceiver,
      gloss: `shares -> ${shorten(policy.shareReceiver)}`,
    },
    {
      name: "policy.assetRecipient",
      raw: policy.assetRecipient,
      gloss: withdrawalsEnabled
        ? `withdrawn USDC -> ${shorten(policy.assetRecipient)} (WARNING: agent can move funds here on key compromise)`
        : "withdrawals DISABLED (assetRecipient unused)",
    },
    {
      name: "policy.maxWithdrawPerPayment",
      raw: policy.maxWithdrawPerPayment.toString(),
      gloss: withdrawalsEnabled
        ? `${formatShares(policy.maxWithdrawPerPayment)} per withdrawal`
        : "withdrawals DISABLED (no per-call cap)",
    },
    {
      name: "policy.maxWithdrawPerWindow",
      raw: policy.maxWithdrawPerWindow.toString(),
      gloss: withdrawalsEnabled
        ? `${formatShares(policy.maxWithdrawPerWindow)} per window (max stolen on agent-key compromise)`
        : "withdrawals DISABLED (no per-window cap)",
    },
  ];
}

/** The post-state sentence for `agent` holding AGENT_ROLE under `policy`. */
function policyEffect(agent: Address, policy: AgentPolicy): string {
  const expiryIso = new Date(Number(policy.validUntil) * 1000).toISOString();
  if (isWithdrawalEnabled(policy)) {
    // WARNING is load-bearing — the test asserts it appears
    // verbatim in the effect copy so a regression in this
    // string is caught at CI time. See security review §5.
    return (
      `Address ${shorten(agent)} will hold AGENT_ROLE and can call deposit() AND withdraw() within policy caps until ${expiryIso}. ` +
      `WARNING: withdrawals enabled — up to ${formatShares(policy.maxWithdrawPerWindow)} per window can be redeemed by this agent to ${shorten(policy.assetRecipient)} (assetRecipient). ` +
      "If the agent key is compromised, an attacker can drain shares up to the per-window cap. Keep assetRecipient under your sole control and revoke gateway share allowance when unused."
    );
  }
  return `Address ${shorten(agent)} will hold AGENT_ROLE; this lets it call deposit() within policy caps until ${expiryIso}. Withdrawals DISABLED (maxWithdrawPerPayment = 0).`;
}

/**
 * Per-role grant effect text. Names the post-state delta in one line so
 * the operator can sanity-check before signing (per ADR §3.3 row
 * "role/policy effect").
 */
function roleEffectGrant(role: RoleName, account: Address): string {
  const who = shorten(account);
  switch (role) {
    case "ADMIN_ROLE":
      return `Address ${who} will hold ADMIN_ROLE; this lets it authorize/revoke agents, edit policy, and call unpauseDeposits(). Mutually exclusive with AGENT_ROLE and DEPOSIT_PAUSER_ROLE on the same account (enforced by AccessRoles._grantRole).`;
    case "DEPOSIT_PAUSER_ROLE":
      return `Address ${who} will hold DEPOSIT_PAUSER_ROLE; this lets it call pauseDeposits(), which stops new deposits only and never blocks a withdrawal (asymmetric — unpauseDeposits requires ADMIN_ROLE). Mutually exclusive with AGENT_ROLE and ADMIN_ROLE on the same account.`;
  }
}

/** Per-role revoke effect text. Mirrors roleEffectGrant. */
function roleEffectRevoke(role: RoleName, account: Address): string {
  const who = shorten(account);
  switch (role) {
    case "ADMIN_ROLE":
      return `Address ${who} loses ADMIN_ROLE; subsequent authorizeAgent/revokeAgent/unpauseDeposits calls from this account revert. The contract still requires at least one DEFAULT_ADMIN_ROLE holder for recovery.`;
    case "DEPOSIT_PAUSER_ROLE":
      return `Address ${who} loses DEPOSIT_PAUSER_ROLE; subsequent pauseDeposits() calls from this account revert. Other DEPOSIT_PAUSER_ROLE holders (if any) are unaffected.`;
  }
}

function shorten(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}
