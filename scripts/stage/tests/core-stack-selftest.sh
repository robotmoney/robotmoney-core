#!/usr/bin/env bash
# Offline self-test for scripts/stage/core-stack.sh.
#
# core-stack.sh only wraps boot and health. It deploys and governs by calling
# publish contracts (devops, Bun TypeScript). This test runs the script in a
# scratch git checkout with a fake `bun` standing in for publish contracts and
# checks the contract the script promises: the exact argument list, exit-code
# passthrough, the govern row gate (tx hash and receipt status 1 on every row),
# the usage errors, and the record contract (including the schema drift guard).
# No network, no docker, no chain. Needs git, jq and a real bun (it runs
# scripts/stage/govern-rows.ts for real).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../core-stack.sh"
GOVERN_ROWS="$HERE/../govern-rows.ts"
LABEL_DIFF="$HERE/../label-diff.ts"
SHEET_DIFF="$HERE/../sheet-diff.ts"
CORE_ROOT="$(cd "$HERE/../../.." && pwd)"
SCHEMA="$HERE/../../../schemas/fusion-stage-record.schema.json"
for tool in jq git bun; do
  command -v "$tool" >/dev/null || { echo "selftest needs $tool" >&2; exit 2; }
done
REAL_BUN="$(command -v bun)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The executed-assertion floor: a truncated file must not print a green tally.
# CI holds its own copy (suite-28-core-stack-selftest.yml).
MIN_EXPECTED_ASSERTIONS=60

PASS=0; FAIL=0
ok() { PASS=$((PASS + 1)); echo "ok   - $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL - $1" >&2; }
check() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }
contains() { if [[ "$2" == *"$3"* ]]; then ok "$1"; else bad "$1 (output lacked '$3': $2)"; fi; }

REPO="$WORK/repo"; OUT="$WORK/out"; FAKE="$WORK/fake"
mkdir -p "$REPO/scripts/stage" "$OUT/manifests" "$OUT/keys" "$FAKE" "$WORK/pc/src"
cp "$SCRIPT" "$REPO/scripts/stage/core-stack.sh"
cp "$GOVERN_ROWS" "$REPO/scripts/stage/govern-rows.ts"
cp "$LABEL_DIFF" "$REPO/scripts/stage/label-diff.ts"
cp "$SHEET_DIFF" "$REPO/scripts/stage/sheet-diff.ts"
git -C "$REPO" init -q
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
SHA="$(git -C "$REPO" rev-parse HEAD)"
: >"$WORK/pc/src/cli.ts"
: >"$OUT/sheet.env"; : >"$OUT/pw"; chmod 600 "$OUT/pw"

# A fake bun: publish contracts' cli.ts records argv and prints $FAKE/govern_out
# (exit $FAKE/rc); govern-rows.ts runs for real.
cat >"$WORK/fakebun" <<STUB
#!/usr/bin/env bash
if [[ "\$1" == *govern-rows.ts || "\$1" == *label-diff.ts || "\$1" == *sheet-diff.ts ]]; then exec "$REAL_BUN" "\$@"; fi
echo "\$*" >"$FAKE/argv"
env | grep -E '^(REHEARSAL_KEY_DIR|REHEARSAL_PASSWORD_FILE|PUBLISH_MANIFEST_DIR)=' | sort >"$FAKE/env"
[[ -f "$FAKE/govern_out" ]] && cat "$FAKE/govern_out"
exit "\$(cat "$FAKE/rc" 2>/dev/null || echo 0)"
STUB
chmod +x "$WORK/fakebun"

cat >"$OUT/core-smoke.log" <<EOS
--- endpoint summary ---
chain_id=918453
sheet_path=$OUT/sheet.env
key_dir=$OUT/keys
password_file=$OUT/pw
manifest_dir=$OUT/manifests
core_sha=$SHA
--- end endpoint summary ---
EOS

run() { # run ARGS... ; sets RC and OUTPUT
  RC=0
  OUTPUT="$(cd "$REPO" && BUN="$WORK/fakebun" PUBLISH_CONTRACTS_DIR="$WORK/pc" bash scripts/stage/core-stack.sh "$@" --out-dir "$OUT" 2>&1)" || RC=$?
}
h() { printf '0x%064x' "$1"; }

# ─── usage ────────────────────────────────────────────────────────────────────
run; check "no arguments is a usage error" "$RC" "64"
run chain sideways; check "an unknown chain verb is a usage error" "$RC" "64"
run dapp up; check "dapp up is gone: it deployed the dapp from a record, the harness does that now" "$RC" "64"
run governance bogus; check "an unknown governance verb is a usage error" "$RC" "64"
run governance release; check "governance release needs --receipt-id" "$RC" "64"
run record write --bogus-flag; check "an unknown flag is a usage error" "$RC" "64"

# ─── publish args: the one argument list ─────────────────────────────────────
run publish args
check "publish args exits 0" "$RC" "0"
want=$'publish\n--chain\n918453\n--rpc\nhttp://127.0.0.1:18545\n--sheet\n'"$OUT/sheet.env"$'\n--signer\nkeystore\n--environment\nstage\n--core-sha\n'"$SHA"
check "publish args is the Twin chain argument list, exactly" "$OUTPUT" "$want"

# ─── publish run: calls publish contracts, passes the exit code through ──────
rm -f "$FAKE/govern_out" "$FAKE/rc"
run publish run
check "publish run fails when the four vault manifests are not all there" "$RC" "66"
contains "...and says how many were written" "$OUTPUT" "0 of 4"
echo '{"vault":"0x1"}' >"$OUT/manifests/core.json"
for k in rmPROTO rmAGENT rmRWA; do echo '{"vault":"0x1"}' >"$OUT/manifests/vault-$k.json"; done
run publish run
check "publish run exits 0 when publish contracts does and four manifests exist" "$RC" "0"
contains "publish run calls publish with the chain" "$(cat "$FAKE/argv")" "publish --chain 918453"
contains "publish run passes the signer as keystore" "$(cat "$FAKE/argv")" "--signer keystore"
contains "publish run passes the stage environment" "$(cat "$FAKE/argv")" "--environment stage"
contains "publish run passes the core sha" "$(cat "$FAKE/argv")" "--core-sha $SHA"
contains "publish run hands the keystore directory by path" "$(cat "$FAKE/env")" "REHEARSAL_KEY_DIR=$OUT/keys"
contains "publish run hands the passphrase FILE by path, never the passphrase" "$(cat "$FAKE/env")" "REHEARSAL_PASSWORD_FILE=$OUT/pw"
if grep -qiE -- '--private-key|--password' "$FAKE/argv"; then bad "no secret flag reaches publish contracts"; else ok "no secret flag reaches publish contracts"; fi
echo 7 >"$FAKE/rc"
run publish run; check "a failing publish contracts exit code passes through unchanged" "$RC" "7"
rm -f "$FAKE/rc"

# ─── governance verify / ensure / release ────────────────────────────────────
run governance verify
check "governance verify calls publish contracts verify" "$(cut -d' ' -f2 "$FAKE/argv")" "verify"

printf '{"row":"set-quorum","txHash":"%s","status":1}\n{"row":"set-voting-power","txHash":"%s","status":1}\n' "$(h 1)" "$(h 2)" >"$FAKE/govern_out"
run governance ensure
check "governance ensure passes when every row has a tx hash and status 1" "$RC" "0"
contains "governance ensure calls publish contracts govern" "$(cat "$FAKE/argv")" "govern --chain 918453"

printf '{"row":"set-quorum","txHash":"%s","status":1}\n{"row":"set-voting-power","txHash":"%s","status":0}\n' "$(h 1)" "$(h 2)" >"$FAKE/govern_out"
run governance ensure
check "governance ensure fails when one row has receipt status 0" "$RC" "66"
contains "...and names the row problem" "$OUTPUT" "status"

printf '{"row":"set-quorum","status":1}\n' >"$FAKE/govern_out"
run governance ensure
check "governance ensure fails when a row has no tx hash" "$RC" "66"

printf 'govern finished with no rows\n' >"$FAKE/govern_out"
run governance ensure
check "governance ensure fails when the run printed no rows" "$RC" "66"

printf '{"row":"release-receipt","txHash":"%s","status":1}\n' "$(h 3)" >"$FAKE/govern_out"
run governance release --receipt-id 0xabc
check "governance release passes on a good row" "$RC" "0"
contains "governance release asks for the release-receipt row" "$(cat "$FAKE/argv")" "--row release-receipt --receipt-id 0xabc"

# ─── parity: label-diff and sheet-diff run on real verifier output and sheets ──
printf 'PASS safe.threshold\nPASS vault.rmUSDC.paused\nRESULT: VERIFIED\n' >"$FAKE/govern_out"
printf '{"label":"safe.threshold"}\n{"label":"vault.rmUSDC.paused"}\n' >"$OUT/mainnet-labels.json"
run parity labels --mainnet "$OUT/mainnet-labels.json"
check "parity labels passes when stage and mainnet verifier labels are identical" "$RC" "0"
check "...and saves the verifier output for the record" "$(grep -c 'PASS safe.threshold' "$OUT/verify-labels.txt")" "1"
contains "...and calls the verifier through publish contracts" "$(cat "$FAKE/argv")" "verify --chain 918453"
printf '{"label":"safe.threshold"}\n{"label":"vault.rmUSDC.paused"}\n{"label":"timelock.delay"}\n' >"$OUT/mainnet-labels.json"
run parity labels --mainnet "$OUT/mainnet-labels.json"
check "parity labels exits non-zero when mainnet has a label stage lacks" "$RC" "1"
contains "...and names the label" "$OUTPUT" "only on mainnet: timelock.delay"
run parity labels
check "parity labels without --mainnet is a usage error" "$RC" "64"
echo 7 >"$FAKE/rc"
run parity labels --mainnet "$OUT/mainnet-labels.json"
check "parity labels fails with the verifier's own exit code when the verifier fails" "$RC" "7"
rm -f "$FAKE/rc" "$FAKE/govern_out"

printf 'CHAIN_ID=918453\nTIMELOCK_MIN_DELAY=60\nSAFE_THRESHOLD=2\nSAFE_OWNERS=0xa,0xb,0xc\nUSDC_ADDRESS=0x1\n' >"$OUT/sheet.env"
printf 'CHAIN_ID=8453\nTIMELOCK_MIN_DELAY=172800\nSAFE_THRESHOLD=3\nSAFE_OWNERS=0xd,0xe,0xf\nUSDC_ADDRESS=0x1\n' >"$OUT/prod-sheet.env"
run parity sheet --production "$OUT/prod-sheet.env"
check "parity sheet passes when the sheets differ only in parameter and identity lines" "$RC" "0"
printf 'CHAIN_ID=8453\nTIMELOCK_MIN_DELAY=172800\nSAFE_THRESHOLD=3\nSAFE_OWNERS=0xd,0xe,0xf\nUSDC_ADDRESS=0x2\n' >"$OUT/prod-sheet.env"
run parity sheet --production "$OUT/prod-sheet.env"
check "parity sheet exits non-zero when a non-parameter line differs" "$RC" "1"
contains "...and names the key" "$OUTPUT" "USDC_ADDRESS"
printf 'CHAIN_ID=918453\nREHEARSAL=1\nTIMELOCK_MIN_DELAY=60\nUSDC_ADDRESS=0x1\n' >"$OUT/sheet.env"
printf 'CHAIN_ID=8453\nTIMELOCK_MIN_DELAY=172800\nUSDC_ADDRESS=0x1\n' >"$OUT/prod-sheet.env"
run parity sheet --production "$OUT/prod-sheet.env"
check "parity sheet refuses a sheet with an escape-hatch key" "$RC" "1"
: >"$OUT/sheet.env"

# ─── a redeploy from a new SHA gets a fresh keystore set and a new core sha ──
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m second
SHA2="$(git -C "$REPO" rev-parse HEAD)"
check "the second commit has a new SHA" "$([[ "$SHA2" != "$SHA" ]] && echo yes || echo no)" "yes"
run publish args
contains "publish args after a new commit carries the new core sha" "$OUTPUT" "--core-sha"$'\n'"$SHA2"
check "...and not the old one" "$([[ "$OUTPUT" == *"$SHA"$'\n'* || "$OUTPUT" == *"$SHA" ]] && echo old || echo new)" "new"
# The harness mints the keystore set. One call per boot, in a directory no earlier boot used.
PUB_RS="$CORE_ROOT/testing/smoke-test/src/publish.rs"
LIB_RS="$CORE_ROOT/testing/smoke-test/src/lib.rs"
check "make_keys names its directory with fresh_root_name (never a reused path)" "$(grep -c 'parent.join(fresh_root_name())' "$PUB_RS")" "1"
check "the harness mints keys once per boot (one make_keys call in Fixture::new)" "$(grep -c 'publish::make_keys(' "$LIB_RS")" "1"
if grep -qE 'static .*RehearsalKeys|OnceLock<RehearsalKeys>|lazy_static' "$PUB_RS"; then bad "keys must not be cached across boots"; else ok "no keystore set is cached across boots"; fi
if grep -q 'every_boot_gets_its_own_keystore_directory' "$PUB_RS"; then ok "a unit test asserts every boot gets its own keystore directory"; else bad "the fresh keystore unit test is missing"; fi

# ─── no summary: a clear refusal, not a crash ────────────────────────────────
mv "$OUT/core-smoke.log" "$OUT/core-smoke.log.keep"
run publish run
check "publish run without a harness summary is bad input (65)" "$RC" "65"
mv "$OUT/core-smoke.log.keep" "$OUT/core-smoke.log"

# ─── record: the cross-repo contract and its drift guard ─────────────────────
run record show --list-required-fields
check "record show --list-required-fields exits 0" "$RC" "0"
schema_fields="$(jq -c '.required' "$SCHEMA")"
script_fields="$(printf '%s' "$OUTPUT" | jq -c '.')"
check "the schema's required array equals the script's required fields" "$schema_fields" "$script_fields"

a() { printf '0x%040x' "$1"; }
cat >"$OUT/record.json" <<EOS
{
  "chain_id": 918453, "run_id": "r1", "core_tag": "t", "core_sha": "$SHA",
  "generated_at": "2026-10-02T00:00:00Z", "min_delay": 60, "deployer": "$(a 1)",
  "addresses": {
    "gateway": "$(a 2)", "vault": "$(a 3)", "registry": "$(a 4)", "router": "$(a 5)", "governance": "$(a 6)",
    "consensus_receipt": "$(a 7)", "ic_policy": "$(a 8)", "timelock": "$(a 9)", "safe": "$(a 10)", "emergency": "$(a 11)"
  },
  "code_hashes": { "gateway": "$(h 12)" },
  "vault_addresses": { "rmUSDC": "$(a 3)", "rmPROTO": "$(a 13)", "rmAGENT": "$(a 14)", "rmRWA": "$(a 15)" },
  "ephemeral": {
    "submitter": "$(a 16)", "approver": "$(a 17)", "voters": ["$(a 18)", "$(a 19)"], "emergency": "$(a 11)",
    "keystore_dir": "$OUT/keys",
    "safe_signers": [ {"role":"approver","address":"$(a 17)"}, {"role":"approver-b","address":"$(a 20)"}, {"role":"approver-c","address":"$(a 21)"} ]
  }
}
EOS
run record show --record "$OUT/record.json" --path
check "a complete record passes record show" "$RC" "0"

jq 'del(.addresses.timelock)' "$OUT/record.json" >"$OUT/bad.json"
run record show --record "$OUT/bad.json"
check "a record without the timelock is refused (65)" "$RC" "65"
contains "...with a classed line" "$OUTPUT" "record-field-missing"

jq '.chain_id = 8453' "$OUT/record.json" >"$OUT/bad.json"
run record show --record "$OUT/bad.json"
contains "a record for another chain is refused" "$OUTPUT" "record-wrong-chain"

jq '.addresses.safe = "0x0000000000000000000000000000000000000000"' "$OUT/record.json" >"$OUT/bad.json"
run record show --record "$OUT/bad.json"
contains "a zero Safe address is refused" "$OUTPUT" "record-field-malformed"

jq '.ephemeral.safe_signers |= map(select(.role != "approver-c"))' "$OUT/record.json" >"$OUT/bad.json"
run record show --record "$OUT/bad.json"
check "a Safe roster below three owners is refused" "$RC" "65"

# ─── the script holds no deploy or ceremony logic ────────────────────────────
code="$(grep -v '^[[:space:]]*#' "$SCRIPT")"
for banned in 'forge script' 'cast send' 'fusion-ceremony' 'deploy-core-stack' '--private-key'; do
  if [[ "$code" == *"$banned"* ]]; then bad "core-stack.sh must not contain '$banned'"; else ok "core-stack.sh does not contain '$banned'"; fi
done

echo "core-stack selftest: $PASS passed, $FAIL failed"
echo "CORE_STACK_SELFTESTS_EXECUTED=$PASS"
if (( FAIL > 0 )); then exit 1; fi
if (( PASS < MIN_EXPECTED_ASSERTIONS )); then
  echo "core-stack selftest: only $PASS assertions ran, floor is $MIN_EXPECTED_ASSERTIONS" >&2
  exit 1
fi
