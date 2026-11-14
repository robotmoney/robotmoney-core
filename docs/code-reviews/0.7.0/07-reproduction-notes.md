# Reproduction notes

These are review probes, not committed product tests. All generated files were under `$HOME/tmp`. Source revision is `176770892`. Run from the review checkout with its `publish-contracts` dependencies installed. The verifier probe below contains this session's absolute checkout path: replace that prefix with your checkout before rerunning. Its dummy runtime artifacts are intentionally synthetic, and do not execute in an EVM.

## Fund verifier probe

Save as `$HOME/tmp/fund-review-deploy/probe.ts` and execute with Bun. It writes synthetic manifests/artifacts beside itself and invokes the real verifier. Baseline, fee, library and extra-role modes each returned ok=true and 114 checks; bad-tvl returned ok=false. No library code was read.

```typescript
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {verifyFundSystem,FUND_ROLES,FLOW_PARAM_FIELDS} from '/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-core/review-single-vault-rebalancer/publish-contracts/src/verify/fund.ts';
import {loadStageTable,scopeTable,manifestBase} from '/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-core/review-single-vault-rebalancer/publish-contracts/src/stage-table.ts';
import {keccak256,toHex} from '/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-core/review-single-vault-rebalancer/publish-contracts/node_modules/viem';
const root='/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-core/review-single-vault-rebalancer';
const scratch=import.meta.dir; const manifests=join(scratch,'manifests'), out=join(scratch,'out'); mkdirSync(manifests,{recursive:true});mkdirSync(out,{recursive:true});
const a=(n:number)=>'0x'+n.toString(16).padStart(40,'0'); const A={fund:a(1),rebalancer:a(2),governance:a(3),queue:a(4),receipt:a(5),timelock:a(6),safe:a(7),deployer:a(8),keeper:a(9),emergency:a(10),fee:a(11),other:a(12),lib:a(13)};
const table=loadStageTable(root), scoped=scopeTable(table,'fund');
const data:any={chain_id:8453,...A,consensus_receipt:A.receipt,upgrade_timelock:A.timelock,upgrade_mode:'upgradeable',seed_shares:1};
for(const name of [...new Set(scoped.stages.map(s=>manifestBase(s.manifest))),'safe'])writeFileSync(join(manifests,name+'.json'),JSON.stringify(data));
const code='0x60'+A.lib.slice(2)+'00';
for(const s of scoped.stages)for(const p of s.proxies??[]){const dir=join(out,p.contract+'.sol');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,p.contract+'.json'),JSON.stringify({deployedBytecode:{object:code,linkReferences:{'FakeLibrary.sol':{FakeLibrary:[{start:1,length:20}]}}}}));}
const admin=keccak256(toHex('ADMIN_ROLE')),zero='0x'+'0'.repeat(64); const grants=new Set<string>(); const grant=(at:string,r:string,w:string)=>grants.add([at,r,w].join(':').toLowerCase());
for(const at of [A.fund,A.rebalancer,A.governance,A.queue,A.receipt])grant(at,admin,A.timelock);
grant(A.receipt,zero,A.timelock);grant(A.receipt,FUND_ROLES.RELEASER,A.governance);grant(A.governance,FUND_ROLES.TARGET_SETTER,A.timelock);
for(const at of[A.fund,A.queue])grant(at,FUND_ROLES.EMERGENCY,A.emergency);
for(const at of[A.queue,A.rebalancer])grant(at,FUND_ROLES.KEEPER,A.keeper);
for(const [r,w]of[[FUND_ROLES.GOVERNANCE,A.governance],[FUND_ROLES.REBALANCER,A.rebalancer],[FUND_ROLES.FLOW,A.queue]])grant(A.fund,r,w);
for(const r of[FUND_ROLES.PROPOSER,FUND_ROLES.CANCELLER])grant(A.timelock,r,A.safe);grant(A.timelock,FUND_ROLES.EXECUTOR,a(0));
const params=Object.fromEntries(FLOW_PARAM_FIELDS.map(([_,n])=>[n,1n]));params.REBALANCER_STEP_DEPTH_BPS=1n;params.FLOW_BASKET_CALL_BPS=1n;
let mode='baseline';let reads:string[]=[];let codeReads:string[]=[];
const chain:any={chainId:async()=>8453,nonce:async()=>1,getStorageAt:async()=>zero,getCode:async(at:string)=>{codeReads.push(at);return at===A.lib?(mode==='library'?'0xdead':'0x6000'):code;},read:async(at:string,sig:string,args:any[]=[])=>{
reads.push(sig);
if(sig.includes('hasRole'))return grants.has([at,args[0],args[1]].join(':').toLowerCase())||(mode==='extra-role'&&at===A.timelock&&args[0]===FUND_ROLES.PROPOSER&&args[1]===A.other);
if(sig.includes('upgradeTimelock'))return A.timelock;if(sig.includes('upgradesFrozen'))return false;if(sig.includes('getMinDelay'))return 900n;if(sig.includes('getThreshold'))return 2n;if(sig.includes('getOwners'))return[A.fee,A.other,A.emergency];
if(sig.includes('flowQueue'))return A.queue;if(sig.includes('fund()'))return A.fund;if(sig.includes('receipts()'))return A.receipt;if(sig.includes('assetCount'))return 5n;
if(sig.includes('config()'))return[mode==='bad-tvl'?99n:1n,1n,1n,mode==='fee'?A.other:A.fee];
if(sig.includes('balanceOf'))return args[0]===A.fund?1n:0n;
if(sig.includes('flowParams'))return Object.fromEntries(FLOW_PARAM_FIELDS.map(([n])=>[n,1n]));if(sig.includes('flowLevers'))return{basketCallBps:1};
if(['minSeedUsdc','maxSlippageBps','navDeviationGuardBps','stepDepthBps'].some(n=>sig.includes(n)))return 1n;
throw Error('unexpected read '+sig);
}};
const opts:any={chain,table,manifestDir:manifests,artifactsDir:out,coreDir:root,usdcCodeHash:keccak256(code as any),frozenCounts:Object.fromEntries(scoped.stages.map(s=>[s.name,0])),sheet:{chainId:8453,deployer:A.deployer,emergency:A.emergency,timelockDelay:900,safeThreshold:2,safeOwners:[A.fee,A.other,A.emergency],upgradeMode:'upgradeable',fund:{keeper:A.keeper,tvlCap:1n,perDepositCap:1n,exitFeeBps:1n,minSeedUsdc:1n,maxSlippageBps:1n,navDeviationBps:1n,params}}};
for(mode of['baseline','fee','library','extra-role','bad-tvl']){reads=[];codeReads=[];const r=await verifyFundSystem(opts);console.log(JSON.stringify({mode,ok:r.ok,checks:r.checks.length,libraryRead:codeReads.includes(A.lib),failures:r.checks.filter(c=>!c.ok)}));}
```

## Scorer provenance probe

Save as `$HOME/tmp/review-scorer-provenance/repro.ts`, create its parent directory first, and run with Bun from the checkout root. It extracts the real scorer prefix before the Rows section and creates 16 synthetic input files. It does not execute the numeric gate scorer.

```typescript
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
const root=process.cwd();
const src=readFileSync(root+'/contracts/test/prototype/sim/score-sim.ts','utf8');
const prefix=src.slice(0,src.indexOf('// ─── Rows'));
const params=Function('return ('+src.match(/const DEFAULT_PARAMS_TIMED: Record<string, unknown> = ([\s\S]*?);\nconst canonDeep/)![1]+')')();
const dir=process.env.HOME+'/tmp/review-scorer-provenance/default-timed';mkdirSync(dir,{recursive:true});
const names:Record<string,number>={};for(let k=0;k<3;k++){names[`sim-SEQ-1M-s${k}.json`]=4;names[`sim-SEQ-5M-s${k}.json`]=4;names[`sim-EXT-1M-s${k}.json`]=2;names[`sim-JUMP-DOWN-1M-s${k}.json`]=1;names[`sim-JUMP-UP-1M-s${k}.json`]=1;}names['sim-EXT-PROBE-5M-s0.json']=2;
for(const [file,n] of Object.entries(names)){const p=structuredClone(params); if(file==='sim-SEQ-5M-s2.json')p.flowParams.refBandBps=999;writeFileSync(dir+'/'+file,JSON.stringify({meta:{flows:'timed',run:'default',pinBlock:55462550,recording:false,params:p},plans:Array(n).fill({})}));}
const path=process.env.HOME+'/tmp/review-scorer-provenance/provenance.ts';writeFileSync(path,prefix+'\nconsole.log(JSON.stringify({accepted:true,partial,paramSets:[...paramSets],paramDiff}));\n');
const run=Bun.spawnSync([process.execPath,path,'--dir',dir]);console.log(run.stdout.toString());console.error(run.stderr.toString());console.log('exit='+run.exitCode);
```

## RUN-01 arithmetic

```typescript
const reference = 1_000_000n, bps = 10_000n, fee = 100n, band = 100n;
const required = (reference * bps + (bps - fee) - 1n) / (bps - fee);
const allowed = reference * (bps + band) / bps;
console.log({ required: String(required), allowed: String(allowed), canExecute: required <= allowed });
// required1010102; allowed1010000; canExecute false.
```

This isolates fee/bound arithmetic. It does not deploy a pool or execute asset admission or settlement.
