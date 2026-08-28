"""Property tests for the pinned float → bps conversion (issue #1246).

WHAT THIS FILE GUARDS

`robotmoney-frontend` expresses an allocation as `[0,1]` floats over four named
buckets. This repo expresses it as `target_weight_bps` over four vault
addresses, and `RouterGovernance.propose` HARD-REJECTS any vector that does not
sum to `BPS_DENOMINATOR` exactly (`contracts/gateway/RouterGovernance.sol`).
Nothing converted between them before #1246, so the rounding rule was whatever
each side reached for first — and two roundings that agree on the fixtures
agree right up until the session that lands on a boundary.

The rule is pinned as DATA in `consensus-receipt.canonicalization.json`
(`bps_conversion`), the bucket order comes from the same file, and
`BPS_DENOMINATOR` comes from the schema. The implementation under test reads all
three rather than restating them, which is what makes it a reader of the
cross-repo spec instead of a second authority that can drift from it.

WHY PROPERTIES AND NOT THREE EXAMPLES. The claim is universal — "the output
sums to exactly BPS_DENOMINATOR" — so it is exercised over generated vectors,
including the degenerate ones a hand-picked example set never contains: a single
bucket holding everything, zeros, dust below half a bps, exact `.5` rounding
boundaries, and the near-tie whose residue the settle-the-last rule has to
absorb. The PRNG is seeded, so a failure is reproducible from the printed seed
rather than "it went red once in CI".

WHAT IS DELIBERATELY *NOT* ASSERTED, AND WHY IT MATTERS. Not "every vector
converts". The spec's `final_rule` REFUSES a vector whose settled last entry
falls outside `0..BPS_DENOMINATOR`, so the universal property here is "REFUSE,
or sum to exactly BPS_DENOMINATOR" — never "always converts".

That refusal is NOT a corner case, and writing these tests is how that surfaced.
When the LAST canonical bucket (`real_world_assets`) is exactly zero, the three
prefix buckets carry the whole distribution, their true bps sum is exactly
BPS_DENOMINATOR, and their three independent roundings sum to +1 bps about ONE
TIME IN EIGHT — which settles the last entry to -1 and refuses the vector.
`test_a_zero_last_bucket_is_where_the_final_rule_refusal_lives` measures it:
~12.5% refused with a zero last bucket, 0% without one. Four of the six real
archived allocations have `real_world_assets` exactly 0, so this is the shape
the committee actually produces, not an invented input.

The rule is not softened here. `bps_conversion` lives in
`consensus-receipt.canonicalization.json`, one of the nine fixtures that are
byte-identical to `robotmoney-frontend` — changing it is a coordinated cross-repo
schema event, never a unilateral edit from this side. So this file implements
the pinned rule exactly, PINS the refusal rate so it cannot drift unnoticed, and
the finding is written up in
`docs/product/20260623-product-proposal-investment-committee-v0.md` §7.1, with
robotmoney-core#1290 filed for the coordinated fix.
"""

from __future__ import annotations

import copy
import json
import sys
from decimal import Decimal
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIR))

import check_consensus_receipt_schema as receipt  # noqa: E402

SPEC = receipt.load_json(receipt.CANONICALIZATION_PATH)
SCHEMA = receipt.load_json(receipt.SCHEMA_PATH)
VALID = receipt.load_json(receipt.VALID_PATH)
VALID_NO_WEIGHTS = receipt.load_json(receipt.VALID_NO_WEIGHTS_PATH)
LEGACY = receipt.load_json(receipt.LEGACY_PATH)
GOLDEN = receipt.CANONICAL_PATH.read_text(encoding="utf-8")

DEN = receipt.bps_denominator(SCHEMA)
BUCKETS = SPEC["canonical_bucket_order"]
SEED = 1246


def lcg(seed: int):
    """The same deterministic PRNG shape robotmoney-frontend's weight properties use."""
    state = seed & 0xFFFFFFFF

    def next_float() -> float:
        nonlocal state
        state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
        return state / 0x100000000

    return next_float


def convert(raw: dict) -> list[dict]:
    return receipt.float_vector_to_bps(raw, SPEC, DEN)


# ── the universal property ────────────────────────────────────────────────────


def test_the_denominator_and_bucket_order_are_read_not_typed():
    """If either were hard-coded here the tests below would prove nothing about the spec."""
    assert DEN == SCHEMA["definitions"]["bucket_weight"]["properties"]["weight_bps"]["maximum"]
    assert BUCKETS == SPEC["canonical_bucket_order"]
    assert len(BUCKETS) >= 2


def test_continuous_random_vectors_always_sum_to_the_denominator():
    """20,000 uniform [0,1] vectors: every one converts, every one sums exactly.

    Continuous inputs essentially never land on a `.5` bps boundary (the
    normalized quotient would have to terminate at the 4th decimal), so the
    refusal branch is not expected here and its absence is asserted — a
    converter that refuses when it should not is as broken as one that rounds
    wrong, and "refuse-or-exact" alone would not notice.
    """
    rand = lcg(SEED)
    for iteration in range(20_000):
        raw = {bucket: rand() for bucket in BUCKETS}
        weights = convert(raw)
        total = sum(entry["weight_bps"] for entry in weights)
        assert total == DEN, f"seed={SEED} iteration={iteration} raw={raw} sums to {total}"
        assert [entry["bucket"] for entry in weights] == BUCKETS
        assert all(0 <= entry["weight_bps"] <= DEN for entry in weights)


def test_sparse_quantized_vectors_either_refuse_or_sum_exactly():
    """Sparse vectors — a third of the entries are hard zeros — quantized to 1e-5.

    Sparseness is the point: it generates the zero-last-bucket shape where the
    `final_rule` refusal actually lives (see the test below), alongside ordinary
    interior vectors. The property that must hold for every one of them is
    REFUSE-OR-EXACT: never a vector that converts to something other than
    exactly BPS_DENOMINATOR, because that is the vector
    RouterGovernance.propose reverts on.
    """
    rand = lcg(SEED + 1)
    refusals = 0
    converted = 0
    for iteration in range(20_000):
        raw = {}
        for bucket in BUCKETS:
            # A third of the entries are hard zeros so degenerate and sparse
            # vectors are generated, not just interior ones.
            value = 0 if rand() < 0.33 else round(rand(), 5)
            raw[bucket] = value
        if sum(raw.values()) <= 0:
            with pytest.raises(receipt.CanonicalizationError):
                convert(raw)
            continue
        try:
            weights = convert(raw)
        except receipt.CanonicalizationError:
            refusals += 1
            continue
        converted += 1
        total = sum(entry["weight_bps"] for entry in weights)
        assert total == DEN, f"seed={SEED + 1} iteration={iteration} raw={raw} sums to {total}"
        assert all(0 <= entry["weight_bps"] <= DEN for entry in weights)
    # A converter that refused everything would satisfy "refuse-or-exact"
    # vacuously. It must overwhelmingly convert.
    assert converted > 19_000, f"only {converted} of 20,000 sparse vectors converted"
    # And it must not refuse NOTHING either, or the refusal branch below would be
    # the only thing keeping `final_rule` honest.
    assert refusals > 0


# ── the degenerate cases a hand-picked example set never contains ─────────────


@pytest.mark.parametrize("held", BUCKETS)
def test_single_bucket_holds_everything(held):
    weights = convert({bucket: (1 if bucket == held else 0) for bucket in BUCKETS})
    assert {entry["bucket"]: entry["weight_bps"] for entry in weights} == {
        bucket: (DEN if bucket == held else 0) for bucket in BUCKETS
    }


def test_all_zeros_is_refused_not_zero_filled():
    """There is no allocation to convert, and inventing one would anchar a lie."""
    with pytest.raises(receipt.CanonicalizationError, match="totals zero"):
        convert({bucket: 0 for bucket in BUCKETS})


def test_a_negative_weight_is_refused():
    with pytest.raises(receipt.CanonicalizationError, match="negative"):
        convert({**{bucket: 1 for bucket in BUCKETS}, BUCKETS[0]: -0.1})


def test_an_equal_split_needs_no_settling():
    weights = convert({bucket: 1 for bucket in BUCKETS})
    assert [entry["weight_bps"] for entry in weights] == [DEN // len(BUCKETS)] * len(BUCKETS)


def test_a_near_tie_settles_its_residue_onto_the_last_bucket():
    """Thirds do not divide into 10,000, and the last entry absorbs what is left.

    The last bucket's true share here is 0 and its settled share is 1 bps. That
    is the rule working, not a defect: the alternative — leaving the vector 1
    bps short — is a proposal RouterGovernance.propose reverts.
    """
    raw = {bucket: 0 for bucket in BUCKETS}
    for bucket in BUCKETS[:-1]:
        raw[bucket] = 1
    weights = {entry["bucket"]: entry["weight_bps"] for entry in convert(raw)}
    assert weights[BUCKETS[-1]] == DEN - 3 * (DEN // 3)
    assert sum(weights.values()) == DEN


def test_rounding_is_half_up_and_not_half_even():
    """Exactly half a bps rounds UP. Half-even would send this to 0 and lose the dust."""
    raw = {bucket: 0 for bucket in BUCKETS}
    raw[BUCKETS[0]] = Decimal("0.00005")  # 0.5 bps exactly, in a ROUNDED prefix bucket
    raw[BUCKETS[-1]] = Decimal("0.99995")  # the settled bucket, which is never rounded
    weights = {entry["bucket"]: entry["weight_bps"] for entry in convert(raw)}
    assert weights[BUCKETS[0]] == 1
    assert sum(weights.values()) == DEN


def test_dust_below_half_a_bps_rounds_away_and_the_vector_still_sums():
    raw = {bucket: 0 for bucket in BUCKETS}
    raw[BUCKETS[0]] = Decimal("0.00004")  # 0.4 bps
    raw[BUCKETS[-1]] = Decimal("0.99996")
    weights = {entry["bucket"]: entry["weight_bps"] for entry in convert(raw)}
    assert weights[BUCKETS[0]] == 0
    assert sum(weights.values()) == DEN


def test_a_settled_last_bucket_below_zero_is_refused():
    """`final_rule`'s range check, executed rather than described.

    Three prefix buckets each rounding half up overshoot by 1 bps here, which
    would settle the last bucket to -1. There is no representation for this
    vector under the pinned rule, and a converter that clamped it to 0 would
    silently publish an allocation nobody voted for.
    """
    raw = {
        BUCKETS[0]: Decimal("0.33335"),
        BUCKETS[1]: Decimal("0.33335"),
        BUCKETS[2]: Decimal("0.3333"),
        BUCKETS[3]: Decimal("0"),
    }
    with pytest.raises(receipt.CanonicalizationError, match="outside 0"):
        receipt.mean_weights_to_bps(raw, SPEC, DEN)


def test_a_zero_last_bucket_is_where_the_final_rule_refusal_lives():
    """The measured cost of settling onto the POSITIONALLY last bucket.

    THE FINDING. When the last canonical bucket is exactly zero, the three
    prefix buckets carry the entire distribution and their true bps sum is
    exactly BPS_DENOMINATOR. Three independent nearest-integer roundings then sum
    to +1 bps roughly one time in eight, the settled last entry becomes -1, and
    the vector is REFUSED — it has no representation under the pinned rule.
    Give the last bucket any weight at all and the headroom absorbs the same
    roundings, and the refusal disappears entirely.

    WHY IT IS NOT HYPOTHETICAL. `real_world_assets` is last in
    canonical_bucket_order, and it is exactly 0 in four of the six archived
    allocations pinned in consensus-receipt.legacy-weights.json. Those four
    convert only because their means are whole bps (9500 / 500 / 0 / 0) with no
    rounding to accumulate. A genuine multi-analyst mean over thirds or sevenths
    with no RWA allocation is the 1-in-8 case.

    WHY THIS TEST AND NOT A FIX. `bps_conversion` is data in
    consensus-receipt.canonicalization.json, one of the nine fixtures held
    byte-identical to robotmoney-frontend. Changing the settle rule (to largest
    remainder, or to settling onto the largest-weight bucket rather than the
    last one) changes canonical bytes on both sides and is a coordinated schema
    event, tracked as robotmoney-core#1290. Until then the rate is PINNED here, so
    it cannot drift unnoticed and cannot be rediscovered from scratch.
    """
    def refusal_rate(zero_last: bool, seed: int, n: int = 8_000) -> tuple[int, int, int]:
        rand = lcg(seed)
        refused = converted = 0
        worst = 0
        for _ in range(n):
            raw = {bucket: round(rand(), 5) for bucket in BUCKETS}
            if zero_last:
                raw[BUCKETS[-1]] = 0
            if sum(raw.values()) <= 0:
                continue
            try:
                convert(raw)
                converted += 1
            except receipt.CanonicalizationError as exc:
                refused += 1
                worst = min(worst, int(str(exc).split(" is ")[1].split(" ")[0]))
        return refused, converted, worst

    zero_refused, zero_converted, worst = refusal_rate(True, SEED + 2)
    rate = zero_refused / (zero_refused + zero_converted)
    assert 0.09 <= rate <= 0.16, f"zero-last-bucket refusal rate moved to {rate:.4f}"
    # The overshoot is bounded at one bps: three roundings of at most half a bps
    # each cannot cost more, so nothing is ever off by more than 1.
    assert worst == -1, f"settled last bucket reached {worst} bps, not the expected floor of -1"

    nonzero_refused, nonzero_converted, _ = refusal_rate(False, SEED + 3)
    assert nonzero_refused == 0, (
        f"{nonzero_refused} of {nonzero_converted} vectors with a non-zero last bucket were refused; "
        "the refusal is supposed to be confined to the zero-last-bucket shape"
    )


def test_the_four_archived_zero_rwa_allocations_convert_because_their_means_are_whole_bps():
    """The reason the real corpus never hit the 1-in-8 case, stated as an assertion.

    If a future archived vector were added whose zero-RWA mean is NOT a whole
    number of bps, this is what would explain the refusal instead of it looking
    like a converter bug.
    """
    zero_last = [
        vector for vector in LEGACY["vectors"]
        if Decimal(str(vector["legacy_weights"][BUCKETS[-1]])) == 0
    ]
    assert len(zero_last) >= 4
    for vector in zero_last:
        normalized = receipt.normalize_weights(vector["legacy_weights"])
        for bucket, share in normalized.items():
            scaled = share * DEN
            assert scaled == scaled.to_integral_value(), (
                f"{vector['source']}: {bucket} is {scaled} bps, not a whole number — "
                "this vector is only safe from the final_rule refusal by luck"
            )


# ── the converter's contract ──────────────────────────────────────────────────


def test_an_unnormalized_mean_is_refused_rather_than_normalized_silently():
    """`bps_conversion.input` says the mean arrives already normalized.

    Normalizing inside the converter would invent a rule the other repo does not
    implement, so a vector that does not sum to 1 is a caller bug and is
    reported as one. `normalize_weights` is the explicit caller-side step.
    """
    with pytest.raises(receipt.CanonicalizationError, match="normalize before converting"):
        receipt.mean_weights_to_bps({bucket: Decimal("0.5") for bucket in BUCKETS}, SPEC, DEN)


def test_a_missing_or_unknown_bucket_is_refused():
    with pytest.raises(receipt.CanonicalizationError, match="omits canonical bucket"):
        convert({bucket: 1 for bucket in BUCKETS[:-1]})
    with pytest.raises(receipt.CanonicalizationError, match="non-canonical bucket"):
        convert({**{bucket: 1 for bucket in BUCKETS}, "stablecoins": 1})


def test_the_bucket_order_comes_out_of_the_spec_file():
    """Reverse the spec's order and the output must follow it.

    A converter that hard-coded the four names would return the identical vector
    for both specs, and would then agree with the golden no matter what the file
    the other repo implements from actually said.
    """
    reversed_spec = copy.deepcopy(SPEC)
    reversed_spec["canonical_bucket_order"] = list(reversed(BUCKETS))
    raw = {BUCKETS[0]: 0.4, BUCKETS[1]: 0.3, BUCKETS[2]: 0.2, BUCKETS[3]: 0.1}
    assert [e["bucket"] for e in receipt.float_vector_to_bps(raw, reversed_spec, DEN)] == list(reversed(BUCKETS))
    assert receipt.float_vector_to_bps(raw, reversed_spec, DEN) != convert(raw)


def test_a_float_is_read_through_its_decimal_text_not_its_binary_double():
    """0.05 in the archive means the two-place decimal, not 0.05000000000000000277…"""
    assert receipt._decimal(0.05, "x") == Decimal("0.05")
    assert receipt._decimal(0.05, "x") != Decimal(0.05)


# ── binding the converter to the pinned bytes ─────────────────────────────────


def test_the_pinned_receipt_reproduces_its_own_weights_through_this_converter():
    """The shipped path, plus a negative control.

    `semantic_errors` recomputes `weights` from the receipt's own signed
    submissions using this converter. Green here means the pinned golden and the
    converter agree; the perturbation proves that agreement is checked and not
    merely absent.
    """
    assert receipt.semantic_errors(VALID, SPEC, DEN) == []
    tampered = copy.deepcopy(VALID)
    tampered["weights"][0]["weight_bps"] += 1
    tampered["weights"][-1]["weight_bps"] -= 1  # still sums; only the derivation is wrong
    assert any("bps-converted signed mean" in error for error in receipt.semantic_errors(tampered, SPEC, DEN))


def test_the_converted_weights_are_the_bytes_the_golden_actually_carries():
    """AC1 tied to AC2: the conversion's output is what gets hashed and anchored."""
    serialized = receipt.compact_json(VALID["weights"])
    assert f'"weights":{serialized}' in GOLDEN


def test_the_archived_map_payloads_reconcile_and_lose_nothing_at_bucket_level():
    """Test-plan item 4, through the same code the CI guard runs.

    `legacy_errors` converts each archived map, compares against the recorded
    array, and round-trips the bucket set and the weights back within the pinned
    tolerance. Re-asserting it here keeps the archived corpus covered by the
    pytest suite as well as by the guard, without a second implementation.
    """
    import jsonschema

    validator = jsonschema.Draft7Validator(SCHEMA, format_checker=jsonschema.FormatChecker())
    assert receipt.legacy_errors(LEGACY, SPEC, SCHEMA, DEN, VALID, validator) == []
    assert len(LEGACY["vectors"]) >= 6


# ── the append-only rule, as a regression rather than a promise ───────────────


def test_appending_a_new_optional_field_does_not_move_a_byte_of_a_payload_that_omits_it():
    """Test-plan item 3, and the property every published signature depends on.

    A field appended to the END of an object under `evolution_rule` must be
    invisible in the canonical bytes of a receipt that does not carry it. The
    test appends TWO — one at the root and one inside `judge`, which is where
    `fallbackReason` and `model` are already earmarked to land after `source` —
    and asserts both goldens are byte-identical to what the unextended spec
    produces.

    Signature validity follows and is asserted directly: analyst signatures are
    over each entry's own `canonical_submission`, never over the receipt, so a
    receipt-level append cannot reach them. That is the reason the append-only
    rule is cheap here, and it is worth pinning that it stays true.
    """
    extended = copy.deepcopy(SPEC)
    extended["field_order"] = list(SPEC["field_order"]) + ["settlement_hint"]
    extended["nested_field_order"]["judge"] = list(SPEC["nested_field_order"]["judge"]) + ["fallback_reason"]
    extended["optional_append_only_fields"] = list(SPEC["optional_append_only_fields"]) + [
        "settlement_hint",
        "fallback_reason",
    ]

    for payload in (VALID, VALID_NO_WEIGHTS):
        before = receipt.canonicalize_receipt(payload, SPEC)
        after = receipt.canonicalize_receipt(payload, extended)
        assert after == before
        assert "settlement_hint" not in after
        assert "fallback_reason" not in after

    assert receipt.canonicalize_receipt(VALID, extended) == GOLDEN
    assert receipt.signature_errors(VALID, "valid") == []


def test_a_field_inserted_rather_than_appended_does_move_the_bytes():
    """The negative control for the test above — the rule is append-only, not add-anywhere."""
    inserted = copy.deepcopy(SPEC)
    order = list(SPEC["field_order"])
    inserted["field_order"] = order[:1] + ["settlement_hint"] + order[1:]
    inserted["optional_append_only_fields"] = list(SPEC["optional_append_only_fields"]) + ["settlement_hint"]
    payload = copy.deepcopy(VALID)
    payload["settlement_hint"] = "x"
    assert receipt.canonicalize_receipt(payload, inserted) != GOLDEN
