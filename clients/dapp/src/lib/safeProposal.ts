// Canonical: docs/technical/dapp-credential-decisions.md §3.2 (Safe-signable admin proposals), §3.3

/**
 * safeProposal — the pure core of the "Create Safe proposal" flow (core 1544).
 *
 * After the timelock handover only the 2-of-3 Safe acts through the
 * TimelockController, on every chain. An admin action is therefore not a wallet
 * transaction. It is a Safe transaction whose only call is
 * `timelock.schedule(target, 0, data, predecessor, salt, delay)` (and later
 * `timelock.execute(target, 0, data, predecessor, salt)`). This module builds
 * that payload, the SafeTx EIP-712 typed data an owner signs with
 * `eth_signTypedData_v4`, the local digest, the ascending signature packing, and
 * the `robotmoney-safe-tx/1` bundle. It performs no I/O and holds no key. The
 * dapp stays a non-custodial previewer: nothing here signs.
 *
 * Policy (identical to publish-contracts/src/safe, which this mirrors): the Safe
 * call is a CALL (operation 0) to the configured timelock with value 0 and every
 * gas, refund and token field zero. Anything else is refused before typed data
 * exists, so no signature can ever cover it.
 *
 * Salt rule. The salt is deterministic: keccak256 of a domain label, the chain
 * id, the Safe, the Safe nonce, the target and the inner calldata. It is unique
 * per Safe nonce, so a grant that follows a revoke of the same account never
 * collides with the earlier (done) operation. It is reproducible, so a second
 * owner who rebuilds the proposal gets the same bytes. It needs no randomness.
 *
 * The EIP-712 domain, both type hashes and the digest follow Safe v1.4.1
 * (`SafeL2`): domain `{ chainId, verifyingContract }` only.
 */
import {
  concat,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  isAddress,
  isHex,
  keccak256,
  parseAbi,
  recoverAddress,
  toBytes,
  toHex,
  type Address,
  type Hex,
} from "viem";

// ─── Constants ────────────────────────────────────────────────────────────────

export const SAFE_VERSION = "1.4.1" as const;
export const BUNDLE_FORMAT = "robotmoney-safe-tx/1" as const;
export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
export const ZERO_BYTES32: Hex =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * The canonical SafeL2 v1.4.1 deployment. Mirrors `SAFE_141` in
 * publish-contracts/src/safe/constants.ts (the same address on every chain that
 * carries it, the Twin chain included). A Safe is canonical when its proxy
 * runtime code hashes to `proxyCodehash` and its slot 0 holds `singletonL2`.
 */
export const SAFE_L2_141 = {
  singletonL2: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762" as Address,
  proxyCodehash: "0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c" as Hex,
} as const;

export const EIP712_DOMAIN_TYPE = [
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

export const SAFE_TX_TYPE = [
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "data", type: "bytes" },
  { name: "operation", type: "uint8" },
  { name: "safeTxGas", type: "uint256" },
  { name: "baseGas", type: "uint256" },
  { name: "gasPrice", type: "uint256" },
  { name: "gasToken", type: "address" },
  { name: "refundReceiver", type: "address" },
  { name: "nonce", type: "uint256" },
] as const;

export const DOMAIN_SEPARATOR_TYPEHASH: Hex = keccak256(
  toBytes("EIP712Domain(uint256 chainId,address verifyingContract)"),
);
export const SAFE_TX_TYPEHASH: Hex = keccak256(
  toBytes(
    "SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)",
  ),
);

/** Safe v1.4.1 views and `execTransaction` the dapp reads or sends. */
export const safeAbi = parseAbi([
  "function VERSION() view returns (string)",
  "function nonce() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function isOwner(address owner) view returns (bool)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)",
]);

/** The TimelockController entry points the dapp encodes, plus the views it reads. */
export const timelockCallAbi = parseAbi([
  "function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt) payable",
  "function getMinDelay() view returns (uint256)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function hashOperation(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt) pure returns (bytes32)",
  "function isOperationReady(bytes32 id) view returns (bool)",
]);

export const PROPOSER_ROLE: Hex = keccak256(toBytes("PROPOSER_ROLE"));
export const EXECUTOR_ROLE: Hex = keccak256(toBytes("EXECUTOR_ROLE"));

// ─── Errors ───────────────────────────────────────────────────────────────────

export type SafeProposalErrorCode =
  | "CALL_NOT_ALLOWED"
  | "FIELD_NOT_ALLOWED"
  | "BAD_INPUT"
  | "DIGEST_MISMATCH"
  | "BUNDLE_INVALID"
  | "SIGNATURE_INVALID"
  | "NOT_OWNER";

export class SafeProposalError extends Error {
  readonly code: SafeProposalErrorCode;
  constructor(code: SafeProposalErrorCode, message: string) {
    super(message);
    this.name = "SafeProposalError";
    this.code = code;
  }
}

const lc = (s: string): string => s.toLowerCase();
const sameAddress = (a: string, b: string): boolean => lc(a) === lc(b);

// ─── Timelock calldata ────────────────────────────────────────────────────────

export interface TimelockOperation {
  readonly target: Address;
  /** The inner call: what the timelock performs on `target`. */
  readonly data: Hex;
  readonly predecessor: Hex;
  readonly salt: Hex;
}

export function encodeSchedule(op: TimelockOperation, delay: bigint): Hex {
  return encodeFunctionData({
    abi: timelockCallAbi,
    functionName: "schedule",
    args: [getAddress(op.target), 0n, op.data, op.predecessor, op.salt, delay],
  });
}

export function encodeExecute(op: TimelockOperation): Hex {
  return encodeFunctionData({
    abi: timelockCallAbi,
    functionName: "execute",
    args: [getAddress(op.target), 0n, op.data, op.predecessor, op.salt],
  });
}

/** OpenZeppelin `hashOperation(target, 0, data, predecessor, salt)`. */
export function timelockOperationId(op: TimelockOperation): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "bytes" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [getAddress(op.target), 0n, op.data, op.predecessor, op.salt],
    ),
  );
}

/** Deterministic salt (see the module doc). Unique per Safe nonce. */
export function proposalSalt(args: {
  readonly chainId: number;
  readonly safe: Address;
  readonly nonce: bigint;
  readonly target: Address;
  readonly data: Hex;
}): Hex {
  return keccak256(
    concat([
      toHex(toBytes("robotmoney-dapp-proposal/1")),
      encodeAbiParameters(
        [
          { type: "uint256" },
          { type: "address" },
          { type: "uint256" },
          { type: "address" },
          { type: "bytes32" },
        ],
        [
          BigInt(args.chainId),
          getAddress(args.safe),
          args.nonce,
          getAddress(args.target),
          keccak256(args.data),
        ],
      ),
    ]),
  );
}

// ─── SafeTx typed data ────────────────────────────────────────────────────────

/** Optional overrides exist only so the builder can refuse them. */
export interface BuildSafeTxInput {
  readonly chainId: number;
  readonly safe: Address;
  /** The configured timelock. The SafeTx `to` must be this address. */
  readonly timelock: Address;
  readonly to: Address;
  /** Timelock `schedule` or `execute` calldata. */
  readonly data: Hex;
  readonly nonce: bigint;
  readonly value?: bigint;
  readonly operation?: number;
  readonly safeTxGas?: bigint;
  readonly baseGas?: bigint;
  readonly gasPrice?: bigint;
  readonly gasToken?: Address;
  readonly refundReceiver?: Address;
}

export interface SafeTxMessage {
  readonly to: Address;
  readonly value: "0";
  readonly data: Hex;
  readonly operation: 0;
  readonly safeTxGas: "0";
  readonly baseGas: "0";
  readonly gasPrice: "0";
  readonly gasToken: Address;
  readonly refundReceiver: Address;
  readonly nonce: string;
}

export interface SafeTxTypedData {
  readonly types: {
    readonly EIP712Domain: typeof EIP712_DOMAIN_TYPE;
    readonly SafeTx: typeof SAFE_TX_TYPE;
  };
  readonly primaryType: "SafeTx";
  readonly domain: { readonly chainId: number; readonly verifyingContract: Address };
  readonly message: SafeTxMessage;
}

export interface SafeTxBuild {
  /** The eth_signTypedData_v4 document. */
  readonly typedData: SafeTxTypedData;
  /** `JSON.stringify(typedData)`, the exact string passed to the wallet. */
  readonly typedDataJson: string;
  readonly domainSeparator: Hex;
  readonly structHash: Hex;
  /** The Safe transaction hash: keccak256(0x1901 || domainSeparator || structHash). */
  readonly safeTxHash: Hex;
  readonly timelockFunction: "schedule" | "execute";
}

/** Which timelock entry point `data` is. Throws when it is neither. */
export function timelockFunctionOf(data: Hex): "schedule" | "execute" {
  let name: string;
  try {
    name = decodeFunctionData({ abi: timelockCallAbi, data }).functionName;
  } catch {
    throw new SafeProposalError(
      "CALL_NOT_ALLOWED",
      `calldata selector ${data.slice(0, 10)} is not a timelock schedule or execute call`,
    );
  }
  if (name !== "schedule" && name !== "execute") {
    throw new SafeProposalError(
      "CALL_NOT_ALLOWED",
      `timelock ${name} is not a proposal the dapp builds (only schedule and execute)`,
    );
  }
  return name;
}

/**
 * Build the SafeTx for a timelock call. Throws, and produces no typed data, for
 * a delegatecall, a non-zero value, a non-zero gas, refund or token field, a
 * `to` other than the configured timelock, or calldata that is not a timelock
 * schedule or execute.
 */
export function buildSafeTx(input: BuildSafeTxInput): SafeTxBuild {
  if (!Number.isInteger(input.chainId) || input.chainId <= 0) {
    throw new SafeProposalError(
      "BAD_INPUT",
      `chainId must be a positive integer, got ${input.chainId}`,
    );
  }
  if (!isAddress(input.safe) || !isAddress(input.timelock) || !isAddress(input.to)) {
    throw new SafeProposalError("BAD_INPUT", "safe, timelock and to must be addresses");
  }
  if (!isHex(input.data) || (input.data.length - 2) % 2 !== 0) {
    throw new SafeProposalError("BAD_INPUT", "data must be 0x hex calldata");
  }
  if (input.nonce < 0n) throw new SafeProposalError("BAD_INPUT", "nonce must not be negative");

  if ((input.operation ?? 0) !== 0) {
    throw new SafeProposalError(
      "FIELD_NOT_ALLOWED",
      "operation must be 0 (CALL). A delegatecall is never signed.",
    );
  }
  if ((input.value ?? 0n) !== 0n) {
    throw new SafeProposalError("FIELD_NOT_ALLOWED", "value must be 0. The proposal moves no ETH.");
  }
  for (const [name, v] of [
    ["safeTxGas", input.safeTxGas],
    ["baseGas", input.baseGas],
    ["gasPrice", input.gasPrice],
  ] as const) {
    if ((v ?? 0n) !== 0n) throw new SafeProposalError("FIELD_NOT_ALLOWED", `${name} must be 0`);
  }
  for (const [name, v] of [
    ["gasToken", input.gasToken],
    ["refundReceiver", input.refundReceiver],
  ] as const) {
    if (v !== undefined && !sameAddress(v, ZERO_ADDRESS)) {
      throw new SafeProposalError("FIELD_NOT_ALLOWED", `${name} must be the zero address`);
    }
  }
  if (!sameAddress(input.to, input.timelock)) {
    throw new SafeProposalError(
      "CALL_NOT_ALLOWED",
      `the SafeTx target ${input.to} is not the configured timelock ${input.timelock}`,
    );
  }
  const timelockFunction = timelockFunctionOf(input.data);

  const safe = getAddress(input.safe);
  const to = getAddress(input.to);
  const typedData: SafeTxTypedData = {
    types: { EIP712Domain: EIP712_DOMAIN_TYPE, SafeTx: SAFE_TX_TYPE },
    primaryType: "SafeTx",
    domain: { chainId: input.chainId, verifyingContract: safe },
    message: {
      to,
      value: "0",
      data: input.data,
      operation: 0,
      safeTxGas: "0",
      baseGas: "0",
      gasPrice: "0",
      gasToken: ZERO_ADDRESS,
      refundReceiver: ZERO_ADDRESS,
      nonce: input.nonce.toString(),
    },
  };

  // Two independent computations must agree, or nothing is returned.
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [DOMAIN_SEPARATOR_TYPEHASH, BigInt(input.chainId), safe],
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint8" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
      ],
      [
        SAFE_TX_TYPEHASH,
        to,
        0n,
        keccak256(input.data),
        0,
        0n,
        0n,
        0n,
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        input.nonce,
      ],
    ),
  );
  const safeTxHash = keccak256(concat(["0x1901", domainSeparator, structHash]));
  const viaViem = hashTypedData({
    domain: typedData.domain,
    types: { SafeTx: SAFE_TX_TYPE },
    primaryType: "SafeTx",
    message: {
      to,
      value: 0n,
      data: input.data,
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: ZERO_ADDRESS,
      refundReceiver: ZERO_ADDRESS,
      nonce: input.nonce,
    },
  });
  if (lc(viaViem) !== lc(safeTxHash)) {
    throw new SafeProposalError(
      "DIGEST_MISMATCH",
      "the two local EIP-712 computations disagree. Do not sign.",
    );
  }

  return {
    typedData,
    typedDataJson: JSON.stringify(typedData),
    domainSeparator,
    structHash,
    safeTxHash,
    timelockFunction,
  };
}

// ─── Signatures ───────────────────────────────────────────────────────────────

export interface BundleSignature {
  readonly owner: Address;
  readonly signature: Hex;
}

/**
 * Normalise a wallet signature to the Safe's EOA form: 65 bytes with v 27 or 28.
 * Some wallets return v as 0 or 1.
 */
export function toSafeSignature(sig: string): Hex {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) {
    throw new SafeProposalError(
      "SIGNATURE_INVALID",
      "a signature must be 65 bytes of hex (r, s, v)",
    );
  }
  const v = parseInt(sig.slice(130, 132), 16);
  const base = v === 0 || v === 1 ? v + 27 : v;
  if (base !== 27 && base !== 28) {
    throw new SafeProposalError(
      "SIGNATURE_INVALID",
      `unexpected recovery byte ${v}. The dapp packs only EOA signatures with v 27 or 28.`,
    );
  }
  return `0x${sig.slice(2, 130)}${base.toString(16).padStart(2, "0")}` as Hex;
}

/** The address a signature recovers to over `safeTxHash`. */
export async function recoverSigner(safeTxHash: Hex, signature: Hex): Promise<Address> {
  return recoverAddress({ hash: safeTxHash, signature: toSafeSignature(signature) });
}

function byOwnerAscending(a: BundleSignature, b: BundleSignature): number {
  return lc(a.owner) < lc(b.owner) ? -1 : lc(a.owner) > lc(b.owner) ? 1 : 0;
}

/** Add one owner's signature, replacing an earlier one from the same owner. Sorted ascending. */
export function addSignature(
  signatures: readonly BundleSignature[],
  next: BundleSignature,
): BundleSignature[] {
  return [...signatures.filter((s) => lc(s.owner) !== lc(next.owner)), next].sort(byOwnerAscending);
}

/** The `signatures` argument of `execTransaction`: ascending by owner address, 65 bytes each. */
export function packSignatures(signatures: readonly BundleSignature[]): Hex {
  const sorted = [...signatures].sort(byOwnerAscending);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev && cur && sameAddress(prev.owner, cur.owner)) {
      throw new SafeProposalError("SIGNATURE_INVALID", `owner ${cur.owner} signed twice`);
    }
  }
  return `0x${sorted.map((s) => toSafeSignature(s.signature).slice(2)).join("")}` as Hex;
}

// ─── Bundle: robotmoney-safe-tx/1 ─────────────────────────────────────────────

/** Public by design: addresses, calldata, the hash and signatures. Never a key. */
export interface SafeTxBundle {
  format: typeof BUNDLE_FORMAT;
  chain_id: number;
  safe: Address;
  safe_version: string;
  timelock?: Address;
  action: string;
  description: string;
  to: Address;
  value: "0";
  data: Hex;
  operation: 0;
  safe_tx_gas: "0";
  base_gas: "0";
  gas_price: "0";
  gas_token: Address;
  refund_receiver: Address;
  nonce: number;
  safe_tx_hash: Hex;
  timelock_operation_id?: Hex;
  timelock_min_delay?: string;
  threshold: number;
  owners: Address[];
  signatures: BundleSignature[];
  proposed_at: string;
}

export interface NewBundleInput {
  readonly chainId: number;
  readonly safe: Address;
  readonly timelock: Address;
  readonly to: Address;
  readonly data: Hex;
  readonly nonce: bigint;
  readonly safeTxHash: Hex;
  readonly action: string;
  readonly description: string;
  readonly operationId: Hex;
  readonly minDelay: bigint;
  readonly threshold: number;
  readonly owners: readonly Address[];
  /** ISO-8601, injected by the caller so this module reads no clock. */
  readonly proposedAt: string;
}

export function newBundle(i: NewBundleInput): SafeTxBundle {
  return {
    format: BUNDLE_FORMAT,
    chain_id: i.chainId,
    safe: getAddress(i.safe),
    safe_version: SAFE_VERSION,
    timelock: getAddress(i.timelock),
    action: i.action,
    description: i.description,
    to: getAddress(i.to),
    value: "0",
    data: i.data,
    operation: 0,
    safe_tx_gas: "0",
    base_gas: "0",
    gas_price: "0",
    gas_token: ZERO_ADDRESS,
    refund_receiver: ZERO_ADDRESS,
    nonce: Number(i.nonce),
    safe_tx_hash: i.safeTxHash,
    timelock_operation_id: i.operationId,
    timelock_min_delay: i.minDelay.toString(),
    threshold: i.threshold,
    owners: i.owners.map((o) => getAddress(o)),
    signatures: [],
    proposed_at: i.proposedAt,
  };
}

export function exportBundle(bundle: SafeTxBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Recompute the digest from a bundle's own fields and enforce the policy.
 * Throws unless the bundle is a CALL to its timelock with zero value, gas and
 * refund fields, a schedule or execute payload, and a `safe_tx_hash` equal to
 * the locally recomputed digest.
 */
export function verifyBundleFields(b: SafeTxBundle): SafeTxBuild {
  if (b.format !== BUNDLE_FORMAT) {
    throw new SafeProposalError("BUNDLE_INVALID", `not a ${BUNDLE_FORMAT} bundle`);
  }
  if (!b.timelock) throw new SafeProposalError("BUNDLE_INVALID", "the bundle names no timelock");
  if (
    b.value !== "0" ||
    b.operation !== 0 ||
    b.safe_tx_gas !== "0" ||
    b.base_gas !== "0" ||
    b.gas_price !== "0" ||
    !sameAddress(b.gas_token, ZERO_ADDRESS) ||
    !sameAddress(b.refund_receiver, ZERO_ADDRESS)
  ) {
    throw new SafeProposalError(
      "BUNDLE_INVALID",
      "the bundle carries a value, a delegatecall, or a gas, refund or token field",
    );
  }
  const built = buildSafeTx({
    chainId: b.chain_id,
    safe: b.safe,
    timelock: b.timelock,
    to: b.to,
    data: b.data,
    nonce: BigInt(b.nonce),
  });
  if (lc(built.safeTxHash) !== lc(b.safe_tx_hash)) {
    throw new SafeProposalError(
      "DIGEST_MISMATCH",
      "the bundle's safe_tx_hash does not match the digest of its own fields. Do not sign it.",
    );
  }
  return built;
}

/** Parse and shape-check bundle JSON. Does not verify the digest (see `verifyBundleFields`). */
export function parseBundle(json: string): SafeTxBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new SafeProposalError("BUNDLE_INVALID", "the bundle is not JSON");
  }
  if (!isRecord(raw) || raw.format !== BUNDLE_FORMAT) {
    throw new SafeProposalError("BUNDLE_INVALID", `not a ${BUNDLE_FORMAT} bundle`);
  }
  const addr = (v: unknown, name: string): Address => {
    if (typeof v !== "string" || !isAddress(v)) {
      throw new SafeProposalError("BUNDLE_INVALID", `bundle field ${name} is not an address`);
    }
    return getAddress(v);
  };
  const hex = (v: unknown, name: string): Hex => {
    if (typeof v !== "string" || !isHex(v)) {
      throw new SafeProposalError("BUNDLE_INVALID", `bundle field ${name} is not hex`);
    }
    return v;
  };
  const sigsRaw = raw.signatures;
  if (!Array.isArray(sigsRaw)) {
    throw new SafeProposalError("BUNDLE_INVALID", "the bundle has no signatures array");
  }
  const signatures: BundleSignature[] = sigsRaw.map((s: unknown) => {
    if (!isRecord(s))
      throw new SafeProposalError("BUNDLE_INVALID", "a signature entry is malformed");
    return {
      owner: addr(s.owner, "signatures[].owner"),
      signature: hex(s.signature, "signatures[].signature"),
    };
  });
  const ownersRaw = raw.owners;
  if (!Array.isArray(ownersRaw))
    throw new SafeProposalError("BUNDLE_INVALID", "the bundle has no owners array");
  if (
    typeof raw.chain_id !== "number" ||
    typeof raw.nonce !== "number" ||
    typeof raw.threshold !== "number"
  ) {
    throw new SafeProposalError("BUNDLE_INVALID", "chain_id, nonce and threshold must be numbers");
  }
  const str = (v: unknown, name: string): string => {
    if (typeof v !== "string")
      throw new SafeProposalError("BUNDLE_INVALID", `bundle field ${name} is not a string`);
    return v;
  };
  const bundle: SafeTxBundle = {
    format: BUNDLE_FORMAT,
    chain_id: raw.chain_id,
    safe: addr(raw.safe, "safe"),
    safe_version: str(raw.safe_version, "safe_version"),
    action: str(raw.action, "action"),
    description: typeof raw.description === "string" ? raw.description : "",
    to: addr(raw.to, "to"),
    value: raw.value === "0" ? "0" : badField("value"),
    data: hex(raw.data, "data"),
    operation: raw.operation === 0 ? 0 : badField("operation"),
    safe_tx_gas: raw.safe_tx_gas === "0" ? "0" : badField("safe_tx_gas"),
    base_gas: raw.base_gas === "0" ? "0" : badField("base_gas"),
    gas_price: raw.gas_price === "0" ? "0" : badField("gas_price"),
    gas_token: addr(raw.gas_token, "gas_token"),
    refund_receiver: addr(raw.refund_receiver, "refund_receiver"),
    nonce: raw.nonce,
    safe_tx_hash: hex(raw.safe_tx_hash, "safe_tx_hash"),
    threshold: raw.threshold,
    owners: ownersRaw.map((o: unknown) => addr(o, "owners[]")),
    signatures,
    proposed_at: str(raw.proposed_at, "proposed_at"),
  };
  if (raw.timelock !== undefined) bundle.timelock = addr(raw.timelock, "timelock");
  if (raw.timelock_operation_id !== undefined) {
    bundle.timelock_operation_id = hex(raw.timelock_operation_id, "timelock_operation_id");
  }
  if (raw.timelock_min_delay !== undefined) {
    bundle.timelock_min_delay = str(raw.timelock_min_delay, "timelock_min_delay");
  }
  return bundle;
}

function badField(name: string): never {
  throw new SafeProposalError(
    "BUNDLE_INVALID",
    `bundle field ${name} must be the zero value this dapp signs`,
  );
}

/**
 * Merge the signatures of another bundle (or `{ signatures: [...] }`) into
 * `current`. The other document must be for the same Safe transaction hash. Each
 * signature is recovered locally and must belong to an owner and to THIS hash,
 * or the import is refused. Mirrors publish-contracts `importSignatureBundle`.
 */
export async function importSignatures(
  current: SafeTxBundle,
  source: string,
): Promise<SafeTxBundle> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new SafeProposalError("BUNDLE_INVALID", "the imported text is not JSON");
  }
  if (!isRecord(parsed))
    throw new SafeProposalError("BUNDLE_INVALID", "the imported JSON is not an object");
  const theirHash = parsed.safe_tx_hash ?? parsed.safeTxHash;
  if (typeof theirHash === "string" && lc(theirHash) !== lc(current.safe_tx_hash)) {
    throw new SafeProposalError(
      "DIGEST_MISMATCH",
      "the imported signatures are for a different Safe transaction hash",
    );
  }
  const list = parsed.signatures;
  if (!Array.isArray(list))
    throw new SafeProposalError("BUNDLE_INVALID", "no signatures array in the imported JSON");
  let signatures = [...current.signatures];
  for (const entry of list as unknown[]) {
    if (!isRecord(entry))
      throw new SafeProposalError("BUNDLE_INVALID", "an imported entry is malformed");
    const sig = entry.signature ?? entry.data;
    const claimed = entry.owner ?? entry.signer;
    if (typeof sig !== "string")
      throw new SafeProposalError("BUNDLE_INVALID", "an imported entry has no signature");
    const normalised = toSafeSignature(sig);
    const recovered = await recoverSigner(current.safe_tx_hash, normalised);
    if (typeof claimed === "string" && !sameAddress(claimed, recovered)) {
      throw new SafeProposalError(
        "SIGNATURE_INVALID",
        `an imported signature claims ${claimed} but recovers to ${recovered} for this transaction hash`,
      );
    }
    if (!current.owners.some((o) => sameAddress(o, recovered))) {
      throw new SafeProposalError(
        "NOT_OWNER",
        `an imported signature recovers to ${recovered}, who is not an owner of the Safe`,
      );
    }
    signatures = addSignature(signatures, { owner: getAddress(recovered), signature: normalised });
  }
  return { ...current, signatures };
}

/** The `execTransaction` arguments for a bundle that has threshold signatures. */
export function execTransactionArgs(bundle: SafeTxBundle) {
  if (bundle.signatures.length < bundle.threshold) {
    throw new SafeProposalError(
      "SIGNATURE_INVALID",
      `the bundle has ${bundle.signatures.length} signatures, the Safe needs ${bundle.threshold}`,
    );
  }
  const used = [...bundle.signatures].sort(byOwnerAscending).slice(0, bundle.threshold);
  return [
    bundle.to,
    0n,
    bundle.data,
    0,
    0n,
    0n,
    0n,
    ZERO_ADDRESS,
    ZERO_ADDRESS,
    packSignatures(used),
  ] as const;
}
