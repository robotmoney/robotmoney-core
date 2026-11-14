# One-vault experiment: staged PRD amendments

Status: draft, 2026-11-11, extended 2026-11-13 (§5). Not applied. `docs/prd.md` describes the live
three-vault product and stays as it is while the experiment runs
(`one-vault-rebalancer-proposal.md`, status line). This file lists what the
PRD would have to say if the one-vault design goes to production. It exists
because an adversarial review found that the design breaks PRD promises that
no decision had recorded (proposal §17).

The owner's rule (2026-11-11): edit the PRD where the compromise is
reasonable for the customer. Where it is not, the design changes instead.
Line numbers refer to `docs/prd.md` on this branch.

## 1. Amendments that are reasonable for the customer

Each row quotes the PRD, states what the design does, says why the customer
is still served, and gives replacement text.

| # | PRD today | What the design does | Why it is reasonable | Proposed text |
| --- | --- | --- | --- | --- |
| 1 | §9, lines 384-386: "Withdrawals must settle in a single transaction with no queue: the stable-yield product lets a holder withdraw a chosen amount, and basket products let a holder redeem shares for their current value." | A USDC redemption is a request. It settles with its epoch, after a window (proposal §5.9, D10). An in-kind exit of delivered shares settles in one transaction. Its lending part above a per-period allowance is paid as a claim on that position. | The owner decided that customers can wait. The wait is what stops flash-loan and same-block attacks. A one-transaction exit still exists. | "A holder of delivered shares can leave in a single transaction by taking a pro-rata slice of the fund's assets (in-kind exit). The lending part above a per-period allowance is paid as a claim on that position. A redemption to USDC is a request. It settles from the next settlement after its window. A rate limit can spread a large request over several settlements, and an unfilled request expires back to its owner. The product states the earliest settlement time before the holder approves. The fund does not offer a withdrawal of a chosen USDC amount." |
| 2 | §6, lines 331-333: "New deposits can be halted for incident response while existing holders can always redeem. Withdrawals are never blocked, by anyone." | Safety checks can delay a USDC settlement. The emergency role can pause the queue. Shares from a deposit are held for one hour (one day until decision D4-11, owner 2026-11-13). The in-kind exit ignores all of these except the hold. | The promise that matters is that nobody can keep a holder's assets. That stays true through the in-kind exit. The hold is the owner's rule against a deposit and an exit in quick succession. | "New deposits can be halted for incident response. The in-kind exit of delivered shares is never blocked, by anyone. A USDC redemption can be delayed by the protocol's safety checks, by a rate limit or by a pause of the queue. A delayed request can always be cancelled, or converted to an in-kind exit. Shares from a deposit are held for at least one hour before they are delivered. An emergency freeze of held shares ends by itself, after 7 days by default and never after more than 14." |
| 3 | §9, line 383: "Deposits and withdrawals must provide a preview before user approval." Also §1, lines 16-18, and the success measure in §2, lines 91-92. | The previews revert, because the price of a timed flow is not known at the request. Quote views give the worst case at the time of the quote (proposal §5.9.2). | A worst-case quote is what a customer can act on when the price is set later. The customer's own limit makes the quote binding. | "Deposits and redemptions must provide a quote before user approval: the worst price the protocol's limits allow at the time of the quote, the fee, the earliest settlement time and the end of the hold. Each request carries the user's own price limit, and never fills outside it." The success measure becomes "percentage of attempted operations that show a quote before user approval". |
| 4 | §9, lines 391-393: "Autonomous-agent access must remain bounded by depositor-defined amount limits, allowed vaults, share receiver (always the owner), and expiration. An agent's only on-chain action is a deposit into a vault." | An agent's action is a deposit request with a price limit. The request belongs to the depositor. Shares are delivered to the depositor after the hold. | The agent still cannot receive shares, redirect funds or redeem. The depositor's policy gains one field, the price limit. | "… An agent's only on-chain action is a deposit request into the fund's queue, with the depositor as the request's owner and a price limit inside the depositor's policy. Shares are delivered to the owner, and anyone may trigger that delivery. An agent cannot cancel or redeem." |
| 5 | §9, lines 405-407: "The gateway may call only a vault's public deposit surface." | The gateway calls the queue's public deposit-request function. | Same boundary, new function. | "The gateway may call only the public deposit-request function of the fund's queue." |
| 6 | §2, lines 74-77, and §9, lines 397-398: the Safe changes "Portfolio Router target weights", and "The Portfolio Router must expose target weights, active weights, governance state, and historical outcomes." | There is no router. The Safe applies a receipt as per-asset targets on the fund and opens a rebalance plan (proposal §5). | The customer gains what the router never gave: existing money follows the receipt. | "The Safe multisig, through the TimelockController, is the only body that changes the fund's target weights. Applying a consensus receipt sets the targets and opens a rebalance plan. The fund must expose target weights, current weights, the plan's progress and cost, governance state, and historical outcomes." |
| 7 | §2, lines 82-86: "a deterministic four-bucket bps mean". | The receipt also carries one target weight per asset (proposal §4.1). A bucket with no listed asset must be 0. Today that is the agent bucket and the real-world-asset bucket. | The committee's decision becomes the whole on-chain input. Who writes the per-asset weights is still open (D8) and must be settled before this text is final. | "… one subject-scoped receipt with a deterministic four-bucket bps mean and one target weight per listed asset. The asset weights of a bucket sum to that bucket. A bucket with no listed asset carries 0 bps." |
| 8 | §8, lines 374-376: "Governance never covers vault internals, per-vault asset selection, strategy selection, fees, or individual agent permissions." | The applied receipt sets each asset's weight inside the fund. | The sentence sits under "Token-based governance of any kind", which stays excluded. The Safe applying the committee's targets is the product's stated purpose. | "Token-based governance of any kind. No token vote covers fund internals, asset selection, fees, or individual agent permissions. Asset weights are set only by the Safe through the timelock: by an applied consensus receipt, or by a direct target for bootstrap." |
| 9 | §11.4, lines 631-650: the RWA / Thematic vault holds deSPXA. | An asset is listed only with an independent price feed that is live at all hours (proposal §4.5, D12). That excludes tokenized equities, deSPXA among them. | The launch weight of the RWA vault is already 0 bps (line 525). The rule protects depositors from trading an asset nobody can price for most of the week. The loss is real and should be stated, not hidden. | Add: "The fund lists a real-world asset only if it has an independent price feed that is live at all hours. No tokenized equity meets this today. The real-world-asset bucket therefore carries 0 bps until one does." |
| 10 | §2, lines 90-92: success is measured by completion rate and previews. | Flows now take time. | The customer's experience is the wait and the cost. | Add the measures of gate G9: "median and 95th percentile time from a redemption request to claimable USDC", "share of settlements that complete at the keeper's first call", and "execution cost of a flow against its feed value, before the exit fee". |
| 11 | §9, lines 413-414: "Vaults must disclose risk labels, fees, caps, availability, and retirement or pause state." | One fund holds lending positions and volatile assets. A receipt can move its mix within per-asset caps. | A holder must be able to see the widest mix a receipt can produce. | Add: "The fund discloses one risk label for its widest permitted mix, the cap on each asset's weight, and the current plan." |

### 1.1 Other passages that repeat these promises

The same edits apply wherever the PRD says the same thing again.

| PRD lines | What it says | Follows amendment |
| --- | --- | --- |
| §1, lines 49-53 | The gateway forwards a permitted agent deposit to an allowed vault. | 4 and 5 |
| §2, lines 69-70 | "Depositors can withdraw synchronously from eligible vaults and Portfolio Router paths." | 1 |
| §4, lines 162-165 | A depositor gets funds out "in a single transaction with no queue". | 1 |
| §5, lines 201-204 | The product settles a withdrawal "in a single transaction with no queue". | 1 |
| §5, lines 290 and 292 | A withdrawal is never refused for a pause. A withdrawal path must meet synchronous settlement. | 1 and 2 |
| §6, lines 322-323 | An agent deposit goes "requested -> previewed -> approved -> settled into one allowed vault". | 3 and 4 |
| §12, lines 710-712 | "existing holders can always redeem, so withdrawals are never blocked". | 2 |

## 2. Promises the design keeps by changing itself

No PRD edit is needed for these. The review found the gap, and the design
was changed.

| PRD promise | Gap the review found | Change in the design |
| --- | --- | --- |
| §2, lines 80-81: "Product failures are explicit: users receive a product-level reason". | A blocked settlement reverted with no reason a client could read. | `checkSettle` names the first failing check (proposal §5.9.3). |
| §9, lines 408-412: three fee classes. | An entry premium would have been a fourth. | The entry premium is removed (proposal §17.3). The exit fee applies to every exit, in kind or in USDC, and must be disclosed as such. |
| §4, lines 175-176: "stable read and action surfaces". | The value views revert when a feed is unhealthy, so a position's value went dark. | `lastGoodNav` returns the last healthy value with its time (proposal §5.9.6). |
| §9, lines 387-388: surfaces must expose fees, net amounts, limits and refusal reasons. | No quote existed. | Quote views (proposal §5.9.2). |

## 3. A promise the design breaks, with no reasonable amendment yet

| PRD promise | What the design does | Why an amendment is not offered |
| --- | --- | --- |
| §1, lines 13-19: "direct vault selection" and "users can choose an exposure profile". Launch weights at line 525 are rmUSDC 9,500, rmPROTO 500 and rmRWA 0 bps. | Every holder has the same mix (proposal D2). | About 95% of the launch weight is stable yield. A depositor who wants only that would be moved into a fund that can hold volatile assets, with timed flows and shared rebalance cost. The proposal names the fix: keep a stable-only vault beside the fund. The experiment's conclusion decides (D2). Until then the PRD text stands. |

## 4. What must be settled before any of this is applied

- Whether step 3f is built (§5). If it is, §5 replaces amendments 1 to 4.

- The experiment's conclusion (proposal §10, step 5). None of this applies if
  the rejection of ADR-0010 is validated.
- D2: whether a stable-only vault stays beside the fund.
- D8: who writes the per-asset weights in a receipt.
- The G9 thresholds, which turn amendment 1 into numbers a customer can be
  told.
- The gateway's own design for request and claim (`rmpc` is a separate
  system).
- The Hard Assets vault on `dev`, which this branch predates. Its asset has
  not been assessed against the listing rule.

## 5. Changes if step 3f is built (owner, 2026-11-13)

The owner reviewed the flows on 2026-11-13 and found that several promises
to users were what made the design unsafe (proposal §18). Step 3f removes
the per-request price limit, the worst-case quote and the in-kind exit
from a running fund, and matches deposits against redemptions (proposal §5.11, D16 to
D19). It is decided and not built. If it is built, amendments 1 to 4 above
change as follows. Amendments 5 to 11 stand.

| # | Text of §1 that no longer holds | What step 3f does | Why it is still reasonable | Proposed text |
| --- | --- | --- | --- | --- |
| 1 | "A holder of delivered shares can leave in a single transaction by taking a pro-rata slice of the fund's assets (in-kind exit)." | There is no exit from a running fund except a settled redemption. A redemption is a request. It can be cancelled until its epoch closes. A request that is not filled expires back to its owner as shares. The in-kind exit opens only when the fund is shut down to be wound down. | An in-kind exit from a running fund let one user choose between the price and the assets at another user's cost. The owner decided that customers can wait. | "A redemption to USDC is a request. It can be cancelled until the end of the period in which it was made. It settles from the next settlement after its window. A rate limit can spread a large request over several settlements, and an unfilled request expires back to its owner. The product states the cancel cutoff and the earliest settlement time before the holder approves. The fund does not offer a withdrawal of a chosen USDC amount, and it does not offer an exit in kind while it runs. If the fund is wound down, every holder can take a pro-rata slice of its assets." |
| 2 | "The in-kind exit of delivered shares is never blocked, by anyone. … A delayed request can always be cancelled, or converted to an in-kind exit." | A USDC redemption is the only exit from a running fund. The safety checks, a rate limit or a pause can delay it. A pause ends by itself. The in-kind exit opens only in a wind-down, and only the Safe multisig starts a wind-down, through the timelock. | This amendment turns a guarantee into a dependence on the multisig, and the PRD must say so plainly. The owner decided it (proposal D18, D24): an exit in kind from a running fund gave one user an option at another's cost, and winding a fund down is a decision for the multisig. The promise becomes "the multisig winds down a fund that cannot settle, and a wound-down fund pays every holder in kind". | "New deposits can be halted for incident response. A USDC redemption can be delayed by the protocol's safety checks, by a rate limit or by a pause, and a pause ends by itself. While the fund runs there is no other exit. If the fund cannot settle, the Safe multisig winds it down, through the timelock. In a wind-down every holder can take a pro-rata slice of the fund's assets, and only the Safe can end it. Shares from a deposit are held for at least one day before they are delivered. An emergency freeze of held shares ends by itself, after 7 days by default and never after more than 14." |
| 3 | "Deposits and redemptions must provide a quote before user approval: the worst price the protocol's limits allow … Each request carries the user's own price limit, and never fills outside it." | A request names a quantity and no price. It is priced at its settlement, which is later than the request. The product shows the fee, the cancel cutoff, the earliest settlement time, the end of the hold, and the last known value as an indication. | This is how a regulated fund takes an order: at the next price, which nobody knows yet. It is what stops trading on a stale price. The protocol's own limits bound every settlement. | "Deposits and redemptions must show their terms before user approval: the fee, the time until which the request can be cancelled, the earliest settlement time, the end of the hold, and the last known share value marked as an indication. The price is set at settlement and is the same for every request of that settlement." The success measure becomes "percentage of attempted operations that show their terms before user approval". |
| 4 | "… with the depositor as the request's owner and a price limit inside the depositor's policy." | An agent's request carries no price limit. | The agent still cannot receive shares, redirect funds, cancel or redeem. The depositor's policy keeps its amount limits and expiry. | "… An agent's only on-chain action is a deposit request into the fund's queue, with the depositor as the request's owner. Shares are delivered to the owner, and anyone may trigger that delivery. An agent cannot cancel or redeem." |

Passages in §1.1 follow the same replacements.

One row of §2 changes too. "§9, lines 387-388: surfaces must expose fees,
net amounts, limits and refusal reasons" was kept by the quote views. Under
step 3f the surfaces expose fees, limits, times and refusal reasons, and a
net amount only after settlement. That needs an amendment of its own:
"Surfaces must expose fees, limits, settlement times and refusal reasons
before approval, and net amounts once a request has settled."

Still to settle before this section applies: the result of step 3f
(proposal §13). The owner confirmed on 2026-11-14 that a wind-down
requires the timelock (proposal D24).

The review of 2026-11-13 (proposal §19) also found PRD passages that step
3f breaks and that no amendment covers yet:

| PRD lines | What it says | What step 3f does |
| --- | --- | --- |
| §5, lines 303-309 | A retired vault keeps "standard ERC-4626 redemption at any time". | A redemption is a timed request, or an in-kind exit in a wind-down. |
| §12, about line 736 (INV-2) | Every asset is "always redeemable by holders". | Redeemable by a timed request, and in kind once the fund is wound down. |
| §6 and §9, lines 318-320 and 391-393 | An owner can revoke an agent's policy, or let it expire, and that stops the agent. | A deposit request the agent already made is locked until it fills or expires. |
| §9, line 390 | Surfaces "itemize fees and slippage". | There is no slippage estimate before a settlement. Fees are itemized. |

Line numbers are the reviewer's and were not rechecked.
