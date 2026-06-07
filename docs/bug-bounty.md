# Robot Money Bug-Bounty Scope

> Canonical disclosure contact: `SECURITY.md`.
> Scope freshness gate: `scripts/check-bounty-scope.sh`.
> Required control: `docs/technical/security-model.md` section 14.

This document defines the public-launch bug-bounty scope for Robot Money. It is
intended to be updated before launch and within 72 hours of any new committed
deployment artifact under `deployments/`.

## 1. Disclosure Intake

Report suspected vulnerabilities privately to `security@robotmoney.net`.

Please include:

- affected component and repository path;
- reproduction steps and expected impact;
- transaction hashes, contract addresses, logs, screenshots, or proof-of-concept
  code when relevant;
- whether the issue affects production, a public testnet, a local devnet, or
  documentation only.

The maintainers aim to acknowledge reports within 72 hours and provide a triage
update within 7 calendar days.

## 2. Deployment Address References

Canonical production deployment addresses must be read from committed manifests
under `deployments/`.

Current status: no production deployment manifest is committed in this
repository. Before public dapp launch, this section must be updated with the
exact manifest path and the in-scope contract addresses for each live network.

When a new file is committed under `deployments/`, `docs/bug-bounty.md` must be
updated within 72 hours. The CI gate in `scripts/check-bounty-scope.sh` enforces
that freshness rule.

## 3. In-Scope Components

The following components are in scope once they are deployed, exposed through the
public dapp, or documented as production launch surfaces:

| Component | Repository paths | Scope notes |
|---|---|---|
| Core vault contracts | `contracts/RobotMoneyVault.sol`, `contracts/vaults/` | Deposits, withdrawals, share accounting, caps, fees, emergency paths, ERC-4626 behavior. |
| Gateway and policy contracts | `contracts/gateway/`, `contracts/gateway/interfaces/` | Agent authorization, withdrawal policies, recipients, idempotency, deadlines, role checks. |
| Router and registry contracts | `contracts/PortfolioRouter.sol`, `contracts/VaultRegistry.sol`, `contracts/RouterGovernance.sol` | Router deposits, weights, eligibility, governance execution, registry status and metadata. |
| Strategy adapters and bytecode guards | `contracts/*Adapter*.sol`, `contracts/script/AdapterBytecodeGuard.sol`, `contracts/script/Deploy*.sol` | Adapter approval, delegatecall restrictions, deploy-time safety checks, direct-deployment assumptions. |
| Rust payment client | `clients/rust-payment-client/` | Transaction construction, chain-id checks, code-hash checks, JSON output contract, signing backends. |
| Explorer indexer/API | `services/explorer-indexer/`, `clients/explorer-api/` | Read-only indexing correctness, chain scoping, migration safety, API authorization assumptions. |
| Dapp security controls | `clients/dapp/` | Security-critical checks such as gateway code-hash verification, transaction preview, config export, CSP-related launch gates. |
| CI and release controls | `.github/workflows/`, `.github/scripts/`, `scripts/` | Checks that block unsafe deploys, stale generated docs, stale bounty scope, release provenance, and documented launch gates. |

## 4. Out of Scope

The following are excluded unless a maintainer explicitly expands the scope:

- third-party protocol issues in Aave, Compound, Morpho, Uniswap, Circle USDC,
  Base, Safe, or wallet providers;
- volumetric denial-of-service, spam, or resource exhaustion that does not show a
  protocol-specific vulnerability;
- social engineering, phishing, physical attacks, or attacks requiring access to
  maintainer devices or private accounts;
- vulnerabilities that require researchers to access, move, or lock funds that
  do not belong to them;
- local-only devnet fixtures and test-only mocks unless they can be promoted to
  production behavior;
- findings already documented in `docs/technical/security-model.md`,
  `docs/technical/security-hardening-seams.md`, or `docs/audits.md` without new
  exploit evidence;
- missing reward amounts, generic best-practice requests, or reports that only
  restate an existing documented requirement.

## 5. Severity Guidance

| Severity | Examples |
|---|---|
| Critical | Direct loss or theft of user funds, unauthorized admin execution, bypass of timelock or role controls, exploitable share-accounting inflation. |
| High | Unauthorized agent withdrawal, bypass of configured caps or recipients, stale deployment scope allowing a new high-risk contract to be excluded from review, production dapp check bypass before signing. |
| Medium | Incorrect protocol reads that can mislead operators, incomplete deployment verification, CI gaps that allow a documented launch gate to be skipped. |
| Low | Documentation ambiguity, non-exploitable UI confusion, defensive hardening without a demonstrated exploit path. |

## 6. Research Rules

Researchers must:

- stay within the published scope;
- avoid disrupting production or shared test infrastructure;
- avoid privacy violations and data exfiltration;
- use their own funds and accounts for testing;
- stop and report immediately if they encounter live credentials, private data,
  or a path to move third-party funds.

## 7. Reward Notes

Reward amounts and payout mechanics are intentionally controlled by the
maintainers or the external bounty platform selected before public launch. This
document defines scope, intake, exclusions, and freshness requirements; it does
not guarantee payment for any specific report.
