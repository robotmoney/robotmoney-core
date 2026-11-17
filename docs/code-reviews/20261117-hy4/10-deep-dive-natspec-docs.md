# Deep-dive E — stale NatSpec and operator-facing documentation consistency

Pinned scope (inherited from the first-pass review): repository
`git@github.com:robotmoney/robotmoney-core.git`; branch under review
`release-0.9.0`; work branch `review/security-release-0.9.0-20261117`;
pinned commit `d4a43e6d21efed208816698d2b32f0decea45451`; reviewed_at
`2026-11-17`. Worktree:
`/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-core/adhoc-20261117-145601`.
Principal checkout left read-only; no production code, canonical doc, or
sibling artifact was modified. Severity rubric: the shared `review-contract.md`
in `/drive2/home/lucas/.agents/skills/_shared/`.

Observed facts (quoted comments, code lines, doc text) are labelled as such;
impact judgements are reviewer inference and are labelled.

---

## E1 — Confirm and widen the stale NatSpec check

VERDICT: advisory

EVIDENCE:
- `contracts/PortfolioRouter.sol:1074-1076` (comment, observed)
- `contracts/PortfolioRouter.sol:1002` (`external` entrypoint, observed)
- `contracts/PortfolioRouter.sol:1069-1071` (confused-deputy guard, observed)
- `contracts/PortfolioRouter.sol:1077` (`vault.redeem` call, observed)
- `contracts/PortfolioRouter.sol:1041` and `:966-967` (correct actor NatSpec in same file, observed)
- `contracts/gateway/interfaces/IPortfolioRouter.sol:21-22` and `:29-30` (secondary candidate, observed)
- `contracts/gateway/interfaces/IPortfolioRouter.sol:44-51` (interface signature, observed)

ANALYSIS:

**Candidate A — confirmed stale comment (`PortfolioRouter.sol:1074-1076`).** The
comment reads:

> `// Redeem: shareHolder must have approved msg.sender (the gateway) to`
> `// spend their vault shares; the gateway is the \`owner\` caller here.`
> `// vault.redeem sends USDC directly to assetRecipient.`

The surrounding function was read in full (`redeemFor`,
`PortfolioRouter.sol:995-1035`; `_redeemLeg`, `:1046-1083`). Two distinct
mismatches are observed against the code:

1. **"msg.sender (the gateway)" is false as a general statement.** `redeemFor`
   is `external` (`:1002`), so any address may call it. The guard at
   `:1069-1071` is
   `if (msg.sender != shareHolder && IERC20(vault).allowance(shareHolder, msg.sender) < shares) revert UnauthorizedRedeemer(...)`,
   which explicitly admits two caller classes: `shareHolder` itself, **or any
   approved spender** on the vault share token. The gateway is one possible
   caller, not "the" caller. The NatSpec immediately above at `:926-932` gets
   this right ("The caller (typically the gateway) must either be `shareHolder`
   itself ... or hold an ERC-20 allowance"), so `:1074` is stale relative to
   both the code and its own function's documentation.

2. **"the gateway is the `owner` caller here" is false.** The call at `:1077`
   is `IERC4626(vault).redeem(shares, assetRecipient, shareHolder)` — the
   ERC-4626 `owner` argument is `shareHolder`, not `msg.sender`/the gateway.
   This is corroborated by the correct NatSpec in the same file: `:1041`
   "`shareHolder` Owner of the shares (the `owner` passed to `vault.redeem`)"
   and `:966-967` "`shareHolder` ... (the `owner` passed to `vault.redeem`)".
   The inline comment at `:1075` therefore directly contradicts the file's own
   authoritative NatSpec.

The third sentence ("vault.redeem sends USDC directly to assetRecipient") is
accurate and matches `:1077` plus the all-or-revert note at `:962-964`.

This is a documentation-only staleness: the guard, the redeem call, and the
tests cited by the first pass are correct. No code change is required.

**Candidate B — secondary wording mismatch (`IPortfolioRouter.sol:21-22`).** The
gateway-facing interface NatSpec reads:

> `/// @notice Redeem vault shares from an explicit, caller-supplied set of`
> `///         vaults. Pulls shares from \`shareHolder\` via ERC-20 \`transferFrom\``
> `///         (shareHolder must approve the router for each vault share token), ...`

and `:29-30` repeats "`shareHolder` ... (must have approved the router to spend
shares per vault)". There is **no `transferFrom` call anywhere in
`PortfolioRouter.sol`** (verified by grep: the only share movement in the
redeem path is `:1077`
`IERC4626(vault).redeem(shares, assetRecipient, shareHolder)`, which burns
shares from `owner` through the router's ERC-4626 allowance). The router's own
NatSpec at `:949-950` states the correct mechanism: "The router calls
`vault.redeem` with itself as the vault-level spender." So "via ERC-20
`transferFrom`" is an inaccurate description of the mechanism (it implies the
router takes custody of shares, which it does not — cf. gateway contract
comment `RobotMoneyGateway.sol:29` "the gateway never custodies vault shares"
and the all-or-revert note "No intermediate USDC custody is created in the
router" at `PortfolioRouter.sol:962-964`). The *practical* approval requirement
it states is correct, which is why this is low-confidence and advisory only.

**Systematic scan result.** A grep of all production Solidity under
`contracts/` (excluding `contracts/test/**` and `contracts/doc/**`) for
comment lines naming `msg.sender`, "the owner", "the caller", spender,
recipient, "the gateway", approval, authority or role returned 422 comment
lines. The privileged/redemption-dense files were read in full or targeted:
`PortfolioRouter.sol` (deposit/redeem/guards), `RobotMoneyVault.sol`
(`redeem`/`withdraw`/`_withdraw`, `:741-819`),
`RobotMoneyGateway.sol` (agent deposit `:570-670`, actor comments),
`ConsensusRecommendationReceipt.sol` (`recordReceipt`, `:155-183`),
`VaultRegistry.sol`, `ExclusionLedger.sol`, `ForeignTokenQuarantine.sol`, and
the gateway/vault interfaces. No further comment was found that names an actor
in contradiction with the adjacent code:

- `RobotMoneyVault.sol:747,762` "@param owner ... (the caller or an approved
  spender)" is correct — `_withdraw` at `:780-782` spends allowance only when
  `caller != owner`.
- `RobotMoneyGateway.sol:25` / `IGateway.sol:138` "shares ... to the policy's
  share receiver (the owner)" is correct — `depositTo` sets
  `args.shareReceiver = p.shareReceiver` (`:610`) and architecture §5.2
  (`docs/architecture.md:1112-1115`) records that the validator requires
  `shareReceiver == msg.sender`.
- `ConsensusRecommendationReceipt.sol:46` / `IConsensusRecommendationReceipt.sol:32`
  "The submitter is `msg.sender`" is correct — `recordReceipt` at `:160`
  assigns `address submitter = msg.sender`.
- `PortfolioRouter.sol:898-900,927,952` use "typically the gateway" / "the
  gateway's transient self-custody flow" — qualified, not absolute; accurate.

SEVERITY IF PROMOTED: `info` (clarity only — the harmed axis under the rubric
is (a) clarity, with no effect on release or assertion integrity; a
clarity-with-small-cost issue is at most `low`, and here there is no concrete
cost, so `info`). The rubric's `info` token — "naming, style, or wording —
nothing a merge decision should turn on" — is the exact fit.

RECOMMENDATION: Advisory only; do not block the release. Correct
`PortfolioRouter.sol:1074-1076` to read, e.g., "The caller is `shareHolder` or
an approved share spender (see the guard above); `vault.redeem` burns from
`shareHolder` (the ERC-4626 `owner`) and sends USDC to `assetRecipient`." Optionally
reword `IPortfolioRouter.sol:21-22` to say the router calls `vault.redeem`
against the holder's allowance rather than "via ERC-20 `transferFrom`". This
matches first-pass recommendation 2 (owner: code/docs-only).

---

## E2 — Operator-impact test

VERDICT: advisory

EVIDENCE:
- `clients/dapp/src/lib/routerRedeem.ts:9,16-21,77-92,239-259` (signing client, observed)
- `docs/technical/gateway-withdrawal-decisions.md:268-277` (superseded design doc, observed)
- `docs/technical/smart-contract-invariants.md:187,193,206` (operator invariant doc, observed)
- `docs/operations/retired-v1-vault-maintenance.md:18-29` (operator runbook, observed)
- `docs/technical/redeem-gas-1482.md:46,53,71` and `docs/technical/single-vault-redeploy.md:119` (observed)
- `docs/technical/security-model.md:63,70,279-280` (observed)
- Searched with no matching stale text: `docs/operations/**`, `docs/runbooks/**`,
  `docs/technical/**`, `clients/**`, `services/**`, `publish-contracts/**`,
  `.github/workflows/**`

ANALYSIS:

For each E1 candidate I looked for a concrete harmful decision path — a runbook
telling an operator to grant a role the code does not use, a signing client
previewing the wrong spender/recipient, or a doc claiming withdrawals are
frozen when they are not. None was found; every checked operator/integration
surface repeats the **correct** actor model, not the stale comment.

- **Signing client previews the correct spender/recipient.** `routerRedeem.ts:9`
  builds `redeemFor(holder, holder, [vault], [shares], [floor], deadline)`;
  `:77-92` `routerRedeemCall` encodes `args: [i.holder, i.holder, ...]`, i.e.
  `shareHolder = assetRecipient = holder`. `:16-21` states the router is the
  share spender and the holder approves exactly `shares`, with a revoke for any
  leftover allowance (`:239-259`). This matches code line `:1077` and the
  guard at `:1069-1071`. There is no path where the stale "gateway is the
  owner" comment could reach a user's signing preview: the dapp never derives
  its preview from that inline Solidity comment, and the preview calldata is
  asserted to equal the signed calldata (`routerRedeem.ts:29-30,107-120`).

- **Operator runbooks use the correct withdrawal model.** `docs/operations/retired-v1-vault-maintenance.md:18-29`
  says redemption is open indefinitely through both `redeem` and `redeemFor`,
  and explicitly warns that only the *deployed v1* vault's `pause()` freezes
  withdrawals ("Never call `pause()` on the v1 vault"). Current contracts are
  documented as never freezing withdrawals — consistent with
  `RobotMoneyVault.sol:155` and `BasketVault.sol:172`. A doc that says
  withdrawals are frozen when they are not: **not present**. `docs/technical/smart-contract-invariants.md:187`
  is explicit and accurate: "withdrawals are never frozen, by anyone ... No
  current vault has a withdrawal-pause flag ... core 1494 deleted
  `withdrawalsPaused`".

- **Role/authority guidance matches the code.**
  `docs/technical/security-model.md:279-280` records that agent keys are
  constrained to `AGENT_ROLE` deposit only, the owner is always the share
  receiver, and the gateway has no withdrawal path — consistent with
  `docs/architecture.md:1133-1141` and code. The release runbook
  (`docs/operations/contract-release-runbooks.md:413`) verifies that no
  `AGENT_ROLE` is granted at deploy and no agent log exists before handover —
  a grant that the code does not use is not being recommended anywhere.

- **Superseded docs are labelled and actor-correct.** `gateway-withdrawal-decisions.md`
  is explicitly marked superseded (`:6`), and its surviving actor text at
  `:269-277` is correct: "`redeemFor` is a public router surface. Its caller
  must be the share holder or hold the holder's share allowance ... `redeemFor`
  calls `vault.redeem(shares, assetRecipient, shareHolder)` directly per leg."
  It does not repeat the "gateway is owner / msg.sender is gateway" claim.

- **No doc repeats the `transferFrom` wording.** No operator or client file
  found states that the router pulls shares via ERC-20 `transferFrom`; the dapp
  and technical docs describe an approve + `vault.redeem` with the router as
  spender, which is the accurate mechanism.

Reviewer inference: because the stale text lives only in a Solidity inline
comment and every operator, runbook, and client surface already carries the
correct model, there is no realistic path by which an operator, signer or
integrator is led to a harmful action by it. Under the rubric this keeps both
E1 candidates at `info`; promoting either above `info` would require showing a
concrete harmful decision path, which the evidence does not provide. The
one-actor confusion that *could* have mattered — an off-chain client deriving
`owner = gateway` from the comment — is contradicted by the actual client code
(`holder` as owner/recipient) and by the file's own correct NatSpec.

SEVERITY IF PROMOTED: `info` (no material harm axis; if a reviewer insisted on
a small clarity cost, `low` is the ceiling — there is no demonstrated harmful
decision path to reach `medium` or above).

RECOMMENDATION: No operator or client change required. Keep this as an
advisory documentation follow-up; do not edit runbooks, clients, services, or
CI, all of which are already consistent with the code. If the inline comment
is fixed per E1, no downstream artifact needs to change.

---

## E3 — Design-intent check: `deadline` excluded from the gateway idempotency key

VERDICT: closed

EVIDENCE:
- `contracts/gateway/RobotMoneyGateway.sol:30` (contract-level comment, observed)
- `contracts/gateway/RobotMoneyGateway.sol:624-651` (`paymentId` construction and replay check, observed)
- `contracts/gateway/RobotMoneyGateway.sol:599-601` (deadline checks, observed)
- `contracts/gateway/RobotMoneyGateway.sol:142` (`MAX_DEADLINE_SKEW = 600`, observed)
- `contracts/gateway/interfaces/IGateway.sol:146-151` (interface `@param`/`@return`, observed)
- `docs/architecture.md:1041-1155` (§5.2, observed); `docs/adr/ADR-0014-governed-uups-upgrades-and-freeze.md:143` and `docs/adr/ADR-0003`/`ADR-0005` searched (deadline appears only for release sheet / rebalance / swap, not idempotency)

ANALYSIS:

The first pass described the omission of `deadline` from the gateway's
idempotency key as *documented intent*. This is confirmed accurate at the pin,
in both directions:

1. **The comment is accurate about the code.** `RobotMoneyGateway.sol:30`
   states "The idempotency hash deliberately excludes `deadline`." The
   `paymentId` is built at `:638-650` as
   `keccak256(abi.encode(OP_DEPOSIT_TO, block.chainid, address(this), msg.sender,
   orderId, amount, idempotencyKey, destination, minSharesPerLeg))` — `deadline`
   is indeed absent, and `:624` repeats "DEADLINE INTENTIONALLY EXCLUDED". The
   interface `IGateway.sol:150-151` documents the identical preimage with no
   `deadline`. Code, inline comment, and interface NatSpec agree.

2. **Deadline is still enforced, so excluding it does not remove a stated
   protection.** `:599-601` checks both `block.timestamp > deadline`
   (`DeadlineExpired`) and `deadline > block.timestamp + MAX_DEADLINE_SKEW`
   (`DeadlineTooFar`), with `MAX_DEADLINE_SKEW = 600` (`:142`), matching
   `IGateway.sol:146` "must be `<= block.timestamp + 600`". Replay protection is
   separately provided by `usedPaymentIds[paymentId]` (`:651,662`) and the
   full-intent binding rationale at `:629-637` names `destination` and
   `minSharesPerLeg`, not `deadline`.

3. **No doc claims a protection the code does not provide.** §5.2
   (`docs/architecture.md:1129-1141`) says the gateway "enforces amount, expiry,
   window usage, allowed destination, idempotency, deposit pause, and share
   receiver on-chain" — all of which are present (expiry via the deadline
   checks above; idempotency via `usedPaymentIds`). §5.2 makes no claim that
   `deadline` is part of the idempotency hash. ADRs searched contain no
   contrary claim. `docs/technical/smart-contract-invariants.md` records GW-2
   as the full-intent idempotency invariant; the code comment defines "full
   intent" as destination + slippage vector and explicitly carves out deadline,
   with no conflict.

Reviewer inference: excluding a purely time-validity parameter from a replay
key is internally coherent (a changed deadline does not create a new execution
intent, only a new validity window), and `depositTo` is `onlyRole(AGENT_ROLE)`
(`:582`), so the only parties who can vary `deadline` are already-trusted agent
keys. There is no documentation gap to report and no stale claim to correct.
This E3 sub-task is therefore closed with no recommendation.

SEVERITY IF PROMOTED: not applicable — closed, no finding. (If an E3 item were
promoted, the only arguable issue would be a clarity-level `info` about making
the "deadline excluded" rationale more prominent; no doc is false.)

RECOMMENDATION: None. Optionally, if the architecture doc is ever revised, keep
§5.2's "expiry + idempotency" wording and do not add a claim that `deadline` is
folded into `paymentId`, since the code deliberately does not.

---

## Limitations

- Static review at the pinned commit only; no forge build, test execution, or
  on-chain readback was performed in this deep-dive (the first pass's single
  executed-test claim is inherited, not independently re-run here).
- The NatSpec scan was keyword-driven (actor/role/spender/recipient/authority
  terms in comment lines) plus targeted full reads of privileged and
  redemption paths; comments phrased without those keywords in less-sensitive
  libraries or deploy scripts may not have been read line-by-line. Deploy
  scripts were sampled, not exhaustively audited for actor wording.
- The operator-doc search relied on keyword grep over the named directories;
  a file that restates the stale actor model in unrelated wording could have
  been missed. No doc was found repeating either candidate.
- Synthesis of "closing" E3 rests on §5.2 and the searched ADRs; an ADR or
  canonical doc outside `docs/adr/` and `docs/architecture.md` was not
  exhaustively enumerated.
- This worker did not modify production code, canonical docs, existing review
  artifacts, `scripts/check-audit-ledger.sh`, or sibling scratch files; its sole
  write is this output file.

## checked_shapes

Catalogue: `docs/development/false-green-shapes.md`. Relevant shapes evaluated
for this documentation-consistency deep-dive:

- `doc-contradicts-guard-invariant` — checked for E1/E2: the stale NatSpec
  contradicts code and the file's own NatSpec, but no *operator/runbook* doc
  contradicts a guard invariant; all operator docs match the code. Candidate A
  is a stale comment, not a live guard/doc contradiction in the operator
  surface; recorded at `info`.
- `starved-guard-input` — not evaluated in this documentation-focused worker
  (the synthesized report notes it was only partially evaluated for the forge
  evidence wrapper; out of scope here).
- `trigger-scoped-dead-code` — checked for E3: the deadline exclusion is live
  code (`:638-651`) with executed checks (`:599-601`), not dead or trigger-scoped.
- `stale-cache-embedded-artefact` — checked: no cached/generated artifact was
  found repeating the stale actor wording in the searched operator surfaces
  (the generated dapp ABI `abi.generated.ts` exposes the `redeemFor` signature
  only, with no actor prose).

All other catalogue shapes were outside this worker's documentation-consistency
scope and were not re-evaluated here.
