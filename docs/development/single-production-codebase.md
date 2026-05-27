# Single Production Codebase

> Canonical principle. Related: `docs/development/environments.md` (the concrete environment
> modes this principle governs), `docs/architecture.md`, and issue #475 (the
> refactor that brings the contracts into compliance). The `rmpc` corollary —
> "one client, no env-specific behavior, never spoof users" — is the same rule
> applied to the daemon.

## The rule

**There is one production codebase. The same artifacts are deployed unchanged
into every environment. Environments differ only by (a) deployment
configuration and (b) seeded application data — never by code.**

Concretely, the following are prohibited:

- Test-only or demo-only code variants (subclasses, build flags, compile-time
  branches, or `if (env == "test")` logic) that exist solely to make one
  environment behave differently.
- Spoofing users, balances, time, or protocol state in code to make an
  environment "work."
- Expressing readiness, eligibility, or capability as a *code variant* when it
  is really *state* — i.e. something that should live in configuration or a
  registry that an operator sets.

And the following are how variation is expressed instead:

- **Configuration** — addresses, RPC endpoints, chain ids, delays, caps,
  thresholds, role holders. Injected at deploy/boot time, identical binary.
- **Seeded data** — a demo environment is the production code pointed at a chain
  whose *state* has been seeded (deposits, vault registrations, balances). See
  `docs/development/environments.md`: the local devnet boots from a pinned Base mainnet
  snapshot and deploys the real contracts fresh; the fork environment
  impersonates real accounts. Neither swaps in different code.

> **Note for future agents:** this is an industry-standard discipline, not a
> Robot Money invention. If you are tempted to add a "test version" of a
> contract, a mock that diverges from the real collaborator, or an environment
> branch, treat it as a smell and reach for configuration + seeded data first.
> The references below exist so this rule can be cited, not just asserted.

## Why it matters

The failure mode this prevents is **"works in test, breaks in production"**: the
moment a test or demo runs different code than production, passing tests stop
being evidence about production. Divergent variants also rot independently, hide
real integration bugs behind mocks, and quietly accumulate trust assumptions
nobody reviewed.

The canonical local example is the basket-vault router-eligibility gate.
Before issue #475 production contracts carried an `isPrototype()` /
`prototypeOverride` / `nonPrototypeAttested` machine, and the test suite added
a `HardenedBasketVault` subclass that overrode `isPrototype()` to `false`
purely to exercise the eligible path. That subclass was a code variant
standing in for what should be **registry state** an operator sets — so a
test proved the behaviour of code that never shipped. Issue #475 resolved this
by replacing the entire stack with a single registry flag,
`VaultRegistry.isRouterEligible(vault)`, flipped by ADMIN_ROLE through
`VaultRegistry.setRouterEligible`. The same contracts now ship into every
environment; only the registry flag's value differs.

## Prior art and origins

This principle is a convergence of several lineages. The deepest root predates
software: it comes from **configuration management** in 1960s aerospace and
defense.

| Year | Source | Contribution to this rule |
| --- | --- | --- |
| ~1962–1968 | **Configuration management**, US aerospace/defense — US Air Force *AFSCM 375-series* (mid-1960s), later codified as *MIL-STD-480 / -483* (1968); applied on NASA's Apollo program | The original "controlled baseline + tracked configuration." One identical baseline article; differences between units are *configuration*, recorded and controlled, not divergent rebuilds. This is the conceptual ancestor of "same artifact, config differs." |
| 1968 | **Melvin Conway**, *How Do Committees Invent?* (Datamation) — "Conway's Law" | Explains *why* environment variants creep in: systems mirror the communication structure of the org that builds them. Divergent test/prod code is usually an org/process artifact, not a technical necessity. |
| 1968–69 | **NATO Software Engineering Conference**, Garmisch (report ed. Peter Naur & Brian Randell) | Birth of "software engineering" as a discipline; framed reproducibility and engineering rigor as the goal, against ad-hoc per-instance builds. |
| 1972 | **Marc Rochkind**, SCCS (Bell Labs) | First widely used source/version control — a single controlled source of truth for the codebase, the mechanical basis for "one codebase." |
| 1972 / 1976 | **David Parnas**, *On the Criteria To Be Used in Decomposing Systems into Modules* (1972); *On the Design and Development of Program Families* (1976) | Variation must be **designed and parameterized** (information hiding; a deliberate "program family" from one base), not forked ad hoc. The disciplined opposite of one-off variants. |
| 2007 | **Martin Fowler**, *Mocks Aren't Stubs* | The "classicist" testing position: prefer real collaborators and seeded state over test doubles that drift from production behaviour. |
| 2010 | **Jez Humble & David Farley**, *Continuous Delivery* | "**Build your binaries once**; promote the *same* artifact through environments, injecting only configuration." The most direct modern statement of this rule. |
| 2011 | **Adam Wiggins / Heroku**, *The Twelve-Factor App* | Factor III (**Config** — strict separation of config from code) and Factor X (**Dev/prod parity** — keep environments as alike as possible). |
| 2012– | **Bill Baker / Randy Bias** ("pets vs. cattle"); **Chad Fowler / Netflix** ("Trash Your Servers and Burn Your Code," 2013); **HashiCorp** (Packer) | **Immutable infrastructure**: the deployed artifact is never mutated per environment; you rebuild from one source and redeploy. |
| 2010s– | **Paradigm / Foundry**, mainnet-fork testing | The web3 form of the same idea: test against a fork of the *real* chain with the *real* contracts and impersonated/seeded state, rather than mock-contract variants. Matches Robot Money's fork-e2e environment. |

**If you cite two anchors, cite these:** Humble & Farley's *Continuous Delivery*
("build once, deploy many") and the Twelve-Factor App (config + dev/prod
parity). The 1960s configuration-management lineage is the historical proof that
the idea is older than software itself; everything after is corroboration.

## Checklist before adding any environment-dependent behaviour

1. Is the difference really **data**? → seed it (see `docs/development/environments.md`).
2. Is it really **configuration**? → inject it at deploy/boot; keep one binary.
3. Is it a genuine production safety property? → express it as **registry/config
   state** an operator sets, not a subclass or a compile-time branch.
4. Are you about to write a mock or a `*Test`/`*Hardened` variant of a real
   contract? → stop; use the real contract with seeded state instead.
5. Still need a branch on environment? → it is almost certainly a process
   problem (Conway's Law). Raise it before merging.
