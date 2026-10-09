# Governance isomorphism: CI, Stage and Production

**Status: one deployment scheme.** Stage, rehearsal and production run the same
contracts, the same deploy scripts and the same governance path. They differ by
parameters only (section 1.1). Tracked by issue #1447.

This document specifies the governance topology every environment must present,
and the verification that proves it. Companion to
[security-model.md](./security-model.md) section 4 (Access control and admin), which
states the production requirement.

**Paths in this document are relative to this repository unless prefixed
`devops/`.** The governance topology lives here (the Safe, `DeployTimelock`, the
stage table in `scripts/deploy/stage-table.json`). The runbook that deploys it,
"publish contracts", and the acceptance driver that grades it live in the `devops`
repo. Requirements in section 4 bind both.

---

## 1. The principle

**Governance is isomorphic across CI, Stage and Production.** The same contract
code, the same quorum enforcement, the same signing path, the same assertions.
An environment that cannot enforce quorum is not a weaker version of production.
It is a different system, and any release decision made from it is unfounded.

Governance is the one subsystem where a stand-in is indistinguishable from the real
thing right up to the moment it matters, because a single-key forwarder and a 2-of-N
multisig present the same interface to everything downstream. So no stand-in
exists: every environment creates a real Safe through the canonical factory and
drives it through `execTransaction`.

`docs/technical/security-model.md` already draws the line for unit tests: they must
not use `vm.prank` as a substitute for real Safe quorum verification. This document
extends the same rule to every deployed environment.

### 1.1 What isomorphic does and does not mean

Isomorphic here means **the governance path is the same code exercised the same
way**. Exactly four things may differ between environments. Everything else must
match.

| Property | CI and Twin chain (stage) | Production (Base 8453) | Must match? |
|---|---|---|---|
| Safe contract code (`SafeL2` through the canonical factory) | canonical | canonical | **yes** |
| Quorum enforced by the Safe | yes | yes | **yes** |
| Signing path (`execTransaction`, two or more owner signatures) | yes | yes | **yes** |
| Threshold at least 2 | yes | yes | **yes** |
| Deploy scripts and contracts | same | same | **yes** |
| Chain id | 918453 (or the forge test chain) | 8453 | no, allowed difference |
| Owner keys | throwaway keys | named humans' keys | no, allowed difference |
| Owner key custody | encrypted keystores | hardware wallets | no, allowed difference |
| Timelock delay value | short, off chain 8453 only | 172800 s (48 hours), enforced as a floor on chain 8453 | no, allowed difference |

Key custody legitimately differs: CI cannot hold a hardware wallet. The delay value
legitimately differs: the Twin chain cannot move its clock forward, so a rehearsal
cannot wait 48 hours. A short delay proves the scripts run. It never proves the real
delay. The real delay and the real signers are proven on Base mainnet through the
real Safe (runbook Q2). What may never differ is that **two distinct owner
signatures are required, and the Safe contract is what enforces it.**

### 1.2 After the handover: the unpause-only matrix

Exactly one class of operation runs after the timelock handover (issue 1520): the
unpause of each of the four vaults (rmUSDC, rmPROTO, rmAGENT, rmRWA), all of which deploy paused (core 1710). Unpause needs `ADMIN_ROLE`,
which the timelock holds, so each unpause is a Safe transaction that schedules one
timelock operation and a second Safe transaction that executes it after the delay
([security-model.md](./security-model.md), the pause-key abuse and pause-trigger rows).
"No batching" means one timelock operation per unpause and never a shared
operation. It does not mean one wait per operation: all the unpauses are scheduled
in one sitting and wait one 48 hour delay. Dependent operations use the timelock
predecessor field and never a second wait.

Everything else is **deploy-time configuration** that the deployer sets before the
handover, in the deployer stages, and that the verify stage asserts against the
sheet: voting power, quorum, voting period, execution delay, the vault setters
(per-deposit cap, TVL cap, exit fee, fee recipient), router eligibility and the
router default weights. A sheet that routes any of them through govern is refused.

The Safe tool's other operations (`updateDelay`, a no-op `scheduleBatch`, a cancel)
are demonstrations. They run on the Twin fork (`update-delay`, `batch`, `cancel`) and
are refused on chain 8453. The evidence check rejects any non-unpause operation on
8453.

---

## 2. Safe is third-party infrastructure

Safe (originally Gnosis Safe) is not ours and is not deployed by us.

- Safe publishes a fixed contract set per chain at **deterministic addresses**,
  created through the Safe Singleton Factory using `CREATE2`. The factory itself
  was deployed keylessly (Nick's method), so no entity controlled the deployer
  key.
- On any chain where that set exists — Base included — **there is nothing for us
  to deploy.**

### 2.1 Infrastructure versus account

One distinction drives the whole design, and conflating the two is what produced
the current defect.

**Safe infrastructure** is the shared, chain-wide deployment: the singleton
(implementation), the proxy factory, the fallback handler, MultiSend. Deployed
once per chain by Safe. We consume it.

**A Safe account** is a per-owner-set `SafeProxy`, created by calling
`SafeProxyFactory.createProxyWithNonce(singleton, setup(...), saltNonce)`. The
proxy is ~174 bytes and `delegatecall`s the singleton for every operation.

Creating an account is **not** deploying Safe, and it is **not** a mock. It is
the only way a Safe comes into existence — the Safe web UI performs exactly this
call when a user "creates a Safe". An environment that needs a Safe with a
specific owner set must create a proxy, unless it inherits one that already
exists on the forked chain.

### 2.2 Canonical v1.4.1 addresses

Identical on every chain where Safe has deployed:

| Contract | Address |
|---|---|
| `Safe` singleton (L1) | `0x41675C099F32341bf84BFc5382aF534df5C7461a` |
| `SafeL2` singleton | `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` |
| `SafeProxyFactory` | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` |
| `CompatibilityFallbackHandler` | `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99` |
| `MultiSend` | `0x38869bf66a61cF6bDB996A6aE40D5853FD43B526` |

**Base is an L2, so `SafeL2` is the correct singleton.** `SafeL2` emits
additional events specifically so L2 indexers can reconstruct Safe activity
without tracing. Using the L1 `Safe` singleton on Base is a silent fidelity loss:
it works, but the event stream production tooling expects is absent.

---

## 3. Where each requirement is enforced

| Requirement | Where it is enforced |
|---|---|
| R1 to R3 | The Twin chain (a pinned lazy fork of real Base state, core 1498) carries all five contracts of section 2.2 with their canonical code, and both singletons carry the lock their constructor writes (threshold 1 in storage slot 4, so `setup()` on a singleton reverts `GS200`, as on Base). `scripts/devnet/safe-set.ts` reads the five from the chain over RPC and fails naming any contract that is absent, whose code does not hash to its pinned keccak256 (table below), or (singletons) whose slot 4 is not 1. |
| R4 | `SafeIntegration.t.sol` and the stage deploy both use `SafeL2` (`0x29fcB43b...`). The verifier checks the proxy's `masterCopy` slot. |
| R5 to R8 | The devops publish-contracts runbook creates the `SafeProxy` through `@safe-global/protocol-kit` (`SafeProxyFactory.createProxyWithNonce` on `SafeL2`, canonical fallback handler, threshold 2). It refuses a chain without the Safe set. There is no fallback. |
| R9 to R11 | Every Safe operation goes through `execTransaction` with two owner signatures over the Safe's own `getTransactionHash`, packed ascending by owner. Keystore passphrases are never on a command line. |
| R10 (CI handover) | `SafeIntegration.t.sol` and `DeployTimelock.t.sol` run `DeployTimelock` from the deployer that holds the roles, list every holder from the `RoleGranted` and `RoleRevoked` logs (the contracts are not `AccessControlEnumerable`), and assert the timelock is the only `ADMIN_ROLE` holder on each governed contract (the router also has RouterGovernance, by design) and the only gateway `DEFAULT_ADMIN_ROLE` holder. |
| R12 to R14 | The verifier reads everything from the Safe: runtime code hash equal to the canonical SafeProxy's, threshold 2, owner set equal to the sheet's signers, `SafeL2` as singleton, no module, no guard, the canonical fallback handler. Quorum is proved enforced by eth_calls of one harmless SafeTx: one owner signature must revert `GS020`, the same owner twice and two non-owners must each revert `GS026`, and threshold signatures must return `true`. The devops driver grades these as `AC-ID-06#safe-quorum`. |
| Timelock delay | `DeployTimelock.s.sol` enforces the 172800 s floor and the Safe floors only when `block.chainid == 8453`. Off that chain the delay is a parameter. |

Pinned code hashes (keccak256 of runtime code), read from Base and
checked against the Twin chain with `bun scripts/devnet/safe-set.ts`:

| Contract | Code hash | Pinned in |
|---|---|---|
| `SafeProxy` v1.4.1 (every proxy the factory creates) | `0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c` | the devops publish-contracts verifier (`verify`) |
| `Safe` singleton (L1) | `0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4` | `scripts/devnet/safe-set.ts` |
| `SafeL2` singleton | `0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff` | `scripts/devnet/safe-set.ts` |
| `SafeProxyFactory` | `0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317` | `scripts/devnet/safe-set.ts` |
| `CompatibilityFallbackHandler` | `0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9` | `scripts/devnet/safe-set.ts` |
| `MultiSend` | `0x0e4f7fc66550a322d1e7688e181b75e217e662a4f3f4d6a29b22bc61217c4b77` | `scripts/devnet/safe-set.ts` |

The SafeProxy hash was measured on a proxy created by the canonical factory on
the Twin chain; SafeProxy has no immutables, so every
proxy carries the same runtime code.

The SafeProxy hash was measured on a proxy created by the canonical factory on
the Twin chain. SafeProxy has no immutables, so every
proxy carries the same runtime code.

The Twin chain Safe's owners are three dedicated throwaway keys, distinct from the
submitter, the voters and the emergency key. The submitter is the agent whose
receipts the Safe releases, the voters are RouterGovernance's approving body, and
the emergency key is the independent hot key. The verifier asserts all of them are
distinct.

---

## 4. Required behavior

Normative. "Must" is binding; a violation is a release blocker.

### 4.1 Safe infrastructure

- **R1.** Every environment must obtain Safe contracts from the canonical
  addresses in §2.2. No environment may deploy its own Safe implementation,
  factory, handler, or any substitute for one.
- **R2.** Chains derived from a Base fork (the Twin chain, a pinned lazy fork of
  real Base state) must carry the complete Safe set from §2.2. The state is real
  Base, so the contracts are there by construction. Nothing is warmed or patched.
- **R3.** The check (`scripts/devnet/safe-set.ts`) must fail when any address in
  §2.2 is absent, not canonical or unlocked. A chain that lacks Safe must not
  reach CI or stage.
- **R4.** On Base and other L2s, `SafeL2` is the singleton. Selecting the L1
  `Safe` singleton requires a recorded, reviewed exception.

### 4.2 The Safe account

- **R5.** Each environment's governing Safe must be a `SafeProxy` created via
  `SafeProxyFactory.createProxyWithNonce`, or an existing Safe inherited from the
  forked chain. No other construction is permitted.
- **R6.** Threshold must be ≥ 2, and must be a real function of the owner set.
  A constant-returning `getThreshold()` is a violation of this document
  regardless of the value it returns.
- **R7.** The owner set must contain at least `threshold` distinct keys that the
  environment can actually produce signatures for. An owner set the environment
  cannot sign with is equivalent to no Safe at all.
- **R8.** No fallback. There is no flag, environment variable, or default that
  substitutes a non-Safe contract when Safe is unavailable. If the Safe set is
  absent, the environment fails to provision and says so.

### 4.3 The signing path

- **R9.** Every privileged operation routed through the Safe must use
  `execTransaction` with at least `threshold` distinct owner signatures, packed
  ascending by owner address over the EIP-712 `SafeTx` digest from
  `getTransactionHash`.
- **R10.** No environment may expose a single-key path that bypasses signature
  collection. A contract that forwards calls for one key is such a path and must not exist.
- **R11.** Owner private keys must not be written to disk unencrypted or passed
  on a command line. Signing reads from the keystore
  (`cast wallet sign --no-hash --keystore`), matching how every other key
  is handled.

### 4.4 Verification

- **R12.** Verification must assert the owner set and threshold read from the
  Safe, not from the deployment record. A record is a claim; the chain is the
  fact.
- **R13.** Verification must prove quorum is **enforced**, not merely configured:
  a `threshold - 1` signature attempt must revert. Configuration without a
  negative control proves nothing — this mirrors how `propose-negative` already
  makes `propose` meaningful.
- **R14.** Any assertion that a single key drives the Safe must not exist.
- **R15.** (issue #1476) Gateway agent ownership is governance authority too:
  the recorded owner alone can call `setPolicy` and `revokeAgent`. The handover
  must leave no gateway agent owned by the deployer. `DeployTimelock` hands
  every agent in `AGENT_ADDRESSES` to the TimelockController with
  `transferAgentOwnership` and requires none is still deployer-owned. The
  list is a required input with no default (a comma-separated list, or
  `none`), because the gateway cannot enumerate an owner's agents; the stage
  runner passes every deployer-owned agent the gateway logs name, and the
  verifier fails `AC-CORE-05 no agent authorized by the deployer is still
  deployer-owned` when an agent an `AgentAuthorized` or
  `AgentOwnershipTransferred` log gives the deployer is still deployer-owned.

---

---

## 5. Open questions

1. **Inheriting a production Safe.** Once a Robot Money Safe exists on Base mainnet,
   a rehearsal could inherit its owner set and threshold, with signatures from
   `approveHash`. This is strictly more isomorphic and should be revisited after the
   first mainnet deployment.
2. **Scope of R9.** This document covers the Safe to TimelockController path. It does
   not yet say anything about the `RouterGovernance` voter set, which is a separate
   governing body with its own quorum.
3. **No saved fixture.** The Twin chain is a lazy fork of real Base, so there is no snapshot to re-pin and no implementation contract to warm. (This item was about the retired `snapshot-fork.ts`.)
