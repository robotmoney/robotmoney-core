# Geth Read-After-Write State-Lag: Why the Devnet Harness Must Poll Reads

> Canonical: `testing/smoke-test/src/lib.rs` (`Fixture::approve_and_confirm`,
> `Fixture::erc20_allowance`, `wait_for_vault_registered`).
> Sibling class: [`docs/testing/geth-gas-estimation.md`](geth-gas-estimation.md)
> (state-dependent gas under same-block concurrency).

This document records a class of **read-after-write state-lag** failures that the
Geth smoke-test devnet produces, why they look like contract or wiring bugs but
are not, and the poll-after-write policy the test harness applies so a dependent
read never races the write it depends on.

---

## Symptom

A write transaction is confirmed mined, yet the very next read against the same
Geth devnet observes the **pre-write** state. The dependent step then fails
intermittently — passing on most runs, failing on loaded CI runners — with
errors such as:

```
ERC20: transfer amount exceeds allowance
```

(the just-sent `approve` is invisible to the dependent `transferFrom`/`deposit`),
or:

```
vault <addr> not visible in registry <addr> listVaults() ...
NotRegistered()
```

(the just-mined `registerVault` is invisible to the dependent
`setRouterEligible` / router-deploy simulation).

The transaction that performed the write has a valid receipt with
`status: "0x1"` — it genuinely mined and genuinely succeeded. The failure is in
the **read that follows it**, not the write.

## Root cause

`cast send` (and the underlying `eth_sendRawTransaction` + receipt wait) returns
as soon as the transaction is **mined**. On the Geth devnet, the state-read path
can briefly lag the state-update: for a short window after the receipt is
available, an `eth_call` / `cast call` pinned to `latest` still resolves against
state that does not yet include the just-mined transaction. The window widens on
a loaded CI runner where the read and the apply race more often.

A receipt-confirmed transaction therefore **does not imply readable state**. The
contracts are correct; the only thing diverging from a settled chain is that the
harness read the dependent value too early, in the gap between "mined" and
"visible to `latest` reads".

This is a distinct class from the gas-estimation flake documented in
[`geth-gas-estimation.md`](geth-gas-estimation.md): there the *write* is
under-funded; here the *write* succeeds and only the *follow-up read* is stale.
Both are devnet timing artifacts that must not be hidden by serialising or
skipping.

## Why this is not a contract bug

On any settled chain (and against production RPC providers) the read after a
confirmed write reflects the write — the lag is an artifact of the single-node
devnet's mine-then-apply timing under load. Serialising the harness, adding a
fixed `sleep`, or marking the test `#[ignore]` would each **hide** the timing
signal rather than tolerate it honestly: a fixed sleep is either too short (still
flaky) or too long (slow), and a skip produces a false green. The harness instead
**polls the dependent read until it reflects the write**, which is correct
regardless of how long the devnet takes to settle.

## The fix: poll-until-settled

Both fixes share one shape — after a write whose result a later step reads, poll
the dependent read until it reflects the write, with a bounded retry budget, and
**error loudly** (return `Err`, never skip) if it never settles.

### Allowance visibility — `approve_and_confirm` + `erc20_allowance`

`Fixture::approve_and_confirm` sends `approve(spender, amount)` and then polls
`Fixture::erc20_allowance(token, owner, spender)` — a plain `eth_call` /
`cast call` of `allowance(address,address)` — until the on-chain allowance is
`>= amount` before returning the tx hash. The poll runs **5 attempts, 200ms
apart**; if the allowance never reaches `amount`, it returns an `Err` naming the
unsettled state-lag rather than letting the dependent `transferFrom`/`deposit`
revert with the misleading "transfer amount exceeds allowance".

### Registry visibility — `wait_for_vault_registered`

`wait_for_vault_registered` sends nothing itself; it is called after a
`registerVault` write and polls `listVaults()(address[])` on the `VaultRegistry`
until the just-registered vault address appears, so the dependent
PortfolioRouter deploy forks a head that already includes the registration. It
polls with a 30s deadline at 500ms intervals and returns an `Err` naming the
unsettled registry read if the vault never appears.

## Guidance for harness authors

- **A confirmed receipt does not mean readable state.** Any new devnet test step
  that reads on-chain state immediately after `wait_for_receipt` / `cast send`
  must **poll the dependent read until it reflects the write** — never assume the
  receipt implies the read will see the update.
- **Poll-until-settled, not sleep-then-read.** Use the existing helpers as the
  pattern: bounded retries (**>=5 attempts, ~200ms apart** for fast on-chain
  reads, or a wall-clock deadline for slower ones), returning the value the
  moment the read reflects the write.
- **Error loudly if it never settles.** If the read never reflects the write
  within the retry budget, return an `Err` that names the state-lag — never
  `#[ignore]`, `t.Skip()`, or swallow it. A silent skip turns a real race into a
  false green.
- **Do not serialise to dodge it.** Serialising concurrent writers to avoid the
  lag hides production concurrency; tolerate the lag with a poll instead, the
  same way the gas-estimation class is tolerated by buffering rather than by
  serialising (see [`geth-gas-estimation.md`](geth-gas-estimation.md)).
