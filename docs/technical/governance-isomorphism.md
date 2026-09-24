# Governance isomorphism: CI, Stage and Production

**Status: governance is NOT isomorphic yet.** Tracked by issue #1447, whose
"Definition of done" is the only authority for saying otherwise. Migration steps
1–4 (§5) make the **stage ceremony** and the two forge fork tests
(`SafeIntegration`, `GovernanceExecutePathAfterHandover`) use a real 2-of-3
`SafeL2`; §3.0 says what changed. Still open, per #1447: the `DeployTimelock`
Safe gate accepts a constant-threshold stub; stub Safes and `vm.prank(safe)`
flows remain in the unit suites; several timelocks use EOA proposers; the
smoke, dapp and fork e2e devnets govern from the deployer EOA; and production
has no Safe → Timelock deploy or operating path. The stage host keeps running
the single-key stand-in until it is redeployed from a ref that carries these
steps, so the §3.1–§3.4 measurements still describe the live stage chain.

This document specifies the governance topology every environment must present,
and the verification that proves it. It exists because one environment currently
does not comply, and the non-compliance is invisible to every check we run.

Companion to [security-model.md](./security-model.md) §4 (Access control &
admin), which states the production requirement, and to
`devops/docs/technical/runbook-yaml-architecture.md`'s "Post-flight verification"
section, which explains why the deploy runbook cannot assert any of this on its
own.

**Paths in this document are relative to this repository unless prefixed
`devops/`.** The governance topology lives here — the Safe, the ceremony, the
fork fixture, `DeployTimelock` — while the acceptance driver that grades it lives
in the `devops` repo. Requirements in §4 bind both.

---

## 1. The principle

**Governance is isomorphic across CI, Stage and Production.** The same contract
code, the same quorum enforcement, the same signing path, the same assertions.
An environment that cannot enforce quorum is not a weaker version of production —
it is a different system, and any release decision made from it is unfounded.

This is stricter than "staging resembles production". Governance is the one
subsystem where a stand-in is indistinguishable from the real thing right up to
the moment it matters, because a single-key forwarder and a 2-of-N multisig
present the same interface to everything downstream: the TimelockController, the
router, the QA driver, and every assertion in this repo.

`docs/technical/security-model.md:328` already draws the line for unit tests — "Must not use
`vm.prank` as a substitute for real Safe quorum verification." This document
extends the same rule to every deployed environment.

### 1.1 What isomorphic does and does not mean

Isomorphic here means **the governance path is the same code exercised the same
way**. It does not mean the environments are identical in every respect:

| Property | CI | Stage | Production | Must match? |
|---|---|---|---|---|
| Safe contract code | canonical | canonical | canonical | **yes** |
| Quorum enforced by Safe | yes | yes | yes | **yes** |
| Signing path (`execTransaction`) | yes | yes | yes | **yes** |
| Threshold ≥ 2 | yes | yes | yes | **yes** |
| Owner key custody | in-memory test keys | ephemeral keystores | hardware wallets | no |
| Owner set membership | test addresses | ceremony keys | named humans | no |
| Chain | forked Base snapshot | forked Base snapshot | Base mainnet | no |

Key *custody* legitimately differs — CI cannot hold a hardware wallet. What may
never differ is that **two distinct owner signatures are required, and the Safe
contract is what enforces it.**

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

## 3. Current state

### 3.0 What issue #1447 changed

| Requirement | Where it is now enforced |
|---|---|
| R2, R3 | The fork fixture carries all five §2.2 contracts with their canonical code, and both singletons carry the lock their constructor writes (threshold = 1 in storage slot 4, so `setup()` on the singleton reverts `GS200`, as on Base). `scripts/devnet/snapshot-fork.sh` warms the five in a step that aborts on a missing one, writes the singletons' slot 4 read from Base at the pin block, checks every `anvil_setCode`/`anvil_setStorageAt` response, and runs the gate on what it captured. `scripts/devnet/check-fork-safe-set.sh` fails with exit 14 naming any contract that is absent, whose code does not hash to its pinned keccak256 (table below), or (singletons) whose slot 4 is not 1. The gate runs inside `check-fork-manifest.sh`, which is run by `run-golden-forge-forks.sh` — the suite-01-02 `forge-fork-vault-regressions` job, once per fork target (VaultForkRegressions, DeploySeedDeposit, SafeIntegration, GovernanceExecutePathAfterHandover) — and by suite-14 (smoke test). It does **not** run in suite-05's `anvil-goldens`/`anvil-governance` groups, which load `CURRENT.anvil-state` directly and verify only its sha256 digest. Its offline self-test runs in the same suite-01-02 job. |
| R4 | `SafeIntegration.t.sol` and the stage ceremony both use `SafeL2` (`0x29fcB43b…`); the test asserts the proxy's `masterCopy` slot, and `verify` checks the same slot on stage. |
| R5–R8 | `fusion-ceremony.sh run` creates a `SafeProxy` via `SafeProxyFactory.createProxyWithNonce` on `SafeL2` with the canonical fallback handler, threshold 2. It refuses a chain without the Safe set; there is no stand-in. `RehearsalSafe` and `DeployRehearsalSafe.s.sol` are deleted. |
| R9–R11 | Every Safe operation (`release`, `propose`) goes through `execTransaction` with two owner signatures over the Safe's own `getTransactionHash`, from keystores via `cast wallet sign --no-hash`, packed ascending by owner; each signature's `v` must be 27/28. A missing keystore or password stops the operation with exit 65 before anything is sent. Keystore passwords reach `cast wallet new` as `CAST_PASSWORD`, never on the command line, and a `run` that dies before its record is written shreds the keys it minted. |
| R12–R14 | `verify` reads everything from the Safe: its runtime code must hash to the canonical SafeProxy's (table below), threshold 2, owner set equal to the record's signers, `SafeL2` as singleton, no module (`getModulesPaginated(0x1, 10)` empty), no guard (slot `keccak256("guard_manager.guard.address")` zero), and the canonical fallback handler in slot `keccak256("fallback_manager.handler.address")`. Quorum is proved enforced by four eth_calls of one harmless SafeTx: one owner signature must revert `GS020`; the lowest owner's signature twice, and two non-owner signatures (the existing submitter and voter-a keystores), must each revert `GS026`; threshold signatures must return `true`. Every unreadable fact is a FAIL line and `verify` always reaches its summary. It no longer carries the single-key check. The devops driver grades these as `AC-ID-06#safe-quorum`, now a required AC-ID-06 clause. CI adds the GS020 negative control with its positive twin and a GS026 same-owner-twice control, asserts the fallback handler slot and that the handler and MultiSend carry code, and cancels a timelock operation through a two-signature `execTransaction`. |
| Provisioning | `ensure` provisions only a fresh chain. A recorded timelock or Safe that still has code, a `ProxyCreation` from the canonical factory, or (in `run`) a deployer that no longer holds gateway `ADMIN_ROLE` makes it exit 65 with "reboot the devnet (chain down/up)". A ceremony is live only with all three Safe owner keystores and their `.pw` files. |
| Self-test | `scripts/stage/tests/fusion-ceremony-selftest.sh` drives all of the above against a fake chain and a fake 2-of-3 Safe (digest over every SafeTx field, DELEGATECALL refused, owners recorded in descending address order). It runs as the suite-01-02 `fusion-ceremony-selftest` job on every non-draft PR, which fails unless the run prints its tally with 0 failures and at least the executed-assertion floor. |

Pinned code hashes (keccak256 of runtime code), derived from the committed fixture
and cross-checked with `cast codehash` on anvil loaded from it:

| Contract | Code hash | Pinned in |
|---|---|---|
| `SafeProxy` v1.4.1 (every proxy the factory creates) | `0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c` | `fusion-ceremony.sh` (`verify`) |
| `Safe` singleton (L1) | `0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4` | `check-fork-safe-set.sh` |
| `SafeL2` singleton | `0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff` | `check-fork-safe-set.sh` |
| `SafeProxyFactory` | `0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317` | `check-fork-safe-set.sh` |
| `CompatibilityFallbackHandler` | `0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9` | `check-fork-safe-set.sh` |
| `MultiSend` | `0x0e4f7fc66550a322d1e7688e181b75e217e662a4f3f4d6a29b22bc61217c4b77` | `check-fork-safe-set.sh` |

The SafeProxy hash was measured on a proxy created by the canonical factory on
anvil loaded from the committed fixture; SafeProxy has no immutables, so every
proxy carries the same runtime code.

The stage Safe's owners are three dedicated keys — `approver`, `approver-b`,
`approver-c` — minted with the other ephemeral keys (§7 Q1).

The fixture change adds the three missing contracts to the committed block
48896605 fixture rather than re-pinning it; see §7 Q5 for why.

The subsections below are the measurements that motivated the change. They
describe the stage chain as it was on 2026-09-18, and still describe it until it
is redeployed.

Measured against the live stage chain and the committed sources, 2026-09-18.

### 3.1 Per environment

| Environment | Safe | Quorum enforced | Drives the timelock |
|---|---|---|---|
| **CI** (`suite-01-02-forge-tests.yml`, step "forge test (Safe multisig integration — issue 422)") | real proxy, 2-of-3, via canonical factory | **yes** | `execTransaction`, two packed signatures |
| **Stage** (`scripts/stage/fusion-ceremony.sh:479`) | `RehearsalSafe` stand-in, unconditional | **no** | one EOA calls `exec()` |
| **Production** (`docs/technical/security-model.md:89`) | real 2-of-N, hardware wallets | yes | N signers |

**Stage is the only environment that unconditionally cannot enforce quorum, and
it is the one that gates release.**

### 3.2 Why the stand-in is undetectable

`contracts/script/DeployRehearsalSafe.s.sol` defines `RehearsalSafe`:

- one `immutable owner`, set at construction to the deploying EOA;
- `getThreshold()` declared `pure`, returning a hardcoded `2`;
- `exec(target, value, data)`, callable only by that one owner.

`DeployTimelock.s.sol:_validate` requires `SAFE_ADDRESS` to have deployed
bytecode and `getThreshold() >= 2`, specifically so that — in its own words — an
EOA at `SAFE_ADDRESS` cannot let a single private key control all of governance.

`RehearsalSafe` satisfies that check while **being** the thing it forbids. A
`pure` function returning a constant is not a threshold; it is an assertion that
cannot fail. Every downstream check inherits the same blindness.

The ceremony then compounds it. `fusion-ceremony.sh:292` asserts:

```
AC-ID-06 the approver is the only key that drives the safe
```

That check does not detect the defect. **It codifies it.** A check asserting
single-key control cannot coexist with a requirement for 2-of-N quorum, and it
must be deleted, not satisfied.

### 3.3 The fixture does not carry the full Safe set

Stage and CI both run `anvil --load-state testing/fixtures/fork-state/CURRENT.anvil-state`.
The fixture is produced by `scripts/devnet/snapshot-fork.sh`, which boots
`anvil --fork-url <Base> --fork-block-number <tip-100> --dump-state`, warms
selected state, then flushes on `SIGINT`.

**`--dump-state` persists only accounts touched during that session.** The
fixture is therefore a pruned snapshot, not a Base mirror — and neither consumer
passes `--fork-url`, so nothing can be fetched lazily afterwards.

Measured on the live stage chain:

| Contract | Present |
|---|---|
| `Safe` singleton `0x41675C09…` | yes, 47,161 bytes |
| `SafeProxyFactory` `0x4e1DCf7A…` | yes, 6,111 bytes |
| `SafeL2` singleton `0x29fcB43b…` | **no** |
| `CompatibilityFallbackHandler` `0xfd0732Dc…` | **no** |
| `MultiSend` `0x38869bf6…` | **no** |

`snapshot-fork.sh` contains **no Safe warming step** — it warms USDC and the real
adapters (#685) only. The two contracts that are present are incidental. Nothing
guarantees them, and the next `refresh-fork-fixture.sh` may silently drop them,
breaking `SafeIntegration.t.sol` in CI with no diagnostic pointing at the cause.

### 3.4 Defect in the existing CI test

`contracts/test/SafeIntegration.t.sol:120` declares:

```solidity
address internal constant SAFE_SINGLETON_L2 = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
```

That address is the **L1 `Safe`** singleton. `SafeL2` is `0x29fcB43b…` — the
address the file's own doc comment cites at line 104. The constant is therefore
mislabelled, and on Base it selects the wrong singleton.

This does not invalidate the test's quorum result: real Safe code enforces the
2-of-3 either way. It does mean CI is not exercising the singleton production
should use on an L2.

---

## 4. Required behavior

Normative. "Must" is binding; a violation is a release blocker.

### 4.1 Safe infrastructure

- **R1.** Every environment must obtain Safe contracts from the canonical
  addresses in §2.2. No environment may deploy its own Safe implementation,
  factory, handler, or any substitute for one.
- **R2.** Chains derived from a Base fork fixture must carry the complete Safe
  set from §2.2. The fixture build must explicitly warm those addresses so their
  presence is deterministic rather than incidental.
- **R3.** The fixture manifest check must fail when any address in §2.2 is
  absent. A fixture that silently lost Safe must not reach CI or stage.
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
  collection. `RehearsalSafe.exec()` is exactly such a path and must not exist.
- **R11.** Owner private keys must not be written to disk unencrypted or passed
  on a command line. Signing reads from the keystore
  (`cast wallet sign --no-hash --keystore`), matching how the ceremony already
  handles every other key.

### 4.4 Verification

- **R12.** Verification must assert the owner set and threshold read from the
  Safe, not from the deployment record. A record is a claim; the chain is the
  fact.
- **R13.** Verification must prove quorum is **enforced**, not merely configured:
  a `threshold - 1` signature attempt must revert. Configuration without a
  negative control proves nothing — this mirrors how `propose-negative` already
  makes `propose` meaningful.
- **R14.** Any assertion that a single key drives the Safe must be deleted.
  Specifically `fusion-ceremony.sh:292`.

---

## 5. Migration

Ordered by dependency. Each step is independently reviewable.

Steps 1–4 are done (issue #1447); §3.0 lists where each requirement now lives.
Two places deviate from the plan as written: step 1 augmented the committed
fixture instead of regenerating it (§7 Q5), and step 3's owners are three
dedicated approver keys rather than three of the existing ephemeral keys (§7 Q1).

**Step 1 — make the fixture carry Safe (R2, R3).** Add a Safe warming step to
`snapshot-fork.sh` touching all five §2.2 addresses. Add the assertion to
`check-fork-manifest.sh`. Regenerate the fixture. Nothing downstream is safe to
build until the contracts are guaranteed present; today's two are incidental.

**Step 2 — correct the singleton (R4).** Point `SafeIntegration.t.sol` at
`SafeL2`, rename `SAFE_SINGLETON_L2` to match what it holds, and reconcile the
doc comment at line 104. Self-contained; CI proves it.

**Step 3 — real Safe in the ceremony (R5–R11).** Replace
`fusion-ceremony.sh:479`'s `DeployRehearsalSafe` call with
`createProxyWithNonce`, owners = the three ephemeral keys the ceremony already
mints at `:440-447`, threshold 2. Replace the `exec()` drive with
`execTransaction` plus two keystore signatures. Delete
`DeployRehearsalSafe.s.sol` and the `RehearsalSafe` contract.

The EIP-712 digest construction and ascending signature packing already exist in
`SafeIntegration.t.sol` and have been exercised in CI since 2026-05-18. This step
is a port, not new cryptographic work.

**Step 4 — verification (R12–R14).** Delete `fusion-ceremony.sh:292`. Add
`getThreshold() == 2` and `getOwners()` set-equality checks. Add the
single-signature negative control (R13). Update `AC-ID-06`'s clause labels in
`devops/fusion-qa/src/checks/ceremony-verify.ts` to match.

**Step 5 — Base Sepolia (R8): moot.** The Base Sepolia rehearsal path this step
would have changed was removed outright (issue #1458, PR #1451); there is no
`rehearsal.sh` fallback left to fix.

---

## 6. Consequences

- Stage stops producing release verdicts from a governance topology production
  will never run. This is the point of the document.
- The ceremony gains a real dependency on the Safe set being present in the
  fixture. R3 converts that from a latent failure into a build-time one.
- `RehearsalSafe` disappears. Any chain without a canonical Safe deployment can
  no longer run the ceremony at all — deliberately, per R8. The recourse is to
  deploy Safe to that chain through Safe's own published process, not to
  substitute a stand-in.
- CI gains a negative control (R13) that means something. `SafeIntegration.t.sol`
  had a 1-of-3 case, but it accepted any revert (`vm.expectRevert()`); it now
  requires Safe's own `GS020` and then executes the same SafeTx with two
  signatures, and a same-owner-twice case requires `GS026`.
- AC-ID-06 cannot PASS on a stage still running the pre-#1447 stand-in: the
  devops driver requires `AC-ID-06#safe-quorum`, which only this `verify` prints.

---

## 7. Open questions

1. **Owner set composition on stage.** *Decided for #1447:* three dedicated
   keys, `approver`, `approver-b`, `approver-c`, minted like every other
   ephemeral key. Reusing existing keys would fuse governing bodies: the
   submitter is the agent whose receipts the Safe releases, the voters are
   RouterGovernance's approving body, and the emergency key is the independent
   hot key. `verify` asserts all of them are distinct. Still open: a
   production-shaped set with one key deliberately withheld from the host.
2. **Inheriting a production Safe.** Once a Robot Money Safe exists on Base
   mainnet, a fork could inherit it directly, giving stage the real owner set and
   threshold. Signatures would come from `approveHash` under
   `anvil_impersonateAccount` rather than ECDSA. This is strictly more
   isomorphic and should be revisited after the first mainnet deployment.
3. **Fixture size.** *Measured:* adding the three missing contracts grew
   `CURRENT.anvil-state` from 2,835,711 to 2,897,392 bytes (+2.2%); the two
   singleton locks (slot 4 = 1) add 274 bytes, to 2,897,666.
4. **Scope of R9.** This document covers the Safe → TimelockController path. It
   does not yet say anything about the `RouterGovernance` voter set, which is a
   separate governing body with its own quorum. Whether the two need a single
   unified isomorphism statement is unresolved.
5. **Re-pinning the fixture.** Step 1 did run `snapshot-fork.sh` end to end
   (mainnet.base.org, tip-100 = block 51734246, `foundry:latest` = anvil 1.8.1).
   The capture succeeded and carried all five Safe contracts, but its dump
   omitted EIP-1967 implementation contracts the committed fixture carries
   (Aave V3 Pool implementation `0xa4ab…`, aUSDC implementation `0x273e…`,
   Compound and Morpho implementations). Loaded offline, `aUSDC.totalSupply()`
   and `Pool.getReserveNormalizedIncome()` returned empty data; the same calls
   succeed on the committed fixture. That re-pin would have broken every offline
   fork suite, so step 1 instead added the three contracts (code, nonce and
   balance read from Base at block 48896605) to the committed fixture, leaving
   every other account byte-identical. The next re-pin needs `snapshot-fork.sh`
   to warm proxy implementations (or a pinned foundry image) first.
