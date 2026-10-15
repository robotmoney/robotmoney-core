# Deploy 2 manifests (Base 8453)

Canonical: `docs/development/stage-deployment.md` ("Deploy 2"), QA plan v1 E10.

These files are a verbatim copy of the manifests of devops run 2 on Base 8453 ("Deploy 2": release `release/v0.4.0-base.3-rehearsal`, core `78c50cbd`, a rehearsal-kind deployment). The originals are in run 2's evidence folder on the operator machine, `~/robotmoney-evidence/base-mainnet-r900/manifests/`. Each file here has the same sha256 as its original. Never edit them. A later deployment gets its own folder.

They are committed so that a test which must read Deploy 2 state takes its addresses from a manifest, never from a literal (clean room rule, core 1490):

- `scripts/ops/test-recorder-keeper-fork.sh` and `scripts/ops/integration/RecorderKeeperDeposit.t.sol` read the rmAGENT vault and its price recorder from `agent-token-vault.json` (`vault`, `recorder`). When `recorder.json` is present, the script requires it to name the same recorder. The forge test also requires the vault to price its asset through that recorder.
- `scripts/ci/check-no-production-addresses.ts` lists every Robot Money contract named here. Its self-test requires the list to equal the contracts these files record, so no test or harness file can hard-code one.

The publish tool never reads this folder. A publish run on 8453 writes its own manifests flat into `deployments/8453/` (untracked), and a subfolder is not one of its manifest paths.
