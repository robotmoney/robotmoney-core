// The govern row `register-committee` (issue 1727): the consensus receipt SUBMITTER gets the two roles that anchor a receipt, in TWO halves (QA plan v1 B6, review CS-2).
//
// 1. PRIVATE, before anything is public: the submitter Safe authorizes ITSELF on the gateway and hands the agent to the timelock. Three submitter-Safe transactions:
//      RobotMoneyGateway.commitAuthorization(keccak256(abi.encode(submitter, submitter, salt)))   the commit names no agent (a random salt hides it)
//      RobotMoneyGateway.revealAuthorization(submitter, salt, policy, "")   at least one block later: the Safe owns its own agent and holds AGENT_ROLE
//      RobotMoneyGateway.transferAgentOwnership(submitter, timelock)    the timelock (an ADMIN_ROLE holder) owns it from here on
//    The commitment is bound to the committer (the hash carries msg.sender), so nobody else can reveal it. The reveal policy pays shares to the Safe itself (a caller
//    without ADMIN_ROLE must name itself, RobotMoneyGateway._validatePolicy); the public batch moves them to the timelock.
// 2. PUBLIC: the Safe, through the timelock, runs ONE batch of two ADMIN_ROLE calls on the gateway:
//      RobotMoneyGateway.setPolicy(submitter, policy)            the signalling-only policy below (the timelock is the agent owner, so it may write it)
//      RobotMoneyGateway.committeeRegister(submitter, label)     forwards to InvestmentCommitteePolicy.registerAgent: gives COMMITTEE_AGENT_ROLE (the receipt contract checks it)
// WHY. The old batch scheduled authorizeAgent(submitter) in public. During the timelock delay anyone could commit and reveal an authorization for that address first:
// the batch then reverted AgentAlreadyOwned after the whole delay, and the squatter, as the agent owner, could revokeAgent at will (the gateway has no seize path).
// Two layers close it. The gateway's agent-consent check (issue 1791) refuses a stranger's reveal for an address other than itself without that address's signature,
// and a Safe has no key to sign with. And the batch carries no first-time authorization at all: the timelock owns the agent before the batch is visible, so no write
// a stranger can make breaks it (contracts/test/ConsensusReceiptSafeSubmitter.t.sol::test_publicRegisterBatchCannotBeFrontRun). An address another account already
// owns is caught before anything is scheduled (selfAuthStateOf "squatted": no timelock round is spent, the operator creates a new submitter Safe).
// Those two roles together are the whole authority to anchor a receipt (docs/technical/consensus-receipt-submitter-runbook.md section 1; rotation step 2). The old `rmpc committee register` is gone.
//
// THE POLICY IS THE SMALLEST LEGAL ONE. The gateway refuses zero caps, so the submitter gets the smallest legal policy: 1 unit of USDC per payment and
// per window, no withdrawals, no destinations, shares to the timelock (to the Safe itself between the private reveal and the public batch), valid for 90 days. AGENT_ROLE on the gateway lets the submitter anchor receipts (consensusRecordReceipt) and, with COMMITTEE_AGENT_ROLE, post allocation-signalling votes (committeeVoteSubmit). Withdrawals are disabled (the policy's withdraw caps are 0, so withdraw reverts WithdrawalNotEnabled); deposits are capped at 1 raw unit of USDC per payment and per window, paid from the submitter's own funds, with the shares going to the timelock. There is no value path from the timelock or the Safe to the submitter, and the policy cannot be widened without another timelock round.
// The agent OWNER recorded on chain is the timelock (the private hand-over). This is an ADMIN action through the Safe and the timelock, not a depositor authorization.
// Pure module: it reads no chain and sends nothing.
import { encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, type Address, type Hex } from "viem";
import { PublishError } from "./errors.ts";

export const REGISTER_ROW = "register-committee";
/** The policy's validity from the schedule time. A longer rehearsal never needs more; the verb to extend it is another timelock round. */
export const SUBMITTER_POLICY_SECONDS = 90 * 24 * 3600;
export const SUBMITTER_POLICY_CAP = 1n;
/** RobotMoneyGateway.COMMIT_EXPIRY_BLOCKS: a commitment can be revealed up to this many blocks after the commit block. */
export const COMMIT_EXPIRY_BLOCKS = 256n;
/** A stored commitment is reused only while at least this many blocks of its window are left, so the reveal still lands inside it. */
export const COMMIT_REVEAL_MARGIN_BLOCKS = 16n;

const POLICY = "(bool active, uint64 validUntil, uint256 maxPerPayment, uint256 maxPerWindow, address shareReceiver, address[] allowedDestinations, address assetRecipient, uint256 maxWithdrawPerPayment, uint256 maxWithdrawPerWindow, address[] allowedSourceVaults)";
export const GATEWAY_REGISTER_ABI = parseAbi([
  // authorizeAgent is no longer built (QA plan v1 B6): it stays here so a fake chain and old evidence can still decode it
  `function authorizeAgent(address agent, ${POLICY} p)`,
  `function setPolicy(address agent, ${POLICY} p)`,
  "function committeeRegister(address agent, string agentId_)",
  "function commitAuthorization(bytes32 commitHash)",
  // issue 1791: the agent's consent signature is the fourth argument; an agent revealing for itself (the Safe here) passes empty bytes
  `function revealAuthorization(address agent, bytes32 salt, ${POLICY} p, bytes agentConsent)`,
  "function transferAgentOwnership(address agent, address newOwner)",
  "function commitments(bytes32 key) view returns (address committer, uint64 blockNumber)",
  "function agents(address agent) view returns (bool active, uint64 validUntil, uint256 maxPerPayment, uint256 maxPerWindow, address shareReceiver, address assetRecipient, uint256 maxWithdrawPerPayment, uint256 maxWithdrawPerWindow)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function agentOwner(address agent) view returns (address)",
  "function icPolicy() view returns (address)",
]);
export const IC_REGISTER_ABI = parseAbi([
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function agentId(address agent) view returns (string)",
]);

/** The run-manifest key and salt input of one submitter's registration round. One submitter is one operation. */
export const registerRecordKey = (submitter: string): string => `${REGISTER_ROW}-${getAddress(submitter).toLowerCase()}`;

export const LABEL = /^[A-Za-z0-9._-]{1,64}$/;
export function assertSubmitter(a: string | undefined): Address {
  if (!a || !/^0x[0-9a-fA-F]{40}$/.test(a) || /^0x0{40}$/.test(a)) throw new PublishError("USAGE", `--submitter must be the submitter's address (0x, 40 hex, not zero), got '${a ?? ""}'`);
  return getAddress(a);
}
export function assertAgentLabel(l: string | undefined): string {
  const v = l ?? "committee-submitter";
  if (!LABEL.test(v)) throw new PublishError("USAGE", `--agent-label must be 1 to 64 characters of letters, digits . _ -, got '${v}'`);
  return v;
}

export interface RegisterCall { label: string; target: Address; data: Hex }

/** The signalling-only policy, paying shares to `shareReceiver`: the Safe itself in the private reveal, the timelock in the public batch. */
export function submitterPolicy(shareReceiver: Address, validUntil: bigint) {
  return {
    active: true, validUntil, maxPerPayment: SUBMITTER_POLICY_CAP, maxPerWindow: SUBMITTER_POLICY_CAP, shareReceiver, allowedDestinations: [] as Address[],
    assetRecipient: "0x0000000000000000000000000000000000000000" as Address, maxWithdrawPerPayment: 0n, maxWithdrawPerWindow: 0n, allowedSourceVaults: [] as Address[],
  };
}

/**
 * The two calls of the PUBLIC batch, in order. `timelock` is the policy's shareReceiver and, on chain, the agent owner (the private hand-over made it so, and setPolicy
 * reverts NotAgentOwner otherwise). No first-time authorization is in it, so nothing a stranger does during the delay can make it revert (QA plan v1 B6).
 */
export function buildRegisterCalls(gateway: Address, timelock: Address, submitter: Address, agentLabel: string, validUntil: bigint): RegisterCall[] {
  return [
    { label: `gateway.setPolicy(${submitter})`, target: gateway, data: encodeFunctionData({ abi: GATEWAY_REGISTER_ABI, functionName: "setPolicy", args: [submitter, submitterPolicy(timelock, validUntil)] }) },
    { label: `gateway.committeeRegister(${submitter}, ${agentLabel})`, target: gateway, data: encodeFunctionData({ abi: GATEWAY_REGISTER_ABI, functionName: "committeeRegister", args: [submitter, agentLabel] }) },
  ];
}

/** The commit hash the gateway rebuilds in revealAuthorization: keccak256(abi.encode(agent, msg.sender, salt)), here with the Safe as both agent and committer. */
export const selfAuthCommitHash = (submitter: Address, salt: Hex): Hex =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "bytes32" }], [submitter, submitter, salt]));
/** The gateway's `commitments` key of a commit hash: keccak256(abi.encode(commitHash, committer)) (RobotMoneyGateway._commitmentKey). */
export const selfAuthCommitmentKey = (commitHash: Hex, committer: Address): Hex =>
  keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }], [commitHash, committer]));

/** The three PRIVATE calls, each a transaction of the submitter Safe to the gateway, in order: commit, reveal (a later block), hand-over to the timelock. */
export function buildSelfAuthCalls(gateway: Address, timelock: Address, submitter: Address, salt: Hex, validUntil: bigint): { commit: RegisterCall; reveal: RegisterCall; handOver: RegisterCall } {
  return {
    commit: { label: `gateway.commitAuthorization(<hidden agent>)`, target: gateway, data: encodeFunctionData({ abi: GATEWAY_REGISTER_ABI, functionName: "commitAuthorization", args: [selfAuthCommitHash(submitter, salt)] }) },
    reveal: { label: `gateway.revealAuthorization(${submitter})`, target: gateway, data: encodeFunctionData({ abi: GATEWAY_REGISTER_ABI, functionName: "revealAuthorization", args: [submitter, salt, submitterPolicy(submitter, validUntil), "0x"] }) },
    handOver: { label: `gateway.transferAgentOwnership(${submitter}, ${timelock})`, target: gateway, data: encodeFunctionData({ abi: GATEWAY_REGISTER_ABI, functionName: "transferAgentOwnership", args: [submitter, timelock] }) },
  };
}

/**
 * Where the private half stands, from the gateway's agentOwner(submitter) and hasRole(AGENT_ROLE, submitter):
 *   fresh         no owner, no AGENT_ROLE: commit and reveal, then hand over
 *   self-owned    the Safe owns its own agent (the reveal landed): hand over
 *   handed-over   the timelock owns it: the private half is done, the batch may be scheduled
 *   squatted      another account owns it: someone authorized the address first. The gateway has no seize path, so this submitter can never be registered
 *   foreign-role  AGENT_ROLE with no owner: the role came from somewhere else
 */
export type SelfAuthState = "fresh" | "self-owned" | "handed-over" | "squatted" | "foreign-role";
export function selfAuthStateOf(s: { owner: string; agentRole: boolean; submitter: string; timelock: string }): SelfAuthState {
  const lc = (x: string) => x.toLowerCase();
  if (/^0x0{40}$/i.test(s.owner)) return s.agentRole ? "foreign-role" : "fresh";
  if (lc(s.owner) === lc(s.submitter)) return "self-owned";
  if (lc(s.owner) === lc(s.timelock)) return "handed-over";
  return "squatted";
}

/**
 * A handed-over agent is taken as this submitter's only when its stored policy is the signalling-only shape (caps 1, no withdrawals, shares to the Safe or the
 * timelock): a depositor's agent the timelock owns (a genesis agent) is refused instead of having its policy overwritten by the batch. Empty list: the shape holds.
 */
export function selfAuthPolicyProblems(p: { maxPerPayment: bigint; maxPerWindow: bigint; shareReceiver: string; maxWithdrawPerPayment: bigint; maxWithdrawPerWindow: bigint }, submitter: string, timelock: string): string[] {
  const bad: string[] = [];
  if (p.maxPerPayment !== SUBMITTER_POLICY_CAP || p.maxPerWindow !== SUBMITTER_POLICY_CAP) bad.push(`caps ${p.maxPerPayment}/${p.maxPerWindow}, the submitter policy is ${SUBMITTER_POLICY_CAP}/${SUBMITTER_POLICY_CAP}`);
  if (p.maxWithdrawPerPayment !== 0n || p.maxWithdrawPerWindow !== 0n) bad.push("withdrawals are enabled");
  if (![submitter.toLowerCase(), timelock.toLowerCase()].includes(p.shareReceiver.toLowerCase())) bad.push(`shares go to ${p.shareReceiver}`);
  return bad;
}

/** The private half as the run manifest keeps it (govern state only). The salt is written BEFORE the commit is sent, so a run that dies after the commit lands can still reveal. */
export interface SelfAuthPhase { tx_hash?: string; safe_tx_hash?: string; status?: number; at: string; block?: number }
export interface SelfAuthRecord { salt?: Hex; commit?: SelfAuthPhase; reveal?: SelfAuthPhase; hand_over?: SelfAuthPhase }
/** The evidence form (`committee_registrations[].self_authorization`): the three transactions, never the salt. */
export function selfAuthEvidence(r: SelfAuthRecord | undefined): { commit_tx?: string; reveal_tx?: string; hand_over_tx?: string } | undefined {
  if (!r || (!r.commit?.tx_hash && !r.reveal?.tx_hash && !r.hand_over?.tx_hash)) return undefined;
  return { ...(r.commit?.tx_hash ? { commit_tx: r.commit.tx_hash } : {}), ...(r.reveal?.tx_hash ? { reveal_tx: r.reveal.tx_hash } : {}), ...(r.hand_over?.tx_hash ? { hand_over_tx: r.hand_over.tx_hash } : {}) };
}

/** Read-back problems after the round executed: both roles held, the label stored, the timelock the agent owner and (when read) the share receiver. An empty list is a pass. */
export function registerReadBackProblems(s: { agentRole: boolean; committeeRole: boolean; label: string; wantLabel: string; owner: string; timelock: string; shareReceiver?: string }): string[] {
  const bad: string[] = [];
  if (!s.agentRole) bad.push("gateway.hasRole(AGENT_ROLE, submitter) is false");
  if (!s.committeeRole) bad.push("icPolicy.hasRole(COMMITTEE_AGENT_ROLE, submitter) is false");
  if (s.label !== s.wantLabel) bad.push(`icPolicy.agentId(submitter) is '${s.label}', want '${s.wantLabel}'`);
  if (s.owner.toLowerCase() !== s.timelock.toLowerCase()) bad.push(`gateway.agentOwner(submitter) is ${s.owner}, want the timelock ${s.timelock}`);
  if (s.shareReceiver !== undefined && s.shareReceiver.toLowerCase() !== s.timelock.toLowerCase()) bad.push(`gateway.agents(submitter).shareReceiver is ${s.shareReceiver}, want the timelock ${s.timelock}`);
  return bad;
}
