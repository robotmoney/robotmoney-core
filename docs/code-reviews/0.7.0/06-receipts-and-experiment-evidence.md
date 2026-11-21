# Receipts and experiment evidence

## SIM-01 — P2: provenance comparison discards nested flow parameters

The scorer promises consistent parameters across its run manifest. In `contracts/test/prototype/sim/score-sim.ts:162-178`, `canon(o)` calls `JSON.stringify(o, Object.keys(o).sort())` and uses that result to count distinct parameter sets. A JSON replacer array applies recursively: keys absent from the top-level allowlist disappear from nested objects too. Within `flowParams`, only keys also present at the top level survive; in the current defaults this retains `keeperGrace` while discarding fields such as `refBandBps`, `legBandBps` and `minHold`.

The subsequent default comparison at lines 176-183 reads only `runs[0]`. Thus later files can use materially different flow safety parameters without producing either a mixed-parameter error or a default mismatch. Combining scenario outputs from different parameter runs can be reported as one homogeneous default experiment and affect G4/G5/G8/G9 conclusions.

**Executed reproduction:** construct all 16 expected timed-default filenames with expected plan counts, common pin and run label. Keep the first file at the scorer's defaults, but change `sim-SEQ-5M-s2.json`'s nested `flowParams.refBandBps` from 90 to 999. Execute the scorer's unmodified provenance prefix (everything before its Rows section). Result: `accepted:true, partial:false, paramDiff:[], exit=0`; serialized nested flow parameters contain only `keeperGrace`. The reproduction is preserved in [chapter 07](07-reproduction-notes.md).

This runs the actual admission/provenance code, not the full numeric scoring pipeline: the synthetic plan rows are placeholders. It proves that inconsistent files pass that guard. It does **not** prove that published simulation files were mixed or that any published gate score is wrong.

**Remedy:** use the existing recursive canonicalizer `canonDeep` for the cross-file comparison, or compare every file's complete parameter tree to the intended set. Add a negative case changing one nested key only in a non-first file and a control varying key order without changing values.

## Receipt checks and trust boundary

Executed `bun test scripts/prototype/check-receipt-assets.test.ts`: **39 pass, 0 fail, 167 assertions**. Cases include canonical asset order, bucket/asset sums, lending caps, malformed keys and derivation of fixture vectors. This is useful coverage of the checker; it is not a full committee-signature-to-live-Safe execution proof. The on-chain receipt/vector relationship remains the documented off-chain validation boundary from chapter 03.

## Correction to the first report's gate interpretation

Proposal §13 explicitly selects the step 3e fallback design as the scored G4/G5 run. Its current evidence table at lines 1236-1243 records **G4 Pass**, G5 not pass, G8 Fail and G9 Pass. The next G4 row is labelled `G4 (step 3)` and records the earlier failure. The first review incorrectly flattened these into G4 Fail. This correction changes the review's account of the documented result; it does not independently validate the simulation.

The receipt and evidence worker also inspected Twin feeds, markers and the scorer. Full economic models, every fixture, and complete on-chain receipt execution remain outside executed coverage. No additional confirmed defect is reported from those partial traces.
