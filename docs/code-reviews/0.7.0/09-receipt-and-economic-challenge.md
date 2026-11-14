# Receipt and economic-evidence challenge

Source revision: `17677089268affa3a5efa3d9192bb4f63b6bb605`. Third pass.

## SIM-01 disposition: retain P2

The cross-file comparison still uses a replacer array of top-level keys
(`contracts/test/prototype/sim/score-sim.ts:162-178`). That array also filters
nested object properties. The later recursive default comparison reads only
the first file. Current producers writing correct parameters does not detect
an accidentally mixed directory: each file is internally valid, while the
collection is not homogeneous. The existing prefix reproduction establishes
this admission defect. It does not establish that published evidence is mixed.

## SIM-02 — P2: incomplete cost evidence can turn G4 FAIL into PASS

The scorer enforces filenames and plan counts but does not validate required
numeric cost fields before declaring a complete run. Arrival cost is calculated
from `execCost`, `flowLoss`, and `unexplainedDrop`; missing values produce `NaN`
(`score-sim.ts:207-213`). `costBps` then remains `NaN` even if reference cost is
valid (`:242`). `g4of` filters nonfinite results and accepts any nonempty
remaining set (`:298-302`). The lost plan is absent from both the median and
maximum. No provenance problem is recorded, so the result is not PARTIAL.

There is a second form of the same defect. Missing reference-cost inputs are
replaced with `NaN`, and `costBps` substitutes negative infinity for their
contribution (`:211,242`). The headline then uses arrival cost alone, despite
the documented definition requiring the maximum of arrival and reference cost
(`score-sim.ts:13-20`).

**Executed full-program reproduction:** constructed every expected sync-default
filename with the expected plan counts and common valid metadata/defaults.
All 36 scored plans converge; all costs are zero except the first SEQ 1M plan,
whose 1 USDC turnover and 0.1 USDC cost yield 1,000 bps. The two probe plans
are present too. Executed the unmodified scorer for each variant:

| Variant | Exit | PARTIAL | G4 sample count | G4 maximum | Verdict |
| --- | --- | --- | --- | --- | --- |
| Complete high-cost negative control | 0 | false | 36 | 1,000 bps | FAIL |
| Reference-only high-cost negative control | 0 | false | 36 | 1,000 bps | FAIL |
| Delete only that plan's `execCost` | 0 | false | 35 | 0 bps | PASS |
| Keep arrival cost zero; delete that plan's high `execCostRef` | 0 | false | 36 | 0 bps | PASS |

The final variant deletes only the reference-cost field from the reference-only high-cost control. This is a scorer input-validation defect,
not an on-chain exploit or evidence that existing gate results are wrong.
Current writers emit these fields (`TimedFlowSim.t.sol:791,839-840`), so a
normal complete output of those writers is not the trigger. A malformed,
partially transformed, or older evidence file with a complete plan array is.
The scorer already promises to reject incomplete evidence; this omission
allows it to certify a smaller or weaker population as complete.

**Remedy:** validate required costs and denominators before scoring; refuse
missing/nonfinite required values and require the G4 sample count to equal the
intended scored population. If older arrival-only formats are supported, label
them as an incomplete/different measurement rather than the current G4 gate.
For legitimate zero-turnover plans, define and report an explicit exclusion
policy instead of silently applying the generic nonfinite filter.

The reproduction script below writes synthetic inputs only under `$HOME/tmp`.
It runs the whole scorer, including provenance checks and output generation.

```typescript
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
const root='/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-core/review-single-vault-rebalancer';
const source=readFileSync(join(root,'contracts/test/prototype/sim/score-sim.ts'),'utf8');
const params=Function('return ('+source.match(/const DEFAULT_PARAMS: Record<string, unknown> = ([\s\S]*?);/)![1]+')')();
const dir=join(process.env.HOME!,'tmp/review-econ-third/default');mkdirSync(dir,{recursive:true});
const entries:any[]=[];for(let k=0;k<3;k++)for(const [s,m,n] of [['SEQ',1,4],['SEQ',5,4],['EXT',1,2],['JUMP-DOWN',1,1],['JUMP-UP',1,1]] as const)entries.push([s,m,k,n]);entries.push(['EXT-PROBE',5,0,2]);
function write(mode:string){for(const [s,m,k,n] of entries){const plans=Array.from({length:n},(_,i)=>({scenario:s,fundUsdc:m*1e12,seedK:k,receipt:i,outcome:'Converged',convergedInWindow:true,turnoverUsdc:1e6,tradedNotional:1e6,execCost:0,execCostRef:0,flowLoss:0,flowLossRef:0,unexplainedDrop:0,executed:1,calls:1,skipMarketDeviation:0,skipCooldown:0,skipStepFailed:0}));if(s==='SEQ'&&m===1&&k===0){plans[0].execCost=100000;plans[0].execCostRef=100000;if(mode==='reference-control')plans[0].execCost=0;if(mode==='missing-arrival')delete (plans[0] as any).execCost;if(mode==='missing-reference'){plans[0].execCost=0;delete (plans[0] as any).execCostRef;}}writeFileSync(join(dir,`sim-${s}-${m}M-s${k}.json`),JSON.stringify({meta:{run:'default',pinBlock:55462550,recording:false,params},plans}));}}
for(const mode of ['control','reference-control','missing-arrival','missing-reference']){write(mode);const r=Bun.spawnSync(['bun',join(root,'contracts/test/prototype/sim/score-sim.ts'),'--dir',dir],{cwd:root});writeFileSync(join(dir,`output-${mode}.txt`),r.stdout);const result=JSON.parse(readFileSync(join(dir,'sim.json'),'utf8'));console.log(JSON.stringify({mode,exit:r.exitCode,partial:result.partial,scored:result.scored.g4,verdict:result.scored.g4Verdict}));}
```

Save the block as `$HOME/tmp/review-econ-third/probe.ts`, create its parent
folder first, adjust `root` to the checkout, and run it with Bun.

## Receipt/vector binding: no new finding

`RebalanceGovernance.applyReceipt` checks the receipt digest/status/chronology,
then supplies the separately passed vector to the fund. It does not decode the
payload to derive that vector (`RebalanceGovernance.sol:135-160`). The proposal
explicitly assigns semantic binding to off-chain tools (§4.1,
`docs/technical/one-vault-rebalancer-proposal.md:183-203`), so a trusted Safe
choosing a different otherwise-valid vector is not a newly discovered
permissionless authorization bypass.

The fund rehearsal uses its release runbook and payload builder. The builder
checks schema, bucket attribution and per-asset weights, re-derives the vector
from the payload, and compares it to the requested fund-index vector before
returning the payload and digest (`scripts/runbook/fund-receipt-payload.ts:134-150`).
The apply step encodes the saved receipt id/digest/vector and submits a Safe
schedule (`docs/runbooks/contract-qa/releases/v0.7.0-onevault.yaml:1545-1549`).
This still trusts operator state files and Safe approval. The generic
`publish-contracts/src/govern.ts:1795-1810` apply path is the legacy vault/router
path; it must not be cited as an independent fund vector validator.

## Economic-model assumptions and remaining proof limits

The shared market model declares a zero-drift reference walk, one or two
seeded noise swaps per slot, and an arbitrageur with unlimited inventory closing
50–100% of each gap (`SimMarket.sol:36-53`). The timed simulation explicitly
records slot ordering, feed update thresholds and heartbeat, an always-up
sequencer, and a fixed USDC feed (`TimedFlowSim.t.sol:982`). These are disclosed
model assumptions. I did not turn disagreement with those assumptions into
code defects or treat a deterministic simulation as empirical market proof.

The scorer likewise states that outages, depeg, absent keeper and freeze are
not measured (`score-sim.ts`, `timed.values.notMeasured`). Hence G9 Pass is
conditional on the modeled availability and pricing environment. This pass
has not rerun the full Solidity simulation, checked the realism of volatility
calibration against independent observations, or reproduced attacker capital
and arbitrage profit assumptions. Its new executed evidence concerns scorer
failure behavior. The passing receipt tests from the prior pass remain useful
checker coverage but do not execute the entire recorded-receipt-to-Safe path.
