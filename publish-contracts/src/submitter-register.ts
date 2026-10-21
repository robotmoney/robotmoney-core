// The govern row `register-submitter` (issue 1888): the consensus receipt SUBMITTER SAFE gets RECEIPT_SUBMITTER_ROLE on the receipt contract through ONE delayed timelock call,
//   ConsensusRecommendationReceipt.grantRole(RECEIPT_SUBMITTER_ROLE, submitter)
// scheduled by the governing Safe through the timelock (the timelock alone holds the receipt's ADMIN_ROLE, which administers the role). There is no gateway, no committee registry, no
// agent authorization and no private first half: the old `register-committee` batch (setPolicy, committeeRegister, and the commit/reveal/hand-over before it) is gone. See
// committee-register.ts for the historical shape evidence-check still decodes. Docs: docs/technical/consensus-receipt-submitter-runbook.md.
// The submitter Safe MAY be the governing Safe, and the owners MAY be shared with it. Pure module: it reads no chain and sends nothing.
import { encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import { PublishError } from "./errors.ts";
import { RECEIPT_SUBMITTER_ROLE } from "./record-receipt.ts";

export const REGISTER_ROW = "register-submitter";

export const RECEIPT_ROLE_ABI = parseAbi([
  "function grantRole(bytes32 role, address account)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function getRoleAdmin(bytes32 role) view returns (bytes32)",
]);

/** The run-manifest key and salt input of one submitter's registration round. One submitter is one operation. */
export const registerRecordKey = (submitter: string): string => `${REGISTER_ROW}-${getAddress(submitter).toLowerCase()}`;

export function assertSubmitter(a: string | undefined): Address {
  if (!a || !/^0x[0-9a-fA-F]{40}$/.test(a) || /^0x0{40}$/.test(a)) throw new PublishError("USAGE", `--submitter must be the submitter Safe's address (0x, 40 hex, not zero), got '${a ?? ""}'`);
  return getAddress(a);
}

export interface RegisterCall { label: string; target: Address; data: Hex }

/** The ONE call of the round: receipt.grantRole(RECEIPT_SUBMITTER_ROLE, submitter). */
export function buildRegisterCall(receipt: Address, submitter: Address): RegisterCall {
  return { label: `receipt.grantRole(RECEIPT_SUBMITTER_ROLE, ${submitter})`, target: receipt, data: encodeFunctionData({ abi: RECEIPT_ROLE_ABI, functionName: "grantRole", args: [RECEIPT_SUBMITTER_ROLE, submitter] }) };
}

/** Read-back problems after the round executed: the submitter holds the role. An empty list is a pass. */
export function registerReadBackProblems(s: { submitterRole: boolean }): string[] {
  return s.submitterRole ? [] : ["receipt.hasRole(RECEIPT_SUBMITTER_ROLE, submitter) is false"];
}
