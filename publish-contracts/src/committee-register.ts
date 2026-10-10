// The govern row `register-committee` (issue 1727): the Safe, through the timelock, registers the consensus receipt SUBMITTER as ONE batch of two ADMIN_ROLE calls on the gateway:
//   1. RobotMoneyGateway.authorizeAgent(submitter, policy)   gives AGENT_ROLE (the gateway's consensusRecordReceipt is onlyRole(AGENT_ROLE)).
//   2. RobotMoneyGateway.committeeRegister(submitter, label) forwards to InvestmentCommitteePolicy.registerAgent: gives COMMITTEE_AGENT_ROLE (the receipt contract checks it).
// Those two together are the whole authority to anchor a receipt (docs/technical/consensus-receipt-submitter-runbook.md section 1; rotation step 2). The old `rmpc committee register` is gone.
//
// THE POLICY IS THE SMALLEST LEGAL ONE. authorizeAgent needs a valid policy (the gateway refuses zero caps), so the submitter gets the smallest legal one: 1 unit of USDC per payment and
// per window, no withdrawals, no destinations, shares to the timelock, valid for 90 days. AGENT_ROLE on the gateway lets the submitter anchor receipts (consensusRecordReceipt) and, with COMMITTEE_AGENT_ROLE, post allocation-signalling votes (committeeVoteSubmit). Its deposit and withdraw calls are capped at 1 raw unit and move only its own funds. There is no value path from the timelock or the Safe to the submitter, and the policy cannot be widened without another timelock round.
// The agent OWNER recorded on chain is the timelock (the caller of authorizeAgent). This is an ADMIN action through the Safe and the timelock, not a depositor authorization.
// Pure module: it reads no chain and sends nothing.
import { encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import { PublishError } from "./errors.ts";

export const REGISTER_ROW = "register-committee";
/** The policy's validity from the schedule time. A longer rehearsal never needs more; the verb to extend it is another timelock round. */
export const SUBMITTER_POLICY_SECONDS = 90 * 24 * 3600;
export const SUBMITTER_POLICY_CAP = 1n;

export const GATEWAY_REGISTER_ABI = parseAbi([
  "function authorizeAgent(address agent, (bool active, uint64 validUntil, uint256 maxPerPayment, uint256 maxPerWindow, address shareReceiver, address[] allowedDestinations, address assetRecipient, uint256 maxWithdrawPerPayment, uint256 maxWithdrawPerWindow, address[] allowedSourceVaults) p)",
  "function committeeRegister(address agent, string agentId_)",
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

/** The two calls of the batch, in order. `timelock` is the policy's shareReceiver and, on chain, the agent owner. */
export function buildRegisterCalls(gateway: Address, timelock: Address, submitter: Address, agentLabel: string, validUntil: bigint): RegisterCall[] {
  const policy = {
    active: true, validUntil, maxPerPayment: SUBMITTER_POLICY_CAP, maxPerWindow: SUBMITTER_POLICY_CAP, shareReceiver: timelock, allowedDestinations: [] as Address[],
    assetRecipient: "0x0000000000000000000000000000000000000000" as Address, maxWithdrawPerPayment: 0n, maxWithdrawPerWindow: 0n, allowedSourceVaults: [] as Address[],
  };
  return [
    { label: `gateway.authorizeAgent(${submitter})`, target: gateway, data: encodeFunctionData({ abi: GATEWAY_REGISTER_ABI, functionName: "authorizeAgent", args: [submitter, policy] }) },
    { label: `gateway.committeeRegister(${submitter}, ${agentLabel})`, target: gateway, data: encodeFunctionData({ abi: GATEWAY_REGISTER_ABI, functionName: "committeeRegister", args: [submitter, agentLabel] }) },
  ];
}

/** Read-back problems after the round executed: both roles held, the label stored, the timelock the agent owner. An empty list is a pass. */
export function registerReadBackProblems(s: { agentRole: boolean; committeeRole: boolean; label: string; wantLabel: string; owner: string; timelock: string }): string[] {
  const bad: string[] = [];
  if (!s.agentRole) bad.push("gateway.hasRole(AGENT_ROLE, submitter) is false");
  if (!s.committeeRole) bad.push("icPolicy.hasRole(COMMITTEE_AGENT_ROLE, submitter) is false");
  if (s.label !== s.wantLabel) bad.push(`icPolicy.agentId(submitter) is '${s.label}', want '${s.wantLabel}'`);
  if (s.owner.toLowerCase() !== s.timelock.toLowerCase()) bad.push(`gateway.agentOwner(submitter) is ${s.owner}, want the timelock ${s.timelock}`);
  return bad;
}
