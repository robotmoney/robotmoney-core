# Production procedure: Safe to Timelock on Base 8453

Canonical: `docs/technical/governance-isomorphism.md` sections 1.1, 3 and 4
Canonical: `docs/technical/security-model.md` section 4
Implements: issue #1447, workstream J (production), documentation only

This document says how a signer, with a hardware wallet or a standard EVM wallet,
schedules, executes and cancels a timelock operation through the production Safe. It
also gives the procedures for unpause and for Safe and timelock self-administration,
with the exact calldata shape of each call.

It is a procedure, not evidence. It does not claim that any step has been run on chain
8453, and it does not claim that governance is proven or isomorphic. That evidence
comes from running these steps through the real Safe (devops runbook Q2).

**Paths are relative to this repository unless prefixed `devops/`.**

---

## 0. What already exists and what this document adds

State after the stacked deploy PR (1505), which removed the old deploy workflow and
the stage ceremony shell:

| Piece | Where it lives | Status |
|---|---|---|
| Deploy, role handover, delay floor of 172800 s on chain 8453 | `contracts/script/DeployTimelock.s.sol` | exists |
| Per-action table of governance actions and checks (pause, unpause, `setPolicy`, `updateDelay`, cancel) | `devops/docs/runbooks/base-mainnet-core-deployment.md`, governance matrix | exists, names the actions only |
| Batch rule: one `scheduleBatch` and one `executeBatch` round | same runbook | exists |
| Solidity reference for building and signing a SafeTx and for schedule, execute, cancel | `contracts/test/SafeIntegration.t.sol` (`_safeExec`, `_scheduleAndExecute`, `test_sadPath_cancelledOperation_cannotExecute`) | exists, test code, uses test keys |
| Signing from a keystore (`cast wallet sign --no-hash --keystore`) | `docs/technical/governance-isomorphism.md` R11 | exists, keystore only |
| SafeTx payload spec, hardware-wallet signature formats, nonce handling, calldata shapes, Safe self-administration, timelock self-administration | none | **this document** |

---

## 1. Fixed facts

| Item | Value |
|---|---|
| Chain id | 8453 (Base) |
| Safe contract | `SafeL2` v1.4.1 proxy, created through `SafeProxyFactory` (see governance-isomorphism section 2.2) |
| Safe threshold | at least 2 (deploy refuses less on chain 8453) |
| Timelock | OpenZeppelin v5 `TimelockController`, admin argument `address(0)`, so the timelock administers itself |
| Safe roles on the timelock | `PROPOSER_ROLE`, `EXECUTOR_ROLE`, and `CANCELLER_ROLE` (OZ v5 grants it to every proposer) |
| Minimum delay | 172800 s (48 hours) at deploy on chain 8453 |
| `ADMIN_ROLE` on the governed contracts | the timelock only |
| `DEFAULT_ADMIN_ROLE` on the gateway, `InvestmentCommitteePolicy` and `ConsensusRecommendationReceipt` | the timelock only |
| Fast pause keys | gateway `PAUSER_ROLE` holder, vault `EMERGENCY_ROLE` holder (independent hot keys, not the Safe) |

Role ids (keccak256 of the name):

| Role | Id |
|---|---|
| `ADMIN_ROLE` | `0xa49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775` |
| `PAUSER_ROLE` | `0x65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a` |
| `EMERGENCY_ROLE` | `0xbf233dd2aafeb4d50879c4aa5c81e96d92f6e6945c906a58f9f2d1c1631b4b26` |
| `AGENT_ROLE` | `0xcab5a0bfe0b79d2c4b1c2e02599fa044d115b7511f9659307cb4276950967709` |
| `PROPOSER_ROLE` | `0xb09aa5aeb3702cfd50b6b62bc4532604938f21248a27a1d5ca736082b6819cc1` |
| `EXECUTOR_ROLE` | `0xd8aa0f3194971a2a116679f7c2090f6939c8d4e01a2a8d7e41d55e5351469e63` |
| `CANCELLER_ROLE` | `0xfd643c72710c63c0180259aba6b2d05451e3591a24e58b62239378085726f783` |
| `DEFAULT_ADMIN_ROLE` | `0x0000000000000000000000000000000000000000000000000000000000000000` |

The delay value 172800 s is a deploy-time floor. The timelock contract itself has no
floor on `updateDelay` (section 6.3), so the floor is also a signer rule here.

---

## 2. The two layers

Every privileged change on a governed contract is two Safe transactions with a wait
between them.

```
owners sign SafeTx A    Safe.execTransaction(to = timelock, data = schedule(...))
        wait at least getMinDelay() seconds (172800 s on 8453)
owners sign SafeTx B    Safe.execTransaction(to = timelock, data = execute(...))
                        timelock calls target with the scheduled data
```

Cancel is one Safe transaction, `to = timelock`, `data = cancel(id)`, valid while the
operation is pending.

Safe self-administration (section 6.1) is a different shape: one Safe transaction with
`to = the Safe itself`. It does not pass through the timelock and has no delay.

---

## 3. The SafeTx payload

### 3.1 Typed data

Safe v1.4.1 signs EIP-712 typed data.

```
domain:  EIP712Domain(uint256 chainId, address verifyingContract)
         chainId           = 8453
         verifyingContract = <the production Safe address>

type:    SafeTx(address to, uint256 value, bytes data, uint8 operation,
                uint256 safeTxGas, uint256 baseGas, uint256 gasPrice,
                address gasToken, address refundReceiver, uint256 nonce)
```

Type hashes (computed with `cast keccak`):

| Name | Hash |
|---|---|
| `EIP712Domain(uint256 chainId,address verifyingContract)` | `0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218` |
| `SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)` | `0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8` |

The digest owners sign is

```
keccak256(0x19 0x01 || domainSeparator || structHash)
```

Do not compute it by hand for a real signature. Read it from the Safe, which is what
the repo's tests do:

```bash
cast call "$SAFE" 'getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)(bytes32)' \
  "$TO" 0 "$DATA" 0 0 0 0 0x0000000000000000000000000000000000000000 0x0000000000000000000000000000000000000000 "$NONCE" \
  --rpc-url "$BASE_RPC"
```

### 3.2 Field values for every operation in this document

| Field | Value | Why |
|---|---|---|
| `to` | the timelock (sections 4, 5, 6.2, 6.3) or the Safe (section 6.1) | see section 2 |
| `value` | 0 | no ETH moves |
| `data` | the calldata of the called function | per section |
| `operation` | 0 (CALL) | never 1 (DELEGATECALL) for a governance action |
| `safeTxGas` | 0 | with `gasPrice` 0 a failing inner call reverts the whole transaction (`GS013`), so the nonce is not consumed on failure |
| `baseGas` | 0 | no gas refund |
| `gasPrice` | 0 | no gas refund |
| `gasToken` | `0x0000000000000000000000000000000000000000` | no refund |
| `refundReceiver` | `0x0000000000000000000000000000000000000000` | no refund |
| `nonce` | `Safe.nonce()` read at signing time | section 3.4 |

Signers refuse any SafeTx with `operation` 1, with a nonzero refund field, or with
`to` outside the set {timelock, Safe}.

### 3.3 Signature formats and packing

`execTransaction(..., bytes signatures)` takes `threshold` signatures of 65 bytes
each, concatenated as `r (32) || s (32) || v (1)`. The Safe requires the owners to
appear in strictly ascending address order. Equal or descending order reverts
(`GS026`). Fewer signatures than the threshold reverts (`GS020`).

| `v` | Meaning | When to use |
|---|---|---|
| 27 or 28 | ECDSA signature directly over the SafeTx digest (EIP-712 typed-data signing) | wallet shows the typed data: preferred |
| 31 or 32 | `eth_sign` format: the wallet signed `"\x19Ethereum Signed Message:\n32" || digest`, and the Safe subtracts 4 from `v` | wallet can only sign a 32-byte message |
| 1 | pre-approved hash: `r` is the owner address, `s` is 0. The owner called `approveHash(digest)` on the Safe in an earlier transaction, or is `msg.sender` | an owner that cannot sign off chain |
| 0 | contract signature (EIP-1271) | not used by this deployment |

How to produce each from a wallet:

1. **Typed data (preferred).** The wallet or the Safe web interface presents the
   EIP-712 message. The signer compares `to`, `data`, `operation` and `nonce` on the
   device screen (section 3.5). The returned `v` is 27 or 28. Use as is.
2. **`eth_sign`.** The wallet signs the 32-byte digest as a personal message. The
   returned `v` is 27 or 28. Add 4 to get 31 or 32 before packing. Without that
   adjustment the Safe recovers a different address and reverts (`GS026`).
3. Sort the owners that signed by ascending address, then concatenate their 65-byte
   signatures in that order.

Hardware wallets (`--ledger`, `--trezor`) are the production custody. Keystores are
for non-production chains only (governance-isomorphism section 1.1). A signer never
types a private key, a seed or a passphrase into any chat, file, argument or
transcript (see `devops/CLAUDE.md` item a).

### 3.4 Nonce handling

- The Safe nonce is one counter, `Safe.nonce()`. Each successful `execTransaction`
  increments it. A failed call consumes nothing.
- Every SafeTx in flight must carry the nonce that will be current when it executes.
  Two SafeTx signed with the same nonce are rivals: the first to execute makes the
  other permanently invalid, and its signatures cannot be reused.
- So order the round. Schedule transactions take nonces N, N+1, ...; the matching
  execute transactions are signed only after the delay, with the nonce read again
  at that time.
- Never sign two governance SafeTx with different nonces in parallel unless the
  signers have agreed the exact order. Between the schedule and the execute of one
  operation, other Safe activity (a cancel, an owner change) moves the nonce, so
  re-read it before signing the execute.
- A pending SafeTx that must not run is killed by executing any other SafeTx at the
  same nonce. A signer does not "revoke" a signature.

### 3.5 What each signer checks before signing

Done on the device screen or an independent decoder, not on the proposer's machine:

1. Chain id is 8453 and `verifyingContract` is the production Safe address.
2. `to`, `value`, `operation` and the refund fields match section 3.2.
3. The calldata decodes to exactly the intended function, with the intended arguments.
   For `schedule`, decode the inner `data` too and check `target`, `delay`, `salt`.
4. The delay argument is at least `getMinDelay()` (172800 s on 8453).
5. The nonce equals `Safe.nonce()` now.
6. The digest the wallet shows equals the digest the signer computed independently
   (`getTransactionHash` against an RPC the signer trusts). A Ledger that cannot
   clear-sign the SafeTx shows two hashes instead of the fields: the EIP-712 domain
   hash (the Safe's `domainSeparator()`) and the message hash (the SafeTx struct
   hash). The signer checks both against values computed independently. This display
   must be checked on a real device before the first production use.

---

## 4. Schedule, execute and cancel

### 4.1 Schedule

Safe transaction: `to = TIMELOCK`, `data = schedule(target, value, data, predecessor, salt, delay)`.

```
selector 0x01d5062a  schedule(address,uint256,bytes,bytes32,bytes32,uint256)
args     target      the governed contract (or the timelock, section 6.3)
         value       0
         data        the calldata to run on target (section 5 or 6)
         predecessor 0x00..00 unless this operation must follow another
         salt        a fresh 32-byte value, unique per operation
         delay       172800 (at least getMinDelay())
```

Calldata layout, built with:

```bash
cast calldata 'schedule(address,uint256,bytes,bytes32,bytes32,uint256)' \
  "$TARGET" 0 "$INNER_DATA" 0x0000000000000000000000000000000000000000000000000000000000000000 "$SALT" 172800
```

The operation id is `keccak256(abi.encode(target, value, data, predecessor, salt))`.
Read it with `hashOperation(target, value, data, predecessor, salt)`. Scheduling an
id that already exists reverts, so reusing a salt for the same target and data
fails. Record the id: cancel and the status checks need it.

Batch form: `scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)`,
selector `0x8f2a0bb0`. The batch is one operation with one id, and it executes
atomically with `executeBatch(...)`, selector `0xe38335e5`. The devops runbook uses it
so the signers approve one schedule and one execute per round.

Check after the Safe transaction mines:

```bash
cast call "$TIMELOCK" 'isOperationPending(bytes32)(bool)' "$ID" --rpc-url "$BASE_RPC"   # true
cast call "$TIMELOCK" 'getTimestamp(bytes32)(uint256)' "$ID" --rpc-url "$BASE_RPC"       # ready time
```

The ready time is the scheduling block's timestamp plus the delay. At the 172800 s
minimum that is 48 hours. The transaction cannot be shortened: a `delay` below
`getMinDelay()` reverts (`TimelockInsufficientDelay`).

### 4.2 Execute

Wait until `isOperationReady(id)` is true (block timestamp at or after the ready time).
Then a Safe transaction: `to = TIMELOCK`, `data = execute(target, value, data, predecessor, salt)`.

```
selector 0x134008d3  execute(address,uint256,bytes,bytes32,bytes32)
args     the same target, value, data, predecessor, salt as the schedule
```

```bash
cast calldata 'execute(address,uint256,bytes,bytes32,bytes32)' \
  "$TARGET" 0 "$INNER_DATA" 0x0000000000000000000000000000000000000000000000000000000000000000 "$SALT"
```

Notes:

- The Safe holds `EXECUTOR_ROLE`, so only a Safe quorum executes. Do not assume the
  role is open: it is not.
- Executing early reverts (`TimelockUnexpectedOperationState`). Executing twice
  reverts. A cancelled operation cannot execute.
- `predecessor`, if used, must already be done.
- Check the effect on the target, not only the timelock state:
  `isOperationDone(id)` true, then read the target (section 5 and 6 list the read).

### 4.3 Cancel

Valid only while the operation is pending. Safe transaction: `to = TIMELOCK`,
`data = cancel(id)`.

```
selector 0xc4d252f5  cancel(bytes32)
args     id          the operation id from hashOperation
```

```bash
cast calldata 'cancel(bytes32)' "$ID"
```

The Safe holds `CANCELLER_ROLE`, so a cancel needs the same quorum of owner
signatures. After it mines, `isOperation(id)` is false and a later `execute` reverts.
The repo's Solidity reference is `SafeIntegration.t.sol::test_sadPath_cancelledOperation_cannotExecute`.
`cancel` deletes the operation's timestamp, so the id returns to the unset state.
The same `target`, `value`, `data`, `predecessor` and `salt` can therefore be
scheduled again and get the same id, with a fresh delay. Prefer a new salt anyway, so
the record of the cancelled operation and the new one stay distinct.

---

## 5. Unpause

Pause is fast and unilateral on purpose. Unpause is slow and goes through the timelock
(security-model section 4, `contracts/gateway/AccessRoles.sol`).

| Contract | Pause (hot key, no timelock) | Unpause (`ADMIN_ROLE`, so Safe through timelock) | Read after |
|---|---|---|---|
| Gateway | `pause()` by the `PAUSER_ROLE` holder | `unpause()`, selector `0x3f4ba83a`, no arguments. Reverts `NotPaused` if not paused. | `paused()` is false |
| `RobotMoneyVault` | `pause()` by the `EMERGENCY_ROLE` holder (on this base it sets both `depositsPaused` and `withdrawalsPaused`) | `unpause()`, selector `0x3f4ba83a`, no arguments. Clears both flags and does not revert when already unpaused. | `depositsPaused()` and `withdrawalsPaused()` are both false. Do not rely on `paused()`: it returns `depositsPaused && withdrawalsPaused`, so it is false while only one flag is set. |
| `BasketVault` | `pause()` by the `EMERGENCY_ROLE` holder (deposits only; sets `depositsPaused` and the OZ paused flag) | `unpause()`, selector `0x3f4ba83a`, no arguments. Reverts `ExpectedPause` when the OZ paused flag is not set. | `paused()` is false and `depositsPaused()` is false |

> **Note: core 1494 changes pause.** The owner decided that pause stops new deposits
> only, and users can always withdraw. Core issue 1494 changes the contracts to that
> rule. This table describes the contracts on this document's base as they behave
> today. Once 1494 merges, re-read the `RobotMoneyVault` row against the new source
> before using it.

Procedure for each unpause:

1. Before scheduling, read the current state of the target: `paused()` on the gateway
   and `BasketVault`, and both `depositsPaused()` and `withdrawalsPaused()` on
   `RobotMoneyVault`. Schedule an unpause only for a target whose call will succeed.
   `BasketVault.emergencyUnwind()` and similar emergency paths set `depositsPaused`
   without the OZ paused flag. In that state `paused()` is false and `unpause()`
   reverts `ExpectedPause`. The gateway's `unpause()` reverts `NotPaused` the same way.
2. `TARGET` is the contract. `INNER_DATA = cast calldata 'unpause()'` which is `0x3f4ba83a`.
3. Schedule it (section 4.1), wait the delay, execute it (section 4.2).
4. Read the pause state from the chain again, not from the Safe interface.

**Batch warning.** A `scheduleBatch` operation executes atomically. One reverting call
(an `unpause()` on a contract that is not in the paused state, for example) reverts
the whole `executeBatch` after the 48 hour wait. The operation stays ready, but its
calls cannot succeed while the state is unchanged, so the round is lost and must be
cancelled and rescheduled, with another 48 hours. Check every call in a batch against
current chain state before the schedule is signed, and again before the execute.

Two limits to state to the signers:

- The pauser cannot unpause, and the deployer cannot after the handover. Only the
  timelock holds `ADMIN_ROLE`.
- An unpause does not clear a vault `shutdown` or `retired` flag. Those have their own
  `ADMIN_ROLE` steps. Do not use unpause to try to clear them.

---

## 6. Self-administration

### 6.1 The Safe administers itself (owners and threshold)

These functions on the Safe are `authorized`: they run only when `msg.sender` is the
Safe. So the Safe transaction is `to = SAFE` (itself), `value = 0`, `operation = 0`.
They do not pass through the timelock and take effect when the Safe transaction
executes. That is the reason to treat them with the highest care: the owner set
decides who can use every other power.

| Action | Selector and signature | Arguments |
|---|---|---|
| Change threshold | `0x694e80c3` `changeThreshold(uint256)` | `_threshold`: the new threshold, at least 2 and at most the owner count |
| Swap an owner | `0xe318b52b` `swapOwner(address,address,address)` | `prevOwner`, `oldOwner`, `newOwner` |
| Add an owner | `0x0d582f13` `addOwnerWithThreshold(address,uint256)` | `owner`, `_threshold` (the threshold after the add) |
| Remove an owner | `0xf8dc5dd9` `removeOwner(address,address,uint256)` | `prevOwner`, `owner`, `_threshold` (the threshold after the removal) |

```bash
cast calldata 'swapOwner(address,address,address)' "$PREV" "$OLD" "$NEW"
cast calldata 'changeThreshold(uint256)' 3
```

`prevOwner` is the owner stored before `oldOwner` in the Safe's linked list. Read the
list with `getOwners()`. If `oldOwner` is at index 0, `prevOwner` is the sentinel
`0x0000000000000000000000000000000000000001`. Otherwise it is `owners[i-1]`. A wrong
`prevOwner` reverts (`GS205`).

Rules the signers hold (they are policy here, not contract enforcement):

- Keep the threshold at 2 or more at every step (governance-isomorphism R6). The Safe
  contract itself accepts a threshold of 1. Nothing on chain stops it.
- Keep at least `threshold` distinct owners that the team can actually produce
  signatures for (R7).
- A swap is preferred to remove then add, because it keeps the count and the
  threshold constant.
- After the change, read `getOwners()` and `getThreshold()` from the chain and compare
  with the signer sheet (R12).
- The timelock does not protect this path. The delay does not apply, so the signers
  supply the deliberation time themselves.

### 6.2 Role grant, revoke and renounce on a governed contract

`ADMIN_ROLE` and gateway `DEFAULT_ADMIN_ROLE` are held by the timelock, so these go
through the timelock: Safe schedules, waits, Safe executes (section 4). The inner
call is the standard OZ AccessControl call on the governed contract:

| Action | Selector and signature | Arguments |
|---|---|---|
| Grant | `0x2f2ff15d` `grantRole(bytes32,address)` | `role`, `account` |
| Revoke | `0xd547741f` `revokeRole(bytes32,address)` | `role`, `account` |
| Renounce | `0x36568abe` `renounceRole(bytes32,address)` | `role`, `callerConfirmation` (must equal the caller) |

```bash
cast calldata 'grantRole(bytes32,address)' "$ROLE_ID" "$ACCOUNT"
```

Which authority administers which role:

- On the vaults, registry, router and router governance, roles are administered by
  `ADMIN_ROLE` (each sets `ADMIN_ROLE` as its own admin), held by the timelock. The
  inner call runs with `msg.sender = timelock`.
- On `InvestmentCommitteePolicy` and `ConsensusRecommendationReceipt`, `ADMIN_ROLE` is
  administered by `DEFAULT_ADMIN_ROLE`, held by the timelock
  (`DeployTimelock.s.sol` moves both roles to the timelock). On the IC policy,
  `COMMITTEE_AGENT_ROLE` is administered by `ADMIN_ROLE`.
- On the gateway, every role except `AGENT_ROLE` is administered by
  `DEFAULT_ADMIN_ROLE`, held by the timelock. `AGENT_ROLE` is administered by
  `ADMIN_ROLE`.
- Vault `EMERGENCY_ROLE` is administered by `ADMIN_ROLE`. To rotate the emergency
  key: grant to the new key, check it, then revoke the old key.

Renounce has one rule worth stating: `callerConfirmation` must equal `msg.sender`.
For an operation scheduled through the timelock, the caller on the governed contract
is the timelock, so the argument is the timelock address and the call gives up the
timelock's own role. Do that only on purpose. A holder that is a hot key (pauser,
emergency) renounces by sending the call itself, with no timelock.

> **Signer warning: IC policy and receipt have no last-admin guard on this base.**
> Never revoke or renounce the timelock's `DEFAULT_ADMIN_ROLE` on
> `InvestmentCommitteePolicy` or `ConsensusRecommendationReceipt`. Nothing in those
> contracts stops it, and once it is gone no one can grant `ADMIN_ROLE` there again.
> PR 1507 adds a last-admin floor to both. It is not on this document's base.

Safeguards in the contracts, which the signers should expect to see as reverts:

- Gateway `LastAdminFloor`: revoking or renouncing the last holder of gateway
  `ADMIN_ROLE` or `DEFAULT_ADMIN_ROLE` reverts. Grant the replacement first, then
  revoke.
- Gateway role separation: no account may hold more than one of `ADMIN_ROLE`,
  `PAUSER_ROLE` and `AGENT_ROLE`. A grant that breaks it reverts (`RoleSeparationViolated`).
  Check the target account holds none of the others before scheduling.

Gateway agent ownership is also authority. To hand an agent to a new owner:
`transferAgentOwnership(address agent, address newOwner)`, selector `0xc43de819`,
as an operation on the gateway with the timelock as the current owner. The new owner
must already hold gateway `ADMIN_ROLE`, or the call reverts `NewAgentOwnerNotAdmin`.
So grant `ADMIN_ROLE` to the new owner first (respecting role separation), then
transfer.

Read after: `hasRole(role, account)` on the governed contract, and for the gateway
agent, `agentOwner(agent)`.

### 6.3 The timelock administers itself

The timelock holds its own `DEFAULT_ADMIN_ROLE` (admin argument `address(0)` at
deploy). So changes to the timelock go through the timelock: the schedule's `target`
is the timelock itself.

**Change the delay.** Only the timelock can call `updateDelay`
(`TimelockUnauthorizedCaller` otherwise), so schedule an operation whose target is the
timelock.

```
selector 0x64d62353  updateDelay(uint256)
args     newDelay    seconds
```

```bash
cast calldata 'updateDelay(uint256)' 172800
```

The schedule has `target = TIMELOCK`, `data = updateDelay(newDelay)`, and a `delay`
of at least the **current** minimum. The new delay applies to operations scheduled
after the execute. Signers hold these rules:

- On chain 8453 never accept a `newDelay` below 172800. The contract does not enforce
  that floor (only `DeployTimelock` does, at deploy), so the signers are the only
  guard.
- A change that lowers the delay is the most dangerous: it shortens the window every
  later change must survive. Treat it like an owner-set change.
- Read `getMinDelay()` after the execute.

**Grant or revoke a timelock role** (add or retire a proposer, executor or canceller,
for example when the Safe address changes). Target is the timelock, inner data is
`grantRole(role, account)` or `revokeRole(role, account)` with `PROPOSER_ROLE`,
`EXECUTOR_ROLE` or `CANCELLER_ROLE` (ids in section 1).

- Grant the new holder first and read `hasRole`. Revoke the old holder only after that.
  A timelock with no proposer cannot schedule anything, and nothing can be recovered,
  because the timelock has no other admin.
- A new Safe needs `PROPOSER_ROLE`, `EXECUTOR_ROLE` and `CANCELLER_ROLE`. OZ v5
  grants `CANCELLER_ROLE` to proposers only in the constructor, so a later
  `grantRole(PROPOSER_ROLE, ...)` does not give the right to cancel: grant
  `CANCELLER_ROLE` explicitly.
- Never grant `EXECUTOR_ROLE` to `address(0)` (an open executor). The deployment keeps
  execution behind the Safe quorum.

**Renounce on the timelock.** The Safe can renounce its own timelock role directly,
without a delay, with a Safe transaction `to = TIMELOCK`,
`data = renounceRole(role, SAFE)`, because the Safe is the caller. This removes power
at once. Use it only to retire a Safe that has been replaced, after the replacement is
confirmed with `hasRole`.

---

## 7. Worked order of one round

1. Proposer drafts `INNER_DATA`, `TARGET`, `SALT` and the `schedule` calldata. Reads
   `getMinDelay()`, `Safe.nonce()` and the operation id.
2. Each signer runs section 3.5 on a hardware wallet and signs the SafeTx digest.
3. The signatures are packed ascending by owner (section 3.3). Any owner submits
   `Safe.execTransaction`. Read `isOperationPending(id)`.
4. Wait the delay. Do not shorten it.
5. Re-read `Safe.nonce()`. Repeat steps 2 and 3 for `execute`. Read the target.
6. If the plan changes while pending, run the cancel (section 4.3) and start over
   with a new salt.

---

## 8. What this document does not do

- It does not state that governance is proven or isomorphic across environments. It
  specifies a procedure. The evidence is produced by running it through the real Safe
  against the real contracts at the real delay.
- It does not replace the devops runbook, which owns the schedule, the signer
  playbook and the evidence record.
- It makes no change to any contract or script.

## 9. Not verified when this document was written

- No step was run on chain 8453 or on any chain.
- Selectors, role ids and the two EIP-712 type hashes were computed with `cast` from
  the signature strings. The type hashes, the signature `v` rules (27/28, 31/32, 1, 0)
  and the `GS0xx` codes match the vendored Safe v1.4.1 source in this repository:
  `contracts/test/vendor/safe-1.4.1/Safe.sol` (`DOMAIN_SEPARATOR_TYPEHASH`,
  `SAFE_TX_TYPEHASH`, `checkNSignatures` with `GS020`, `GS024`, `GS025`, `GS026`, and
  `GS013` in `execTransaction`) and `contracts/test/vendor/safe-1.4.1/base/OwnerManager.sol`
  (`GS201`, `GS202`, `GS205`, `SENTINEL_OWNERS = address(0x1)`). The vendored copy was
  not compared byte for byte with the deployed `SafeL2` on Base.
- The exact `cast wallet sign` flags for a Ledger or Trezor (typed data versus raw
  digest) were not tested, and neither was the Ledger's domain-hash and message-hash
  display. Confirm on the real device against `getTransactionHash`
  before the first production use.
- The behaviour of `unpause` on the three contract families is read from the
  contract source on this branch (`RobotMoneyGateway.sol`, `RobotMoneyVault.sol`,
  `BasketVault.sol`), not from a run.
