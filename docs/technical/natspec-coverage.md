# NatSpec coverage enforcement

<!-- anchor: tool -->
## Tool

**Custom inline Python parser** (`scripts/natspec/check.sh`).

The checker is a self-contained bash script that embeds a pure-Python static
parser. It requires only `python3` (≥ 3.8), which is available on all
GitHub-hosted runners and most developer machines. No npm, no pip install, no
forge compilation is needed.

The parser inspects `.sol` source text directly and flags any public/external
function, event, custom error, or public state variable that is missing a
`@notice` tag (and, for parameterised items, `@param` / `@return` tags for
each named parameter / return variable). Functions carrying `@inheritdoc` are
fully exempt.

<!-- anchor: threshold -->
## Threshold

**100%** — every public/external function, event, custom error, and public
state variable in each in-scope file must have complete NatSpec.

The threshold is declared once, in `scripts/natspec/check.sh`. It is not
replicated anywhere else. A CI job (`natspec-single-source-guard`) fails the
workflow if the `NATSPEC_SCOPE` variable — which encodes both the scope and the
implicit 100% expectation — appears in any other file.

<!-- anchor: in-scope-set -->
## In-scope file set

The canonical list lives in `NATSPEC_SCOPE` inside `scripts/natspec/check.sh`:

```
contracts/gateway/RobotMoneyGateway.sol
contracts/gateway/AccessRoles.sol
contracts/gateway/MockUSDC.sol
contracts/gateway/MockVault.sol
contracts/gateway/interfaces/IGateway.sol
contracts/RobotMoneyVault.sol
contracts/interfaces/IStrategyAdapter.sol
contracts/adapters/AaveV3Adapter.sol
contracts/adapters/CompoundV3Adapter.sol
contracts/adapters/MorphoAdapter.sol
contracts/script/Deploy.s.sol
```

**Out of scope** (not checked):
- `lib/` — third-party dependencies.
- `contracts/test/` — Forge test helpers.
- Internal and private functions.
- Generated Solidity from build artifacts.

<!-- anchor: local-command -->
## Local reproduction command

Run the same check that CI runs:

```bash
bash scripts/natspec/check.sh
```

To check a single file (e.g. after editing it):

```bash
bash scripts/natspec/check.sh contracts/gateway/RobotMoneyGateway.sol
```

The script prints a per-file report and exits non-zero on any issue. The output
format is identical to what CI prints, so a local pass guarantees a CI pass on
the NatSpec job.

## CI workflow

`.github/workflows/natspec-coverage.yml` defines three jobs:

| Job | What it checks |
|---|---|
| `natspec-coverage-check` | All in-scope files pass 100% NatSpec coverage. |
| `natspec-fixture-test` | Gate exits non-zero when `function noDocs() external {}` is added; exits 0 once full NatSpec is added. |
| `natspec-single-source-guard` | `NATSPEC_SCOPE` appears only in `scripts/natspec/check.sh`. |

The workflow triggers on any PR that touches `contracts/**/*.sol`,
`scripts/natspec/check.sh`, or the workflow file itself.

## NatSpec rules enforced

| Item | Required tags |
|---|---|
| `contract` / `interface` / `library` | `@notice` |
| `public`/`external` function | `@notice`; `@param` per named parameter; `@return` per named return variable |
| `event` | `@notice`; `@param` per parameter |
| custom `error` | `@notice`; `@param` per parameter |
| `public` state variable | `@notice` |
| Function with `@inheritdoc` | Exempt (inherits from interface) |
| `constructor` | Exempt (style-guide recommendation, not enforced) |
| `internal`/`private` | Out of scope (not enforced) |
