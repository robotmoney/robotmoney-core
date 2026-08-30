#!/usr/bin/env python3
"""Validate Project Fusion's pinned consensus-receipt design (issue #1244).

WHAT THIS GUARDS, AND WHY EACH PART IS HERE

1. Schema and semantics — the valid fixtures pass, the invalid one is refused.

2. The canonical bytes — the reference canonicalizer reproduces the committed
   golden exactly. The canonicalizer is DRIVEN OFF the spec file
   (`consensus-receipt.canonicalization.json`), not off a hard-coded field list.
   That matters because the spec file is what the other repo implements from: a
   canonicalizer that hard-codes its own order agrees with the golden no matter
   what `field_order` says, so scrambling `field_order` to nonsense would ship
   green while every reader of the spec built something else. Driving off the
   spec removes that whole class — and the spec's order is additionally
   cross-checked against the schema, so drift is caught from both directions.

3. The analyst Ed25519 signatures — actually VERIFIED, not merely shape-checked.
   These fixtures exist to be byte-exact; a family whose whole purpose is
   byte-exactness must not tolerate a signature that stopped verifying because
   one character of a `body` was edited. Format checks alone leave that green.

4. The keccak256 of the golden bytes — the digest an on-chain anchor commits to.
   Read from the file and hashed, then compared against the committed constant
   in `consensus-receipt.anchor-digest.json`, so changing either side turns red
   (robotmoney-core#1280).

5. Cross-repo byte identity — every shared fixture in this directory must stay
   byte-identical to `contract/src/__fixtures__/` in robotmoney-frontend. CI
   here cannot reach that repo, so what is enforced is the manifest: the shared
   set is enumerated, and a core-only file may not be smuggled into it.

Run with --self-test to prove the guards fire before trusting a green run.
"""
from __future__ import annotations

import base64
import copy
import hashlib
import json
import re
import sys
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = REPO_ROOT / "tests" / "fixtures"
PRD_PATH = REPO_ROOT / "docs" / "prd.md"
PROPOSAL_PATH = REPO_ROOT / "docs" / "product" / "20260623-product-proposal-investment-committee-v0.md"
SCHEMA_PATH = FIXTURES / "consensus-receipt.schema.json"
CANONICALIZATION_PATH = FIXTURES / "consensus-receipt.canonicalization.json"
MAP_PATH = FIXTURES / "consensus-receipt.bucket-vault-map.json"
VALID_PATH = FIXTURES / "consensus-receipt.valid.json"
VALID_NO_WEIGHTS_PATH = FIXTURES / "consensus-receipt.valid-no-weights.json"
INVALID_PATH = FIXTURES / "consensus-receipt.invalid.json"
ESCAPING_PATH = FIXTURES / "consensus-receipt.escaping.json"
CANONICAL_PATH = FIXTURES / "consensus-receipt.valid.canonical.txt"
ESCAPING_CANONICAL_PATH = FIXTURES / "consensus-receipt.escaping.canonical.txt"
ANCHOR_DIGEST_PATH = FIXTURES / "consensus-receipt.anchor-digest.json"
LEGACY_PATH = FIXTURES / "consensus-receipt.legacy-weights.json"

# THE CROSS-REPO PIN (issue #1244 AC5). Each of these is byte-identical to the
# file of the same name under contract/src/__fixtures__/ in robotmoney-frontend.
# "Committed as a shared fixture in BOTH repos" is discharged by that byte
# identity and by nothing weaker; a divergence here is a divergence in what the
# two repos will anchor. consensus-receipt.anchor-digest.json is deliberately
# NOT in this set — see that file's own header.
SHARED_WITH_FRONTEND = [
    "consensus-receipt.schema.json",
    "consensus-receipt.canonicalization.json",
    "consensus-receipt.bucket-vault-map.json",
    "consensus-receipt.valid.json",
    "consensus-receipt.valid-no-weights.json",
    "consensus-receipt.invalid.json",
    "consensus-receipt.escaping.json",
    "consensus-receipt.valid.canonical.txt",
    "consensus-receipt.escaping.canonical.txt",
]
CORE_ONLY = [
    "consensus-receipt.anchor-digest.json",
    "consensus-receipt.legacy-weights.json",
]

EXPECTED_BUCKETS = [
    "agent_tokens",
    "conservative_defi_yield",
    "protocol_tokens",
    "real_world_assets",
]
# The vault symbols are NOT hard-coded here on purpose: docs/prd.md §11 is the
# canonical vault catalog, so the bucket map is asserted against whatever that
# section actually names — no extras, none missing (issue #1244 test plan).
VAULT_CATALOG_HEADING = "## 11. Vault Catalog"
RECEIPT_TOKEN_ROW = re.compile(r"^\|\s*Receipt token\s*\|\s*(\S+)\s*\|\s*$")
SUBMISSION_FIELDS = [
    "memberId",
    "date",
    "subjectId",
    "nonce",
    "stance",
    "confidence",
    "body",
    "memoUrl",
]


class CanonicalizationError(Exception):
    """The canonicalizer refuses rather than emitting bytes it cannot stand behind."""


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} must contain a JSON object")
    return value


def prd_vault_symbols() -> list[str]:
    """Receipt-token symbols named by docs/prd.md §11, in catalog order."""
    lines = PRD_PATH.read_text(encoding="utf-8").splitlines()
    try:
        start = lines.index(VAULT_CATALOG_HEADING) + 1
    except ValueError as exc:  # pragma: no cover - guarded by CI
        raise ValueError(f"{PRD_PATH.name} has no '{VAULT_CATALOG_HEADING}' heading") from exc
    symbols: list[str] = []
    for line in lines[start:]:
        if line.startswith("## "):
            break
        match = RECEIPT_TOKEN_ROW.match(line)
        if match:
            symbols.append(match.group(1))
    if not symbols:
        raise ValueError(f"{PRD_PATH.name} §11 names no receipt tokens")
    return symbols


def compact_json(value: Any) -> str:
    """RFC 8259 compact JSON under the spec's string_escaping rule.

    `ensure_ascii=False` is load-bearing, not a style choice. The spec escapes
    EXACTLY quote, backslash and C0 — every other code point rides as raw UTF-8,
    including U+2028 and astral-plane characters. Python's default
    (`ensure_ascii=True`) escapes every non-ASCII code point and would still
    reproduce an all-ASCII golden byte-for-byte, which is precisely why
    consensus-receipt.escaping.json exists and is checked below.
    """
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    )


def field_order_for(path: str, spec: dict[str, Any]) -> list[str] | None:
    """The pinned key order for the object at `path`, straight from the spec."""
    if path == "":
        order = spec.get("field_order")
    else:
        order = spec.get("nested_field_order", {}).get(path)
    if order is None:
        return None
    if not isinstance(order, list) or not all(isinstance(key, str) for key in order):
        raise CanonicalizationError(f"spec order for '{path or '<root>'}' is not a list of field names")
    return order


def order_value(value: Any, path: str, spec: dict[str, Any], optional: set[str]) -> Any:
    """Rebuild `value` with every object key in the order the SPEC pins.

    Refuses rather than emits (the spec's assembler_obligations.order rule):
    a missing non-optional field, an unpinned object, or a non-integer number
    raises instead of silently producing bytes that omit or reformat it.
    """
    if isinstance(value, list):
        return [order_value(item, path + "[]", spec, optional) for item in value]
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        raise CanonicalizationError(f"'{path}' is a non-integer number; canonical bytes admit integers only")
    if not isinstance(value, dict):
        return value

    order = field_order_for(path, spec)
    if order is None:
        # An object whose key order the spec does not pin would serialize in
        # whatever order this parser happened to produce. That is a spec gap,
        # not a fixture problem, and it must not reach the digest.
        raise CanonicalizationError(f"no pinned field order for object at '{path or '<root>'}'")

    ordered: dict[str, Any] = {}
    for key in order:
        child = path + "." + key if path else key
        if key not in value or value[key] is None:
            if child in optional or key in optional:
                continue
            raise CanonicalizationError(f"required field '{child}' is absent from the receipt")
        ordered[key] = order_value(value[key], child, spec, optional)
    return ordered


def canonicalize_receipt(receipt: dict[str, Any], spec: dict[str, Any]) -> str:
    """Reference implementation, driven entirely by the language-neutral spec.

    Nothing about the receipt's shape is written down here — the field order at
    every nesting level, the domain separator and the trailing newline all come
    out of consensus-receipt.canonicalization.json. That is the point: the other
    repo implements from that file, so this implementation has to be a reader of
    it rather than a second, independently-drifting authority.
    """
    optional = set(spec.get("optional_append_only_fields", []))
    ordered = order_value(receipt, "", spec, optional)
    separator = spec["domain_separator"]
    return separator + compact_json(ordered) + ("\n" if spec.get("trailing_newline") else "")


def spec_schema_agreement(schema: dict[str, Any], spec: dict[str, Any]) -> list[str]:
    """The spec's pinned order must name exactly the schema's fields.

    Without this, `field_order` could be scrambled or could name a field the
    schema does not define, and only the canonical-bytes comparison would object
    — which it does only because the canonicalizer now reads the spec. Checking
    both directions means neither file can move without the other.
    """
    errors: list[str] = []
    definitions = schema.get("definitions", {})

    def properties_at(node: dict[str, Any]) -> dict[str, Any]:
        if "$ref" in node:
            name = node["$ref"].rsplit("/", 1)[-1]
            node = definitions.get(name, {})
        while node.get("type") == "array":
            node = node.get("items", {})
            if "$ref" in node:
                node = definitions.get(node["$ref"].rsplit("/", 1)[-1], {})
        return node.get("properties", {})

    def resolve(path: str) -> dict[str, Any]:
        node: dict[str, Any] = schema
        for part in path.replace("[]", "").split("."):
            if not part:
                continue
            node = properties_at(node)[part]
        return node

    checks = [("", spec.get("field_order", []))]
    checks += list(spec.get("nested_field_order", {}).items())
    for path, order in checks:
        try:
            props = properties_at(resolve(path)) if path else schema.get("properties", {})
        except (KeyError, TypeError):
            errors.append(f"spec pins an order for '{path}', which the schema does not define")
            continue
        if list(order) != list(props):
            errors.append(
                f"spec order for '{path or '<root>'}' is {list(order)}; "
                f"the schema defines {list(props)} — the two must name the same fields in the same order"
            )
    return errors


def signature_errors(receipt: dict[str, Any], label: str) -> list[str]:
    """VERIFY the analyst Ed25519 signatures, not merely their shape.

    Every signature is over the exact `canonical_submission` UTF-8 bytes carried
    beside it. Editing one character of a take body therefore breaks the
    signature, and this is what notices. Note what this does NOT do: it does not
    verify anything over the receipt's own canonical bytes, because no analyst
    signs the receipt. The receipt is assembled from already-signed submissions,
    which is why reconciling the judge block below could change the golden bytes
    without invalidating a single signature here.
    """
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    errors: list[str] = []
    for index, item in enumerate(receipt.get("analyst_signatures", [])):
        where = f"{label} analyst_signatures[{index}] ({item.get('member_id')})"
        try:
            public_key = base64.b64decode(item["public_key"], validate=True)
            signature = base64.b64decode(item["signature"], validate=True)
        except Exception as exc:  # noqa: BLE001 - reported, not raised
            errors.append(f"{where}: key or signature is not valid base64: {exc}")
            continue
        if len(public_key) != 32:
            errors.append(f"{where}: public key is {len(public_key)} bytes, not 32")
            continue
        if len(signature) != 64:
            errors.append(f"{where}: signature is {len(signature)} bytes, not 64")
            continue
        try:
            Ed25519PublicKey.from_public_bytes(public_key).verify(
                signature, item["canonical_submission"].encode("utf-8")
            )
        except InvalidSignature:
            errors.append(
                f"{where}: Ed25519 signature does NOT verify over canonical_submission "
                "— the fixture's payload was edited without re-signing"
            )
    return errors


def judge_errors(receipt: dict[str, Any]) -> list[str]:
    """The judge block's recomputable invariants.

    `release_safety` carries the shipped JudgeReleaseSafety whole rather than a
    {safe_to_release, opinion} reduction, and this is the reason: with
    take_count and min_takes present, a verifier RECOMPUTES thin support instead
    of trusting a boolean. A flag that can be checked and is not is a flag that
    can be wrong. `release` is likewise derived — releaseSafety() in
    backend/src/swarm/judge.ts sets "hold" on thin support OR any concern — and
    because a model may ADD concerns drawn from member-authored take bodies
    (robotmoney-frontend#767), a receipt whose `release` does not follow from its
    own concerns list is a receipt whose safety verdict was not the judge's.
    """
    errors: list[str] = []
    safety = receipt["judge"]["release_safety"]
    thin = safety["take_count"] < safety["min_takes"]
    if safety["thinly_supported"] != thin:
        errors.append(
            "judge.release_safety.thinly_supported must equal (take_count < min_takes); "
            f"got {safety['thinly_supported']} for {safety['take_count']} < {safety['min_takes']}"
        )
    expected_release = "hold" if thin or safety["concerns"] else "safe"
    if safety["release"] != expected_release:
        errors.append(
            f"judge.release_safety.release must be {expected_release!r} "
            "— \"hold\" iff thinly supported or any concern is present"
        )
    if safety["take_count"] != receipt["quorum"]["submitted"]:
        errors.append(
            "judge.release_safety.take_count must equal quorum.submitted "
            "— both count the frozen latest-revision-per-member take set"
        )
    return errors


# ── the float → bps conversion (issue #1246) ──────────────────────────────────
#
# THE FORMAT GAP THIS CLOSES. robotmoney-frontend expresses an allocation as
# [0,1] floats over the four named buckets; this repo expresses it as
# `target_weight_bps` 0..BPS_DENOMINATOR over four vault addresses, and
# RouterGovernance.propose HARD-REJECTS any vector that does not sum to
# BPS_DENOMINATOR exactly. A conversion that is merely "close" is a proposal
# that reverts, so the rounding rule has to be pinned rather than left to
# whichever side rounds first.
#
# The rule is DATA, not code: `bps_conversion` in
# consensus-receipt.canonicalization.json states it, `canonical_bucket_order`
# supplies the iteration order, and the schema supplies BPS_DENOMINATOR. Nothing
# below re-states any of the three, for the same reason the canonicalizer is
# spec-driven — the other repo implements from those files, so this has to be a
# reader of them rather than a second authority that can drift.


def bps_denominator(schema: dict[str, Any]) -> int:
    """BPS_DENOMINATOR, read from the schema rather than typed in here."""
    try:
        maximum = schema["definitions"]["bucket_weight"]["properties"]["weight_bps"]["maximum"]
    except (KeyError, TypeError) as exc:
        raise CanonicalizationError("schema does not pin bucket_weight.weight_bps.maximum") from exc
    if not isinstance(maximum, int) or isinstance(maximum, bool) or maximum <= 0:
        raise CanonicalizationError(f"bucket_weight.weight_bps.maximum is {maximum!r}, not a positive integer")
    return maximum


def _decimal(value: Any, where: str) -> Decimal:
    """A weight as an EXACT decimal.

    `Decimal(str(x))` and not `Decimal(x)`: the archived payloads and the signed
    submissions are JSON text, so 0.05 means the two-place decimal a human wrote,
    not the binary double 0.05000000000000000277... that `Decimal(float)` would
    faithfully reproduce. Converting through the text keeps a rounding boundary
    where the spec puts it.
    """
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise CanonicalizationError(f"{where} is {value!r}, not a number")
    return Decimal(str(value))


def normalize_weights(raw: dict[str, Any]) -> dict[str, Decimal]:
    """Scale a raw [0,1] vector so it sums to exactly 1.

    Separate from the conversion below ON PURPOSE. `bps_conversion.input` says
    the converter's input is the mean of vectors that are ALREADY normalized, so
    normalizing inside the converter would be inventing a rule the other repo
    does not implement. This is the caller-side step, used for legacy archived
    maps and for generated test vectors — never silently applied to a mean that
    is supposed to already sum to 1.
    """
    values = {bucket: _decimal(value, f"weight for {bucket!r}") for bucket, value in raw.items()}
    for bucket, value in values.items():
        if value < 0:
            raise CanonicalizationError(f"weight for {bucket!r} is negative ({value})")
    total = sum(values.values(), Decimal(0))
    if total <= 0:
        raise CanonicalizationError("weight vector totals zero; there is no allocation to convert")
    return {bucket: value / total for bucket, value in values.items()}


def mean_weights_to_bps(
    mean_by_bucket: dict[str, Any], spec: dict[str, Any], denominator: int
) -> list[dict[str, Any]]:
    """`bps_conversion`, applied. Settle-the-last-entry, half-up on the prefix.

    Returns the receipt's `weights` array: exactly the spec's
    canonical_bucket_order, each entry `{bucket, weight_bps}`, summing to
    `denominator` EXACTLY or raising rather than returning a vector that
    RouterGovernance.propose would revert on.

    The `final_rule` range check is a REAL branch, not defensive decoration.
    Each prefix bucket rounds half-up independently, so a vector whose last
    bucket is ~0 and whose prefix fractions sit on .5 boundaries can overshoot
    the denominator by up to (len(prefix) / 2) bps and drive the settled last
    entry negative. That vector has no representation under this rule and is
    REFUSED; test_consensus_receipt_bps.py constructs one so the branch executes.
    """
    order = spec.get("canonical_bucket_order")
    if not isinstance(order, list) or len(order) < 2 or not all(isinstance(b, str) for b in order):
        raise CanonicalizationError("spec canonical_bucket_order is not a list of at least two bucket names")

    missing = [bucket for bucket in order if bucket not in mean_by_bucket]
    if missing:
        raise CanonicalizationError(f"mean vector omits canonical bucket(s): {', '.join(missing)}")
    unknown = [bucket for bucket in mean_by_bucket if bucket not in order]
    if unknown:
        raise CanonicalizationError(f"mean vector names non-canonical bucket(s): {', '.join(unknown)}")

    mean = {bucket: _decimal(mean_by_bucket[bucket], f"mean weight for {bucket!r}") for bucket in order}
    for bucket, value in mean.items():
        if value < 0:
            raise CanonicalizationError(f"mean weight for {bucket!r} is negative ({value})")
    total = sum(mean.values(), Decimal(0))
    # The caller normalizes (normalize_weights); this only refuses an input that
    # never was a distribution. The tolerance absorbs Decimal division residue
    # (~1e-27 for a 1/3 split), not a genuinely unnormalized vector.
    if abs(total - 1) > Decimal("1e-9"):
        raise CanonicalizationError(f"mean vector sums to {total}, not 1 — normalize before converting")

    scale = Decimal(denominator)
    prefix = [
        int((mean[bucket] * scale).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
        for bucket in order[:-1]
    ]
    final = denominator - sum(prefix)
    if not 0 <= final <= denominator:
        raise CanonicalizationError(
            f"settled last bucket {order[-1]!r} is {final} bps, outside 0..{denominator} "
            "— this vector has no representation under bps_conversion.final_rule"
        )
    return [
        {"bucket": bucket, "weight_bps": value}
        for bucket, value in zip(order, prefix + [final])
    ]


def float_vector_to_bps(
    raw: dict[str, Any], spec: dict[str, Any], denominator: int
) -> list[dict[str, Any]]:
    """The whole float [0,1] → bps path: normalize, then convert."""
    return mean_weights_to_bps(normalize_weights(raw), spec, denominator)


def semantic_errors(receipt: dict[str, Any], spec: dict[str, Any], denominator: int) -> list[str]:
    errors: list[str] = []
    quorum = receipt["quorum"]
    if quorum["active"] != quorum["submitted"] + quorum["absent"]:
        errors.append("quorum.active must equal submitted + absent")
    expected_participation = (
        2 * quorum["submitted"] * 10_000 + quorum["active"]
    ) // (2 * quorum["active"])
    if quorum["participation_bps"] != expected_participation:
        errors.append("quorum.participation_bps must be nearest-integer submitted/active bps")
    if sum(receipt["stances"].values()) != quorum["submitted"]:
        errors.append("stance counts must sum to quorum.submitted")

    errors.extend(judge_errors(receipt))

    signatures = receipt["analyst_signatures"]
    member_ids = [item["member_id"] for item in signatures]
    weighted_submissions: list[dict[str, Any]] = []
    if len(signatures) != quorum["submitted"]:
        errors.append("analyst_signatures length must equal quorum.submitted")
    if len(member_ids) != len(set(member_ids)):
        errors.append("analyst_signatures member_id values must be unique")
    if member_ids != sorted(member_ids, key=lambda value: value.encode("utf-8")):
        errors.append("analyst_signatures must be ordered by member_id UTF-8 bytes")
    for index, item in enumerate(signatures):
        try:
            submission = json.loads(item["canonical_submission"])
        except json.JSONDecodeError as exc:
            errors.append(f"analyst_signatures[{index}] canonical_submission is not JSON: {exc}")
            continue
        expected_fields = SUBMISSION_FIELDS + (["weights"] if "weights" in submission else [])
        if list(submission) != expected_fields:
            errors.append(
                f"analyst_signatures[{index}] does not follow canonicalizeSubmission field order"
            )
        if compact_json(submission) != item["canonical_submission"]:
            errors.append(f"analyst_signatures[{index}] is not compact canonical JSON")
        if submission.get("memberId") != item["member_id"]:
            errors.append(f"analyst_signatures[{index}] member identity does not match payload")
        if submission.get("subjectId") != receipt["subject_id"]:
            errors.append(f"analyst_signatures[{index}] subject does not match receipt")
        if "weights" in submission:
            weighted_submissions.append(
                json.loads(item["canonical_submission"], parse_float=Decimal)
            )
            for weight_index, weight in enumerate(submission["weights"]):
                if list(weight) != ["bucket", "weight"]:
                    errors.append(
                        f"analyst_signatures[{index}].weights[{weight_index}] field order is not canonical"
                    )

    weights = receipt.get("weights")
    if weights is not None:
        buckets = [item["bucket"] for item in weights]
        if buckets != EXPECTED_BUCKETS:
            errors.append("weights must use canonical bucket order and cover exactly four buckets")
        if sum(item["weight_bps"] for item in weights) != denominator:
            errors.append(f"weights must sum exactly to {denominator} bps")
        if not weighted_submissions:
            errors.append("receipt weights require at least one signed weighted submission")
        else:
            totals = {bucket: Decimal(0) for bucket in EXPECTED_BUCKETS}
            for submission in weighted_submissions:
                submitted_weights = submission["weights"]
                if [entry["bucket"] for entry in submitted_weights] != EXPECTED_BUCKETS:
                    errors.append("signed weight vectors must cover the four canonical buckets in order")
                    continue
                submitted_total = sum(entry["weight"] for entry in submitted_weights)
                if submitted_total <= 0:
                    errors.append("signed weight vectors must have a positive total")
                    continue
                for entry in submitted_weights:
                    totals[entry["bucket"]] += entry["weight"] / submitted_total
            count = Decimal(len(weighted_submissions))
            mean = {bucket: totals[bucket] / count for bucket in EXPECTED_BUCKETS}
            # ONE conversion implementation, shared with the legacy reconciliation
            # and with the property tests. A second copy here is exactly the
            # "two roundings that agree until they do not" failure this closes.
            try:
                expected = mean_weights_to_bps(mean, spec, denominator)
            except CanonicalizationError as exc:
                errors.append(f"receipt weights are not bps-convertible: {exc}")
            else:
                if weights != expected:
                    errors.append("receipt weights do not equal the pinned bps-converted signed mean")
    elif weighted_submissions:
        errors.append("a receipt with signed complete weight vectors must carry the derived bps weights")
    return errors


def mapping_errors(mapping: dict[str, Any], spec: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    prd_vaults = prd_vault_symbols()
    rows = mapping.get("buckets", [])
    buckets = [row.get("bucket") for row in rows]
    vaults = [row.get("vault_symbol") for row in rows]
    if buckets != EXPECTED_BUCKETS or mapping.get("canonical_bucket_order") != EXPECTED_BUCKETS:
        errors.append("bucket map must cover the four PRD §11 buckets in canonical order")
    if spec.get("canonical_bucket_order") != EXPECTED_BUCKETS:
        errors.append("canonicalization spec bucket order disagrees with bucket map")

    # Exactly the PRD §11 catalog: no extras, none missing, no duplicates.
    missing = [symbol for symbol in prd_vaults if symbol not in vaults]
    extra = [symbol for symbol in vaults if symbol not in prd_vaults]
    if missing:
        errors.append(f"bucket map omits PRD §11 vault(s): {', '.join(missing)}")
    if extra:
        errors.append(f"bucket map names vault(s) absent from PRD §11: {', '.join(extra)}")
    if len(set(vaults)) != len(vaults):
        errors.append("bucket map maps two buckets onto the same vault symbol")
    if len(vaults) != len(prd_vaults):
        errors.append(
            f"bucket map has {len(vaults)} vault(s); PRD §11 names {len(prd_vaults)}"
        )

    for row in rows:
        expected_pointer = f"/vault_addresses/{row.get('vault_symbol')}"
        if row.get("deployment_address_json_pointer") != expected_pointer:
            errors.append(f"{row.get('bucket')} does not resolve its address per deployment")
    contract = mapping.get("deployment_address_contract", {})
    required = contract.get("required_vault_symbols")
    if not isinstance(required, list) or sorted(required) != sorted(prd_vaults):
        errors.append("deployment address contract must require exactly the PRD §11 vault symbols")
    return errors


def keccak256(payload: bytes) -> str:
    from Crypto.Hash import keccak

    return "0x" + keccak.new(digest_bits=256, data=payload).hexdigest()


def digest_errors(anchor: dict[str, Any]) -> list[str]:
    """Hash the golden files and compare against the committed constants.

    Derived, never transcribed (robotmoney-core#1280): editing the bytes without
    editing the constant fails here, and so does the reverse. keccak256 — NOT
    sha3-256, which is NIST-padded and different — because that is what an EVM
    anchor computes over the payload.
    """
    errors: list[str] = []
    # Guard the guard: a keccak implementation that is quietly sha3-256 would
    # agree with nothing, but one that is quietly *anything* would agree with a
    # constant regenerated from itself. Pin the standard empty-string vector.
    if keccak256(b"") != "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470":
        return ["keccak256 implementation fails the standard empty-string vector"]

    goldens = anchor.get("goldens", [])
    if not goldens:
        return ["anchor digest file names no golden files"]
    for entry in goldens:
        path = FIXTURES / entry["file"]
        if not path.is_file():
            errors.append(f"anchor digest names a missing golden: {entry['file']}")
            continue
        payload = path.read_bytes()
        if len(payload) != entry["byte_length"]:
            errors.append(
                f"{entry['file']}: {len(payload)} bytes, anchor digest records {entry['byte_length']}"
            )
        actual_keccak = keccak256(payload)
        if actual_keccak != entry["keccak256"]:
            errors.append(
                f"{entry['file']}: keccak256 is {actual_keccak}, anchor digest records {entry['keccak256']}"
            )
        actual_sha = "0x" + hashlib.sha256(payload).hexdigest()
        if actual_sha != entry["sha256"]:
            errors.append(
                f"{entry['file']}: sha256 is {actual_sha}, anchor digest records {entry['sha256']}"
            )
    return errors


def legacy_errors(
    legacy: dict[str, Any],
    spec: dict[str, Any],
    schema: dict[str, Any],
    denominator: int,
    valid: dict[str, Any],
    validator: Any,
) -> list[str]:
    """The two shape decisions issue #1246 owes an answer to, made checkable.

    consensus-receipt.legacy-weights.json states them in prose. Prose alone is
    how `within_bucket_weights` got where it is: a field with no producer, one
    display-only reader, and no recorded decision either way. So each written
    resolution is BOUND HERE to the behaviour it claims:

      "DROPPED"  ->  schema 1.0 must actually REFUSE a receipt carrying it.
      "ARRAY"    ->  schema 1.0 must actually type `weights` as an array.

    and the archived corpus is CONVERTED rather than transcribed, so the
    reconciliation is recomputed on every run instead of remembered.
    """
    errors: list[str] = []
    order = spec.get("canonical_bucket_order", [])
    decisions = legacy.get("decisions", {})

    # ── decision 1: within_bucket_weights is dropped, and the schema says so ──
    dropped = decisions.get("within_bucket_weights", {}).get("resolution", "")
    if not dropped.startswith("DROPPED"):
        errors.append(
            f"legacy fixture records within_bucket_weights as {dropped!r}; "
            "this check only knows how to verify a DROPPED resolution"
        )
    elif "within_bucket_weights" in schema.get("properties", {}):
        errors.append(
            "legacy fixture says within_bucket_weights is DROPPED, but the schema defines it "
            "— a promotion into the shared schema is a coordinated cross-repo change, not a drive-by edit"
        )
    else:
        smuggled = copy.deepcopy(valid)
        smuggled["within_bucket_weights"] = {"agent_tokens": {"robotmoney": 1}}
        if not list(validator.iter_errors(smuggled)):
            errors.append(
                "schema 1.0 ACCEPTS a receipt carrying within_bucket_weights; the field is documented "
                "as dropped, so the root object must stay additionalProperties:false"
            )

    # ── decision 2: weights is an array, not a map ────────────────────────────
    shape = decisions.get("weights_shape", {}).get("resolution", "")
    if not shape.startswith("ARRAY"):
        errors.append(
            f"legacy fixture records the weights shape as {shape!r}; "
            "this check only knows how to verify an ARRAY resolution"
        )
    elif schema.get("properties", {}).get("weights", {}).get("type") != "array":
        errors.append("legacy fixture says `weights` is an ARRAY, but the schema does not type it as one")

    # ── the archived corpus: converted, round-tripped, nothing transcribed ────
    vectors = legacy.get("vectors", [])
    if not vectors:
        return errors + ["legacy fixture pins no archived vectors"]
    tolerance = legacy.get("round_trip_tolerance_bps")
    if not isinstance(tolerance, int) or tolerance < 0:
        return errors + ["legacy fixture does not pin a round_trip_tolerance_bps"]

    for vector in vectors:
        where = vector.get("source", "<unnamed>")
        archived = vector.get("legacy_weights", {})

        if vector.get("carries_schema_version") is not False:
            errors.append(
                f"{where}: recorded as carrying a schema_version. The reconciliation rests on these "
                "payloads being PRE-schema session archives rather than receipts to retro-fit"
            )
        if list(archived) != vector.get("legacy_key_order"):
            errors.append(f"{where}: legacy_key_order does not match the archived map's own key order")
        if list(archived) == list(order):
            errors.append(
                f"{where}: the archived key order is already canonical, so this vector no longer "
                "demonstrates the map/array drift it was committed to pin"
            )
        counts = vector.get("within_bucket_weights_constituent_counts", {})
        if not counts or any(not isinstance(n, int) or n < 1 for n in counts.values()):
            errors.append(
                f"{where}: records no dropped within-bucket constituents. An empty drop record makes "
                "the DROPPED decision unfalsifiable — the point is that real data is being left out"
            )

        try:
            converted = float_vector_to_bps(archived, spec, denominator)
        except CanonicalizationError as exc:
            errors.append(f"{where}: archived vector is not bps-convertible: {exc}")
            continue
        if converted != vector.get("canonical_weights"):
            errors.append(
                f"{where}: conversion yields {converted}, the fixture records {vector.get('canonical_weights')}"
            )
            continue
        if sum(entry["weight_bps"] for entry in converted) != denominator:
            errors.append(f"{where}: converted vector does not sum to {denominator} bps")

        # ROUND TRIP — "loses nothing", asserted rather than asserted-to.
        recovered = {entry["bucket"]: entry["weight_bps"] for entry in converted}
        if sorted(recovered) != sorted(archived):
            errors.append(
                f"{where}: round trip changes the bucket set — archived {sorted(archived)}, "
                f"recovered {sorted(recovered)}"
            )
            continue
        for bucket, share in normalize_weights(archived).items():
            drift = abs(Decimal(recovered[bucket]) - share * denominator)
            if drift > tolerance:
                errors.append(
                    f"{where}: {bucket} drifts {drift} bps across the round trip, over the pinned "
                    f"tolerance of {tolerance}"
                )
    return errors


def shared_manifest_errors(anchor: dict[str, Any]) -> list[str]:
    """Re-hash every shared fixture and compare against the committed manifest.

    WHY sha256 HERE AND keccak256 ABOVE. keccak256 is what an EVM anchor computes,
    so the golden bytes are pinned that way. This manifest is aimed at the OTHER
    repo: contract/ in robotmoney-frontend has zero dependencies and cannot reach
    keccak256, but sha256 is in its runtime. Pinning the shared set in sha256 is
    what makes cross-repo byte identity checkable FROM EITHER SIDE with one
    command and no new dependency — manifest_errors() below can only prove the
    set has the right NAMES, which is the weaker half.
    """
    errors: list[str] = []
    manifest = anchor.get("shared_fixture_manifest", {})
    rows = manifest.get("files", [])
    named = [row.get("file") for row in rows]
    if named != SHARED_WITH_FRONTEND:
        errors.append(
            f"shared fixture manifest covers {named}; the shared set is {SHARED_WITH_FRONTEND} "
            "— every shared file must be pinned, in order, and nothing else"
        )
    for row in rows:
        path = FIXTURES / str(row.get("file"))
        if not path.is_file():
            errors.append(f"shared fixture manifest names a missing file: {row.get('file')}")
            continue
        payload = path.read_bytes()
        if len(payload) != row.get("byte_length"):
            errors.append(
                f"{row['file']}: {len(payload)} bytes, manifest records {row.get('byte_length')}"
            )
        actual = "0x" + hashlib.sha256(payload).hexdigest()
        if actual != row.get("sha256"):
            errors.append(f"{row['file']}: sha256 is {actual}, manifest records {row.get('sha256')}")
    return errors


# The claims §7.4 has to keep making for the cross-repo process to mean anything.
# Deliberately a handful of load-bearing substrings, not the prose: the wording
# is free to improve, the commitments are not free to disappear.
RELEASE_PROCESS_REQUIRED = [
    "### 7.4",
    "The verifier deploys first. The producer deploys second.",
    "Merge order: core, then frontend.",
    "Deploy order: core, then frontend.",
    "The old schema document is never deleted.",
    "shared_fixture_manifest",
    "contract/tests/unit/consensus-receipt-fixture.test.ts",
]


def release_process_doc_errors() -> list[str]:
    """AC6: the cross-repo release process is written down, and stays written down.

    A process that lives only in a merged PR description is a process the next
    schema revision will not follow. This asserts the canonical proposal still
    carries the parts a second repo cannot infer: which side deploys first, that
    the ordering survives an append-only minor bump, that old schema documents
    are never retired, and where the one-command cross-repo comparison lives.
    """
    if not PROPOSAL_PATH.is_file():
        return [f"{PROPOSAL_PATH.name} is missing; §7.4 is the canonical release process"]
    text = PROPOSAL_PATH.read_text(encoding="utf-8")
    return [
        f"{PROPOSAL_PATH.name} no longer states {claim!r} — the cross-repo release process (§7.4) "
        "must say which side deploys first and why"
        for claim in RELEASE_PROCESS_REQUIRED
        if claim not in text
    ]


def manifest_errors() -> list[str]:
    """The shared set is exactly what it claims to be.

    Byte identity with robotmoney-frontend cannot be checked from CI here — that
    repo is not fetched. What CAN be checked is that nobody quietly added a
    core-only file to the shared family or dropped one out of it, so the
    manifest a human compares against stays honest.
    """
    errors: list[str] = []
    on_disk = sorted(path.name for path in FIXTURES.glob("consensus-receipt.*"))
    expected = sorted(SHARED_WITH_FRONTEND + CORE_ONLY)
    if on_disk != expected:
        errors.append(
            "consensus-receipt fixture set drifted from the cross-repo manifest: "
            f"on disk {on_disk}, manifest {expected}"
        )
    return errors


def check(paths_must_exist: bool = True) -> list[str]:
    """Every assertion, returning the failures. Shared by the run and the self-test."""
    failures: list[str] = []
    import jsonschema  # type: ignore[import]

    schema = load_json(SCHEMA_PATH)
    spec = load_json(CANONICALIZATION_PATH)
    mapping = load_json(MAP_PATH)
    anchor = load_json(ANCHOR_DIGEST_PATH)
    legacy = load_json(LEGACY_PATH)
    valid = load_json(VALID_PATH)
    valid_no_weights = load_json(VALID_NO_WEIGHTS_PATH)
    invalid = load_json(INVALID_PATH)
    escaping = load_json(ESCAPING_PATH)
    validator = jsonschema.Draft7Validator(schema, format_checker=jsonschema.FormatChecker())
    denominator = bps_denominator(schema)

    failures.extend(manifest_errors())
    failures.extend(spec_schema_agreement(schema, spec))

    for path, receipt in ((VALID_PATH, valid), (VALID_NO_WEIGHTS_PATH, valid_no_weights)):
        schema_errors = sorted(validator.iter_errors(receipt), key=lambda error: list(error.path))
        failures.extend(f"{path.name}: {error.message}" for error in schema_errors)
        sem = semantic_errors(receipt, spec, denominator)
        failures.extend(f"{path.name}: {error}" for error in sem)
        sig = signature_errors(receipt, path.name)
        failures.extend(sig)
        if not schema_errors and not sem and not sig:
            print(f"ok: {path.name} passes schema, semantics, and Ed25519 signature verification")

    # The escaping receipt is a SERIALIZER conformance fixture, not a plausible
    # session: it carries signed four-bucket vectors but deliberately omits
    # `weights`, so the derived-mean rule does not apply to it. It is held to the
    # schema, to signature verification, and to its own golden bytes — which is
    # the whole reason it exists.
    escaping_schema_errors = sorted(validator.iter_errors(escaping), key=lambda error: list(error.path))
    failures.extend(f"{ESCAPING_PATH.name}: {error.message}" for error in escaping_schema_errors)
    failures.extend(signature_errors(escaping, ESCAPING_PATH.name))
    failures.extend(f"{ESCAPING_PATH.name}: {error}" for error in judge_errors(escaping))

    invalid_errors = list(validator.iter_errors(invalid)) + [
        ValueError(error) for error in semantic_errors(invalid, spec, denominator)
    ]
    if not invalid_errors:
        failures.append(f"{INVALID_PATH.name} unexpectedly passed validation")
    else:
        print(f"ok: {INVALID_PATH.name} correctly rejected ({len(invalid_errors)} errors)")

    map_errors = mapping_errors(mapping, spec)
    failures.extend(map_errors)
    if not map_errors:
        print(
            "ok: bucket map covers exactly the PRD §11 vault catalog "
            f"({', '.join(prd_vault_symbols())}) and resolves each address per deployment"
        )

    for receipt, golden_path in ((valid, CANONICAL_PATH), (escaping, ESCAPING_CANONICAL_PATH)):
        try:
            canonical = canonicalize_receipt(receipt, spec)
        except CanonicalizationError as exc:
            failures.append(f"{golden_path.name}: canonicalization refused: {exc}")
            continue
        if canonical != golden_path.read_text(encoding="utf-8"):
            failures.append(f"{golden_path.name}: canonical bytes differ from the committed golden")
        else:
            print(f"ok: spec-driven canonical bytes match {golden_path.name}")

    shuffled = dict(reversed(list(valid.items())))
    if canonicalize_receipt(shuffled, spec) != canonicalize_receipt(valid, spec):
        failures.append("canonicalizer depends on input object key order")
    if '"weights":' in canonicalize_receipt(valid_no_weights, spec):
        failures.append("absent optional weights field must remain absent from canonical bytes")
    else:
        print("ok: optional weights obey the append-only omission rule")

    digest_failures = digest_errors(anchor)
    failures.extend(digest_failures)
    if not digest_failures:
        print(
            "ok: committed keccak256/sha256 constants are reproduced from the golden bytes "
            "(robotmoney-core#1280)"
        )

    manifest_failures = shared_manifest_errors(anchor)
    failures.extend(manifest_failures)
    if not manifest_failures:
        print(
            f"ok: all {len(SHARED_WITH_FRONTEND)} cross-repo shared fixtures reproduce their "
            "committed sha256 (issue #1246)"
        )

    process_failures = release_process_doc_errors()
    failures.extend(process_failures)
    if not process_failures:
        print("ok: the cross-repo schema release process is documented in §7.4 (issue #1246)")

    legacy_failures = legacy_errors(legacy, spec, schema, denominator, valid, validator)
    failures.extend(legacy_failures)
    if not legacy_failures:
        print(
            f"ok: within_bucket_weights is dropped and refused by the schema, `weights` is the array "
            f"shape, and all {len(legacy.get('vectors', []))} archived map payloads convert and round "
            "trip within the pinned tolerance (issue #1246)"
        )

    return failures


def self_test() -> int:
    """Prove each guard fires before a green run is believed.

    Every case below shipped GREEN under the previous version of this script:
    the canonicalizer hard-coded its own field order (so scrambling the spec was
    invisible), and signatures were shape-checked but never verified (so editing
    a signed body was invisible).
    """
    import jsonschema  # type: ignore[import]

    spec = load_json(CANONICALIZATION_PATH)
    schema = load_json(SCHEMA_PATH)
    valid = load_json(VALID_PATH)
    anchor = load_json(ANCHOR_DIGEST_PATH)
    cases: list[tuple[str, bool]] = []

    # 1. Scrambled top-level field_order must change the bytes AND disagree with the schema.
    scrambled = copy.deepcopy(spec)
    order = list(scrambled["field_order"])
    scrambled["field_order"] = [order[1], order[0]] + order[2:]
    cases.append((
        "scrambled spec field_order is caught",
        canonicalize_receipt(valid, scrambled) != CANONICAL_PATH.read_text(encoding="utf-8")
        and bool(spec_schema_agreement(schema, scrambled)),
    ))

    # 2. Scrambled nested order likewise.
    nested = copy.deepcopy(spec)
    nested["nested_field_order"]["quorum"] = ["submitted", "active", "absent", "participation_bps"]
    cases.append((
        "scrambled spec nested_field_order is caught",
        canonicalize_receipt(valid, nested) != CANONICAL_PATH.read_text(encoding="utf-8")
        and bool(spec_schema_agreement(schema, nested)),
    ))

    # 3. A field named in the spec that the schema does not define.
    invented = copy.deepcopy(spec)
    invented["field_order"] = list(spec["field_order"]) + ["not_a_field"]
    cases.append(("spec naming an unknown field is caught", bool(spec_schema_agreement(schema, invented))))

    # 4. Editing one character of a signed body must break signature verification.
    tampered = copy.deepcopy(valid)
    submission = tampered["analyst_signatures"][0]["canonical_submission"]
    tampered["analyst_signatures"][0]["canonical_submission"] = submission.replace(
        "Prefer stable", "Prefers stable", 1
    )
    cases.append((
        "an edited signed body breaks Ed25519 verification",
        any("does NOT verify" in error for error in signature_errors(tampered, "tampered")),
    ))

    # 5. A stale digest constant must be caught.
    stale = copy.deepcopy(anchor)
    stale["goldens"][0]["keccak256"] = "0x" + "00" * 32
    cases.append(("a stale keccak256 constant is caught", bool(digest_errors(stale))))

    # 6. A judge block whose flags contradict its own numbers.
    lying = copy.deepcopy(valid)
    lying["judge"]["release_safety"]["thinly_supported"] = True
    cases.append((
        "thinly_supported that disagrees with take_count/min_takes is caught",
        bool(judge_errors(lying)),
    ))
    steered = copy.deepcopy(valid)
    steered["judge"]["release_safety"]["concerns"] = ["A concern the model added."]
    cases.append((
        "release=\"safe\" alongside a concern is caught",
        bool(judge_errors(steered)),
    ))

    # 7. A receipt missing a required field must be REFUSED, not silently emitted.
    incomplete = copy.deepcopy(valid)
    del incomplete["judge"]["source"]
    refused = False
    try:
        canonicalize_receipt(incomplete, spec)
    except CanonicalizationError:
        refused = True
    cases.append(("canonicalizer refuses a receipt missing a required field", refused))

    # 8. The invalid fixture is refused by the schema for named reasons.
    validator = jsonschema.Draft7Validator(schema, format_checker=jsonschema.FormatChecker())
    cases.append((
        "the invalid fixture is refused",
        bool(list(validator.iter_errors(load_json(INVALID_PATH)))),
    ))

    # ── issue #1246 guards ───────────────────────────────────────────────────
    legacy = load_json(LEGACY_PATH)
    denominator = bps_denominator(schema)

    # 9. A stale sha256 in the cross-repo manifest must be caught — this is the
    #    whole value of the manifest, and a transcribed constant that only ever
    #    agrees with itself is the failure mode it exists to prevent.
    stale_manifest = copy.deepcopy(anchor)
    stale_manifest["shared_fixture_manifest"]["files"][0]["sha256"] = "0x" + "00" * 32
    cases.append(("a stale shared-fixture sha256 is caught", bool(shared_manifest_errors(stale_manifest))))

    # 10. A shared file dropped from the manifest must be caught, or a fixture
    #     could quietly leave the pinned set without leaving the shared set.
    short_manifest = copy.deepcopy(anchor)
    short_manifest["shared_fixture_manifest"]["files"].pop()
    cases.append(("a shared fixture missing from the manifest is caught", bool(shared_manifest_errors(short_manifest))))

    # 11. The conversion is DERIVED from the archived map, not transcribed.
    edited_legacy = copy.deepcopy(legacy)
    edited_legacy["vectors"][0]["canonical_weights"][0]["weight_bps"] += 1
    cases.append((
        "a legacy vector whose recorded bps disagree with the conversion is caught",
        bool(legacy_errors(edited_legacy, spec, schema, denominator, valid, validator)),
    ))

    # 12. "within_bucket_weights is DROPPED" is bound to the schema REFUSING it.
    #     A schema that opened its root would silently make the recorded decision
    #     false while every other check stayed green.
    open_schema = copy.deepcopy(schema)
    open_schema["additionalProperties"] = True
    open_validator = jsonschema.Draft7Validator(open_schema, format_checker=jsonschema.FormatChecker())
    cases.append((
        "a schema that would accept within_bucket_weights is caught",
        bool(legacy_errors(legacy, spec, open_schema, denominator, valid, open_validator)),
    ))

    # 13. The bps converter READS canonical_bucket_order from the spec. A
    #     hard-coded order would ignore this and return the same vector.
    reordered = copy.deepcopy(spec)
    reordered["canonical_bucket_order"] = list(reversed(spec["canonical_bucket_order"]))
    archived = legacy["vectors"][0]["legacy_weights"]
    cases.append((
        "the bps converter follows the spec's bucket order, not a hard-coded one",
        float_vector_to_bps(archived, reordered, denominator)
        != float_vector_to_bps(archived, spec, denominator),
    ))

    # 14. The release process cannot silently lose its deploy-order rule.
    cases.append((
        "a release process missing its deploy-order rule is caught",
        bool([
            claim for claim in RELEASE_PROCESS_REQUIRED
            if claim not in PROPOSAL_PATH.read_text(encoding="utf-8").replace(
                "Deploy order: core, then frontend.", "Deploy order: whichever is ready."
            )
        ]),
    ))

    # 15. bps_conversion.final_rule's range check is a REAL branch. Three prefix
    #     buckets each rounding half-up can overshoot the denominator by up to
    #     1.5 bps, driving the settled last entry negative; that vector has no
    #     representation and must be REFUSED rather than proposed and reverted.
    order = spec["canonical_bucket_order"]
    overshoot = {order[0]: "0.33335", order[1]: "0.33335", order[2]: "0.3333", order[3]: "0"}
    refused = False
    try:
        mean_weights_to_bps({k: Decimal(v) for k, v in overshoot.items()}, spec, denominator)
    except CanonicalizationError:
        refused = True
    cases.append(("a vector whose settled last bucket goes negative is refused", refused))

    failed = [name for name, passed in cases if not passed]
    for name, passed in cases:
        print(f"{'ok' if passed else 'FAIL'}: self-test — {name}")
    if failed:
        print(f"ERROR: {len(failed)} self-test case(s) did not fire", file=sys.stderr)
        return 1
    print(f"ok: all {len(cases)} self-test cases fire")
    return 0


def main(argv: list[str]) -> int:
    required_paths = [
        SCHEMA_PATH,
        CANONICALIZATION_PATH,
        MAP_PATH,
        ANCHOR_DIGEST_PATH,
        VALID_PATH,
        VALID_NO_WEIGHTS_PATH,
        INVALID_PATH,
        ESCAPING_PATH,
        CANONICAL_PATH,
        ESCAPING_CANONICAL_PATH,
        LEGACY_PATH,
    ]
    missing = [path.name for path in required_paths if not path.is_file()]
    if missing:
        print(f"ERROR: missing fixture(s): {', '.join(missing)}", file=sys.stderr)
        return 1

    for module, hint in (
        ("jsonschema", "pip install jsonschema"),
        ("cryptography", "pip install cryptography"),
        ("Crypto.Hash", "pip install pycryptodome"),
    ):
        try:
            __import__(module)
        except ImportError:
            print(f"ERROR: {module} not installed ({hint})", file=sys.stderr)
            return 2

    if "--self-test" in argv:
        return self_test()

    failures = check()
    if failures:
        for failure in failures:
            print(f"ERROR: {failure}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
