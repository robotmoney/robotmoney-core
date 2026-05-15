/**
 * Calldata-preview pipeline. Implements the fixed shape required by
 * docs/technical/dapp-credential-decisions.md §3.3 — every admin/policy
 * tx renders target, function, decoded args, role/policy effect, risk
 * class, and raw calldata. Decoder failure is a HARD refusal; callers
 * must never fall back to raw-calldata signing.
 */
import { decodeFunctionData, encodeFunctionData, getAddress, toFunctionSelector } from "viem";
import type { Address, Hex } from "viem";
import { gatewayAbi, ROLE_HASH } from "./abi";
import type { AdminActionName, RoleName, VaultActionName } from "./abi";

/**
 * Union of every function name that may appear in a structured Preview.
 * Gateway admin actions cover the depositor-owned authorize/revoke/policy
 * surface and the pause/role kill switches; vault actions cover the
 * ERC-4626 deposit/redeem entrypoints driven by the Deposit/Withdraw tab
 * (issue #257). Both flow through the same TxPreview component, so the
 * preview success type accepts either.
 */
export type PreviewFunctionName = AdminActionName | VaultActionName;

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
  | { kind: "revokeAgent"; agent: Address }
  | { kind: "pause" }
  | { kind: "unpause" }
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
  reason: string;
  /** Always present even on failure so the operator can paste into a second tool. */
  calldata?: Hex;
}

export type Preview = PreviewSuccess | PreviewFailure;

export interface PreviewContext {
  /** Gateway contract address. */
  gateway: Address;
  /** Whether the on-chain bytecode hash matches the pinned harness fixture. */
  gatewayCodeHashVerified: boolean;
  /** "fork" / "devnet" => low-stakes envs; mainnet/testnet => higher risk. */
  envClass: "fork" | "devnet" | "testnet" | "mainnet";
}

/**
 * Risk classifier. Implements the fixed table in §3.3:
 *   - unsafe: pause/unpause on non-fork without a recent self-check (we
 *     conservatively mark non-fork pause/unpause as unsafe here; the
 *     self-check freshness check is enforced by rmpc, not the dapp).
 *   - high:   granting AGENT_ROLE policy with a per-window cap above
 *             threshold, or unverified bytecode.
 *   - medium: standard authorizeAgent below threshold.
 *   - low:    revokeAgent, pause on a fork.
 */
const HIGH_CAP_THRESHOLD = 1_000_000_000n; // 1,000 USDC in 6dp

export function classifyRisk(action: AdminAction, ctx: PreviewContext): RiskClass {
  if (!ctx.gatewayCodeHashVerified) return "unsafe";
  switch (action.kind) {
    case "pause":
    case "unpause":
      return ctx.envClass === "fork" ? "low" : "unsafe";
    case "revokeAgent":
      return "low";
    case "authorizeAgent":
      return action.policy.maxPerWindow > HIGH_CAP_THRESHOLD ? "high" : "medium";
    case "grantRole":
      // Granting any admin-tier role is "high" per ADR §3.3 risk table
      // ("granting any admin role"). PAUSER is treated identically — it
      // is privileged, even if its only power is `pause()`.
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
      reason:
        "Gateway bytecode hash does not match the pinned fixture. Refusing to surface a signing prompt.",
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
          {
            name: "policy.active",
            raw: String(action.policy.active),
            gloss: action.policy.active ? "policy ACTIVE" : "policy INACTIVE",
          },
          {
            name: "policy.validUntil",
            raw: action.policy.validUntil.toString(),
            gloss: `expires ${new Date(Number(action.policy.validUntil) * 1000).toISOString()}`,
          },
          {
            name: "policy.maxPerPayment",
            raw: action.policy.maxPerPayment.toString(),
            gloss: `${formatUsdc(action.policy.maxPerPayment)} per deposit`,
          },
          {
            name: "policy.maxPerWindow",
            raw: action.policy.maxPerWindow.toString(),
            gloss: `${formatUsdc(action.policy.maxPerWindow)} per window`,
          },
          {
            name: "policy.shareReceiver",
            raw: action.policy.shareReceiver,
            gloss: `shares -> ${shorten(action.policy.shareReceiver)}`,
          },
        ];
        effect = `Address ${shorten(action.agent)} will hold AGENT_ROLE; this lets it call deposit() within policy caps until ${new Date(Number(action.policy.validUntil) * 1000).toISOString()}.`;
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
      case "pause":
        functionName = "pause";
        calldata = encodeFunctionData({ abi: gatewayAbi, functionName: "pause", args: [] });
        args = [];
        effect = "Gateway enters paused state; deposit() reverts until unpause() is called.";
        break;
      case "unpause":
        functionName = "unpause";
        calldata = encodeFunctionData({ abi: gatewayAbi, functionName: "unpause", args: [] });
        args = [];
        effect =
          "Gateway exits paused state; deposit() resumes for AGENT_ROLE holders within policy.";
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
  } catch (err) {
    return { ok: false, reason: `Encoding failed: ${(err as Error).message}` };
  }

  // Re-decode round-trip to guarantee the preview shape stays consistent.
  let selector: Hex;
  try {
    const decoded = decodeFunctionData({ abi: gatewayAbi, data: calldata });
    if (decoded.functionName !== functionName) {
      return { ok: false, reason: "Decoder mismatch", calldata };
    }
    selector = toFunctionSelector(
      gatewayAbi.find((e) => e.type === "function" && e.name === functionName) as never,
    );
  } catch (err) {
    return { ok: false, reason: `Decode round-trip failed: ${(err as Error).message}`, calldata };
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
 * Per-role grant effect text. Names the post-state delta in one line so
 * the operator can sanity-check before signing (per ADR §3.3 row
 * "role/policy effect").
 */
function roleEffectGrant(role: RoleName, account: Address): string {
  const who = shorten(account);
  switch (role) {
    case "ADMIN_ROLE":
      return `Address ${who} will hold ADMIN_ROLE; this lets it authorize/revoke agents, edit policy, and call unpause(). Mutually exclusive with AGENT_ROLE and PAUSER_ROLE on the same account (enforced by AccessRoles._grantRole).`;
    case "PAUSER_ROLE":
      return `Address ${who} will hold PAUSER_ROLE; this lets it call pause() (asymmetric — unpause requires ADMIN_ROLE). Mutually exclusive with AGENT_ROLE and ADMIN_ROLE on the same account.`;
  }
}

/** Per-role revoke effect text. Mirrors roleEffectGrant. */
function roleEffectRevoke(role: RoleName, account: Address): string {
  const who = shorten(account);
  switch (role) {
    case "ADMIN_ROLE":
      return `Address ${who} loses ADMIN_ROLE; subsequent authorizeAgent/revokeAgent/unpause calls from this account revert. The contract still requires at least one DEFAULT_ADMIN_ROLE holder for recovery.`;
    case "PAUSER_ROLE":
      return `Address ${who} loses PAUSER_ROLE; subsequent pause() calls from this account revert. Other PAUSER_ROLE holders (if any) are unaffected.`;
  }
}

function shorten(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatUsdc(raw: bigint): string {
  const whole = raw / 1_000_000n;
  const frac = raw % 1_000_000n;
  return `${whole}.${frac.toString().padStart(6, "0")} USDC`;
}
