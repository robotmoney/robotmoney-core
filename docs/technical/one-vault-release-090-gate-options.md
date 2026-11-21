# One-vault 0.9.0: owner decisions

These are decisions for the release owner. Results and limits are in the proposal,
section 14. They are not release approvals.

## G9: match band

The plan's fallback has already been built and rerun. A 10 bps match band
improved the maximum flow cost from 39.25 to 16.94 bps, within the 30 bps
limit. First-call availability was 99.40%, and redemption wait p95 was 6.55
hours. The owner can retain this band or choose another design and rerun the
gate. A skipped match is net traded instead.

## G8: positive attack returns

At the 90 bps reference band A10 earns 156.64 USDC; the strict simulations
also find A2 at 0.35 and A6 at 467.55 USDC. Holders lose zero in these runs.
A21's earlier reported gain was double-counting; its corrected tests pass.

- Accept these measured results and the present band, recording the G8 failure
  and its risk.
- Tighten the reference band and rerun. Stopping A10 needs below about 35 bps;
  at 50 bps first-call availability was 84.02%, below the 95% G9 limit.

## G5: 5M plan cost budget

Three one-day 5M plans reach their cost budget and do not converge. In one,
48 later calls raise the blocked skip rate to 18.8%. G5 is not a pass.

- Give a 5M target a larger cost budget or longer plan, then rerun and score
  the resulting execution and cost.
- Change scoring to exclude calls after a halt and have the keeper stop calling
  after preview signals a halt. This addresses those calls, but does not make
  the three plans converge; the convergence requirement still needs a ruling.

## A24: cutoff attack accounting

The test deducts lending yield and TWAP lag before checking attacker net. Yield
is earned by holders generally. The lag is a price difference from the feed;
its block currently deducts the value on all matched shares, not explicitly
just the attacker's shares. A21 independently tests lag.

- Retain benchmark adjustments only after proving they apply to the attacker's
  position, and report the gross result and each deduction alongside net.
- Count the TWAP lag as attacker gain and record the result in G8. This exposes
  the full feed-relative result but combines the cutoff with a separate effect.

## D33: emergency deposit stop

- Keep the working default: the emergency key can renew `pauseDeposits` without
  a cooldown. It can protect locked depositors during public notice, but a
  compromised key can keep deposits stopped until revoked.
- Give the Safe a direct stop outside the timelock. This moves the fast-stop
  authority to the Safe and requires its availability.

## D31: scarce match allocation

- Keep proportional sharing by size. All requests on a side share the match;
  requesting more receives more of a scarce match.
- Allocate by age. Older requests fill first; a large early request can consume
  the match while later requests wait. This needs design and implementation
  work and renewed testing.

## D38: basket weight cap

- Keep `maxBasketBps` at 10,000, which imposes no additional basket-weight
  restriction.
- Set a lower cap. It limits basket exposure and matched-price risk, but also
  limits portfolio construction. Supply the desired value in basis points.

## D39: cancel buffer

- Keep the 15-minute default. It closes cancellation before the epoch ends,
  reducing a last-block withdrawal of apparent match liquidity.
- Choose another value below the epoch length. A longer buffer provides more
  protection but locks requests earlier; a shorter one does the reverse.
