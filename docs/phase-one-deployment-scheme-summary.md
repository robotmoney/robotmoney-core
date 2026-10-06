# Phase: One deployment scheme

## Resumo da issue
Meta-issue de coordenação para a fase **One deployment scheme** da Base mainnet 0.4.0.
O PR 1505 consolida o conjunto on-pr-1505: floors, config truth, router-first split, three-vault scripts, timelock handover, nightly jobs, Twin fork, CLI in core, rmPROTO.

As lanes contracts, CLI e rehearsal constroem sobre o CLI in core. O gate contracts-freeze 1524 converge por último.

## Escopo paralelo
Parallelizable: yes
Depends on phases: None

## Grupos principais
* **on-pr-1505**: #1483 S1 Floors and escape hatches, #1484 S2 Config and venue truth, #1485 S3 Split core router-first, #1486 S4 Production scripts for three vaults, #1487 S5 Timelock hands over every vault, #1489 Delete test-only code, #1490 rmPROTO ships, #1493 rmUSDC gateway zero router fix, #1495 nightly reruns, #1496 nightly Twin fork, #1497 nightly third-party drift, #1498 Twin chain pinned lazy anvil, #1503 rmUSDC seed shares to SEED_SHARE_RECEIVER, #1504 gates pass, #1516 publish-contracts CLI in core, #1520 govern stage 13 unpauses only, #1523 rehearsal counts artifact
* **contracts-lane**: #1491 rmAGENT, #1518 rename pause to pauseDeposits, #1482 redeem gas floor, #1511 rmpc vote-submit target, #1522 timelock router weight-setter role, #1521 timelock executor/canceller policy
* **cli-lane**: #1527 no-agent deploy, #1525 hardware wallet SafeTx e2e
* **rehearsal**: #1488 stage driver, #1523 rehearsal counts
* **contracts-freeze gate**: #1524

## Dependências críticas
* S1 define inputs/guards compartilhados para S3/S4
* S2 fixa schema de config para S4
* S3 depende de S1 e define manifest keys
* S4 depende de S1,S2,S3
* S5 depende de S1,S4
* 1516 é base para 1520,1527,1488,1523
* 1520 precede 1527
* 1488 depende de 1516 e 1520
* 1524 depende de 1502,1516,1523,1518,1482,1513,1512,1511,1522,1521,1491,1527

## Próximos passos
Cada sub-issue possui superfield com expected_touchpoints, test_surfaces e public_contracts. A implementação deve seguir a ordem de dependências acima, mantendo parallel_safe onde indicado e evitando conflitos nos arquivos compartilhados:
contracts/script/Deploy*.s.sol, contracts/test/DeployTimelock.t.sol, config/*.json, publish-contracts/src/*, .github/workflows/*

Este documento serve como registro de análise da fase. Nenhuma alteração de código é gerada aqui por se tratar de meta-coordenação.
