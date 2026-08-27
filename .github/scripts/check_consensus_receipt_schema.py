#!/usr/bin/env python3
"""Validate Project Fusion's pinned consensus-receipt design (issue #1244)."""
from __future__ import annotations

import json
import sys
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = REPO_ROOT / "tests" / "fixtures"
SCHEMA_PATH = FIXTURES / "consensus-receipt.schema.json"
CANONICALIZATION_PATH = FIXTURES / "consensus-receipt.canonicalization.json"
MAP_PATH = FIXTURES / "consensus-receipt.bucket-vault-map.json"
VALID_PATH = FIXTURES / "consensus-receipt.valid.json"
VALID_NO_WEIGHTS_PATH = FIXTURES / "consensus-receipt.valid-no-weights.json"
INVALID_PATH = FIXTURES / "consensus-receipt.invalid.json"
CANONICAL_PATH = FIXTURES / "consensus-receipt.valid.canonical.txt"

EXPECTED_BUCKETS = [
    "agent_tokens",
    "conservative_defi_yield",
    "protocol_tokens",
    "real_world_assets",
]
EXPECTED_VAULTS = ["rmAGENT", "rmUSDC", "rmPROTO", "rmRWA"]
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


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} must contain a JSON object")
    return value


def compact_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    )


def canonicalize_receipt(receipt: dict[str, Any], spec: dict[str, Any]) -> str:
    """Reference implementation of the language-neutral canonicalization data."""
    quorum = receipt["quorum"]
    stances = receipt["stances"]
    judge = receipt["judge"]
    ordered: dict[str, Any] = {
        "schema_version": receipt["schema_version"],
        "session_id": receipt["session_id"],
        "subject_id": receipt["subject_id"],
        "created_at": receipt["created_at"],
        "prompt_hash": receipt["prompt_hash"],
        "inputs_digest": receipt["inputs_digest"],
        "quorum": {
            "active": quorum["active"],
            "submitted": quorum["submitted"],
            "absent": quorum["absent"],
            "participation_bps": quorum["participation_bps"],
        },
        "stances": {
            "bearish": stances["bearish"],
            "cautious": stances["cautious"],
            "neutral": stances["neutral"],
            "constructive": stances["constructive"],
            "bullish": stances["bullish"],
        },
        "judge": {
            "rationale": judge["rationale"],
            "consensus": list(judge["consensus"]),
            "disagreements": [
                {
                    "topic": item["topic"],
                    "positions": [
                        {"member_id": position["member_id"], "view": position["view"]}
                        for position in item["positions"]
                    ],
                    "what_settles": item["what_settles"],
                }
                for item in judge["disagreements"]
            ],
            "release_safety": {
                "safe_to_release": judge["release_safety"]["safe_to_release"],
                "opinion": judge["release_safety"]["opinion"],
            },
        },
        "analyst_signatures": [
            {
                "member_id": item["member_id"],
                "public_key": item["public_key"],
                "canonical_submission": item["canonical_submission"],
                "signature": item["signature"],
            }
            for item in receipt["analyst_signatures"]
        ],
    }
    if receipt.get("weights") is not None:
        ordered["weights"] = [
            {"bucket": item["bucket"], "weight_bps": item["weight_bps"]}
            for item in receipt["weights"]
        ]
    canonical = spec["domain_separator"] + compact_json(ordered)
    return canonical + ("\n" if spec.get("trailing_newline") else "")


def semantic_errors(receipt: dict[str, Any]) -> list[str]:
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
        if sum(item["weight_bps"] for item in weights) != 10_000:
            errors.append("weights must sum exactly to 10,000 bps")
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
            prefix = [
                int((totals[bucket] / count * 10_000).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
                for bucket in EXPECTED_BUCKETS[:-1]
            ]
            expected_bps = prefix + [10_000 - sum(prefix)]
            if [entry["weight_bps"] for entry in weights] != expected_bps:
                errors.append("receipt weights do not equal the pinned bps-converted signed mean")
    elif weighted_submissions:
        errors.append("a receipt with signed complete weight vectors must carry the derived bps weights")
    return errors


def mapping_errors(mapping: dict[str, Any], spec: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    rows = mapping.get("buckets", [])
    buckets = [row.get("bucket") for row in rows]
    vaults = [row.get("vault_symbol") for row in rows]
    if buckets != EXPECTED_BUCKETS or mapping.get("canonical_bucket_order") != EXPECTED_BUCKETS:
        errors.append("bucket map must cover the four PRD §11 buckets in canonical order")
    if spec.get("canonical_bucket_order") != EXPECTED_BUCKETS:
        errors.append("canonicalization spec bucket order disagrees with bucket map")
    if vaults != EXPECTED_VAULTS:
        errors.append("bucket map must map exactly to rmAGENT/rmUSDC/rmPROTO/rmRWA")
    for row in rows:
        expected_pointer = f"/vault_addresses/{row.get('vault_symbol')}"
        if row.get("deployment_address_json_pointer") != expected_pointer:
            errors.append(f"{row.get('bucket')} does not resolve its address per deployment")
    contract = mapping.get("deployment_address_contract", {})
    if contract.get("required_vault_symbols") != ["rmUSDC", "rmPROTO", "rmAGENT", "rmRWA"]:
        errors.append("deployment address contract must require all four PRD §11 vault symbols")
    return errors


def main() -> int:
    required_paths = [
        SCHEMA_PATH,
        CANONICALIZATION_PATH,
        MAP_PATH,
        VALID_PATH,
        VALID_NO_WEIGHTS_PATH,
        INVALID_PATH,
        CANONICAL_PATH,
    ]
    missing = [path.name for path in required_paths if not path.is_file()]
    if missing:
        print(f"ERROR: missing fixture(s): {', '.join(missing)}", file=sys.stderr)
        return 1

    try:
        import jsonschema  # type: ignore[import]
    except ImportError:
        print("ERROR: jsonschema package not installed", file=sys.stderr)
        return 2

    schema = load_json(SCHEMA_PATH)
    spec = load_json(CANONICALIZATION_PATH)
    mapping = load_json(MAP_PATH)
    valid = load_json(VALID_PATH)
    valid_no_weights = load_json(VALID_NO_WEIGHTS_PATH)
    invalid = load_json(INVALID_PATH)
    validator = jsonschema.Draft7Validator(schema, format_checker=jsonschema.FormatChecker())

    failures: list[str] = []
    for path, receipt in ((VALID_PATH, valid), (VALID_NO_WEIGHTS_PATH, valid_no_weights)):
        schema_errors = sorted(validator.iter_errors(receipt), key=lambda error: list(error.path))
        failures.extend(f"{path.name}: {error.message}" for error in schema_errors)
        failures.extend(f"{path.name}: {error}" for error in semantic_errors(receipt))
        if not schema_errors and not semantic_errors(receipt):
            print(f"ok: {path.name} passes schema and semantic validation")

    invalid_errors = list(validator.iter_errors(invalid)) + [
        ValueError(error) for error in semantic_errors(invalid)
    ]
    if not invalid_errors:
        failures.append(f"{INVALID_PATH.name} unexpectedly passed validation")
    else:
        print(f"ok: {INVALID_PATH.name} correctly rejected ({len(invalid_errors)} errors)")

    failures.extend(mapping_errors(mapping, spec))
    if not mapping_errors(mapping, spec):
        print("ok: bucket map covers exactly the four PRD §11 vaults and resolves per deployment")

    canonical = canonicalize_receipt(valid, spec)
    expected_canonical = CANONICAL_PATH.read_text(encoding="utf-8")
    if canonical != expected_canonical:
        failures.append("valid receipt canonical bytes differ from the committed golden")
    else:
        print("ok: fixed-order canonical bytes match the committed golden")

    shuffled = dict(reversed(list(valid.items())))
    if canonicalize_receipt(shuffled, spec) != canonical:
        failures.append("canonicalizer depends on input object key order")
    if '\"weights\":' in canonicalize_receipt(valid_no_weights, spec):
        failures.append("absent optional weights field must remain absent from canonical bytes")
    else:
        print("ok: optional weights obey the append-only omission rule")

    if failures:
        for failure in failures:
            print(f"ERROR: {failure}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
