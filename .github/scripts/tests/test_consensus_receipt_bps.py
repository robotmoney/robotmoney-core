"""Property tests for the pinned float → bps conversion (issues #1246, #1290).

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

WHAT #1290 CHANGED, AND WHAT THIS FILE NOW ASSERTS INSTEAD

Schema 1.0 shipped *settle-the-last-entry*: round the first three canonical
buckets to nearest and set `real_world_assets` to `BPS_DENOMINATOR − prefix_sum`,
REFUSING a result outside `0..BPS_DENOMINATOR`. When `real_world_assets` is
exactly zero the three prefix buckets carry the whole distribution, three
independent roundings sum to `+1` bps about ONE TIME IN EIGHT, the settled entry
becomes `−1`, and the vector had NO REPRESENTATION — no receipt could be
assembled for that session. `real_world_assets` is zero in four of the six real
archived allocations, so the refusal sat on the committee's commonest shape.

The replacement is LARGEST REMAINDER (Hare quota) in IEEE-754 binary64, with the
exact-tie break pinned to canonical bucket order. The old file PINNED THE
REFUSAL RATE with a passing test; this one asserts the property that rate used to
make impossible: **every non-degenerate vector converts, and sums to exactly
`BPS_DENOMINATOR`.** There is no refuse-or-exact escape hatch left anywhere in
this file — the only refusals asserted are of inputs that are not share vectors.

THREE THINGS HERE ARE CROSS-REPO CONFORMANCE, NOT LOCAL CORRECTNESS

1. `test_the_published_cross_repo_tie_break_vectors_reproduce_exactly` converts
   the four exact-tie vectors robotmoney-frontend published on #1290 from its own
   CI, and asserts this repo's Python returns the identical arrays. That is the
   meeting point the two implementations were dug towards from opposite ends; a
   disagreement here is the conformance bug both repos were warned to expect.
2. `test_the_specs_divergent_example_proves_the_arithmetic_is_binary64` converts
   the self-test vector the spec ships FOR THIS PURPOSE. Decimal or rational
   recomputation of the same prose returns a different, wrong array.
3. `test_the_six_archived_vectors_do_not_move_under_the_new_rule` recomputes the
   SUPERSEDED rule inside the test and asserts both rules agree on all six real
   archived allocations — the rule change moves no already-settled data.

WHY PROPERTIES AND NOT THREE EXAMPLES. The claim is universal — "the output
sums to exactly BPS_DENOMINATOR" — so it is exercised over generated vectors,
including the degenerate ones a hand-picked example set never contains: a single
bucket holding everything, zeros, dust below a bps, and the exact-tie remainders
that stable sorting alone does not decide. The PRNG is seeded, so a failure is
reproducible from the printed seed rather than "it went red once in CI".
"""

from __future__ import annotations

import copy
import json
import math
import sys
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
CONVERSION = SPEC["bps_conversion"]
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


def bps_of(raw: dict) -> list[int]:
    return [entry["weight_bps"] for entry in convert(raw)]


def vector(values: list[float]) -> dict[str, float]:
    """A share vector written positionally over canonical_bucket_order."""
    assert len(values) == len(BUCKETS)
    return dict(zip(BUCKETS, values))


def superseded_settle_the_last(mean: dict[str, float]) -> list[int] | None:
    """SCHEMA 1.0's rule, recomputed here rather than transcribed.

    Round each canonical bucket except the last half-up; set the last to
    `DEN − prefix_sum`; return None where the old rule REFUSED, which is exactly
    the defect #1290 removed. Used by two tests: the one that proves the archived
    corpus does not move, and the one that proves the refusal is gone.
    """
    prefix = [math.floor(mean[bucket] * DEN + 0.5) for bucket in BUCKETS[:-1]]
    final = DEN - sum(prefix)
    if not 0 <= final <= DEN:
        return None
    return prefix + [final]


# ── the spec this file is a reader of ─────────────────────────────────────────


def test_the_denominator_and_bucket_order_are_read_not_typed():
    """If either were hard-coded here the tests below would prove nothing about the spec."""
    assert DEN == SCHEMA["definitions"]["bucket_weight"]["properties"]["weight_bps"]["maximum"]
    assert BUCKETS == SPEC["canonical_bucket_order"]
    assert len(BUCKETS) >= 2


def test_the_shared_spec_states_the_rule_this_module_implements():
    """The pin is the FIXTURE, so the fixture is asserted to still carry the rule.

    `bps_conversion` is data in `consensus-receipt.canonicalization.json`, one of
    the nine files held byte-identical to robotmoney-frontend's
    `contract/src/__fixtures__/`. If a future edit reverted the rule there while
    leaving this implementation alone, every other test in this file would still
    pass — they would simply be testing a rule the shared spec no longer states.
    """
    assert CONVERSION["rule"].startswith("LARGEST REMAINDER")
    assert "floor, never nearest" in CONVERSION["floor_rule"]
    assert CONVERSION["tie_break"].startswith("CANONICAL BUCKET ORDER")
    assert "BINARY64" in CONVERSION["arithmetic_domain"]
    assert "never refuses a vector whose last bucket is zero" in CONVERSION["refusal"]
    assert "divergent_example" in CONVERSION and "negative_dust_clamp" in CONVERSION
    # And the one number the implementation restates rather than reads.
    assert receipt.spec_states_share_sum_tolerance(SPEC)


# ── the universal property: EVERY vector converts ─────────────────────────────


def test_continuous_random_vectors_always_sum_to_the_denominator():
    """20,000 uniform [0,1] vectors: every one converts, every one sums exactly."""
    rand = lcg(SEED)
    for iteration in range(20_000):
        raw = {bucket: rand() for bucket in BUCKETS}
        weights = convert(raw)
        total = sum(entry["weight_bps"] for entry in weights)
        assert total == DEN, f"seed={SEED} iteration={iteration} raw={raw} sums to {total}"
        assert [entry["bucket"] for entry in weights] == BUCKETS
        assert all(0 <= entry["weight_bps"] <= DEN for entry in weights)


def test_sparse_quantized_vectors_all_convert_and_sum_exactly():
    """Sparse vectors — a third of the entries are hard zeros — quantized to 1e-5.

    Sparseness is the point: it generates the zero-last-bucket shape where the
    superseded rule's refusal lived. The property is no longer "refuse or exact".
    It is CONVERT AND EXACT, with no escape hatch: a `CanonicalizationError` from
    a well-formed share vector fails this test outright rather than being counted.
    """
    rand = lcg(SEED + 1)
    converted = 0
    for iteration in range(20_000):
        raw = {}
        for bucket in BUCKETS:
            # A third of the entries are hard zeros so degenerate and sparse
            # vectors are generated, not just interior ones.
            raw[bucket] = 0 if rand() < 0.33 else round(rand(), 5)
        if sum(raw.values()) <= 0:
            with pytest.raises(receipt.CanonicalizationError):
                convert(raw)
            continue
        weights = convert(raw)  # NOT wrapped in try/except — refusing is a failure
        converted += 1
        total = sum(entry["weight_bps"] for entry in weights)
        assert total == DEN, f"seed={SEED + 1} iteration={iteration} raw={raw} sums to {total}"
        assert all(0 <= entry["weight_bps"] <= DEN for entry in weights)
    assert converted > 19_000, f"only {converted} of 20,000 sparse vectors converted"


@pytest.mark.parametrize("zeroed", range(4))
def test_every_bucket_can_be_the_zero_one_and_nothing_refuses(zeroed):
    """The positional dependence is gone, asserted at every position.

    The superseded rule refused ~1 in 8 vectors when the LAST bucket was zero and
    0% otherwise — a defect whose rate depended on WHERE the zero sat. 8,000
    vectors per position, all four positions, zero refusals.
    """
    rand = lcg(SEED + 10 + zeroed)
    for iteration in range(8_000):
        raw = {bucket: round(rand(), 5) for bucket in BUCKETS}
        raw[BUCKETS[zeroed]] = 0
        if sum(raw.values()) <= 0:
            continue
        weights = convert(raw)
        assert sum(e["weight_bps"] for e in weights) == DEN, (
            f"zeroed={BUCKETS[zeroed]} iteration={iteration} raw={raw}"
        )


def test_the_zero_last_bucket_corpus_that_measured_twelve_percent_refused_now_measures_zero():
    """THE ISSUE'S HEADLINE MEASUREMENT, RE-RUN AGAINST BOTH RULES.

    The same seeded corpus, converted twice: once through the superseded rule
    recomputed in this file, once through the shipped one. The old rule must
    still refuse ~1 in 8 (if it does not, the corpus stopped reproducing the
    defect and this test proves nothing); the new rule must refuse NONE.

    That side-by-side is the point. Asserting only "0% today" would stay green if
    the corpus drifted to vectors the old rule never refused either.
    """
    rand = lcg(SEED + 2)
    old_refused = new_refused = sampled = 0
    for _ in range(20_000):
        raw = {bucket: round(rand(), 5) for bucket in BUCKETS}
        raw[BUCKETS[-1]] = 0
        if sum(raw.values()) <= 0:
            continue
        sampled += 1
        normalized = receipt.normalize_weights(raw)
        if superseded_settle_the_last(normalized) is None:
            old_refused += 1
        try:
            weights = receipt.mean_weights_to_bps(normalized, SPEC, DEN)
        except receipt.CanonicalizationError:
            new_refused += 1
            continue
        assert sum(e["weight_bps"] for e in weights) == DEN

    old_rate = old_refused / sampled
    assert 0.09 <= old_rate <= 0.16, (
        f"the superseded rule refused {old_rate:.4f} of this corpus, not ~12.5% — the corpus no "
        "longer reproduces the defect, so the 0% below would not mean anything"
    )
    assert new_refused == 0, (
        f"{new_refused} of {sampled} zero-last-bucket vectors were refused; largest remainder "
        "closes on the denominator by construction and must never refuse a share vector"
    )


# ── the exact-tie break: the part that silently diverges between repos ────────

# Published by robotmoney-frontend on robotmoney-core#1290 from its own CI, as the
# conformance target for this side. Copied as data, converted here, compared.
# `1/3` is written as the division so both repos hold the identical binary64
# double rather than a transcribed decimal that rounds somewhere else.
THIRD = 1.0 / 3.0
PUBLISHED_TIE_VECTORS = [
    ([THIRD, THIRD, THIRD, 0.0], [3334, 3333, 3333, 0], "3-way exact tie, 1 bp left; index 0 wins"),
    ([0.0, THIRD, THIRD, THIRD], [0, 3334, 3333, 3333], "same tie, zero moved; index 1 wins"),
    ([0.100045, 0.100045, 0.5, 0.29991], [1001, 1000, 5000, 2999], "2-way exact tie at indices 0,1"),
    ([0.5, 0.29991, 0.100045, 0.100045], [5000, 2999, 1001, 1000], "mirrored: index 2 wins, 3 does not"),
]


@pytest.mark.parametrize("shares,expected,why", PUBLISHED_TIE_VECTORS)
def test_the_published_cross_repo_tie_break_vectors_reproduce_exactly(shares, expected, why):
    """THE MEETING POINT. Two implementations, one survey, checked against each other.

    Largest remainder is under-specified on an exact tie, and the tie-break
    changes canonical bytes and therefore the anchored keccak256. Both repos were
    warned that "two implementations that each pass their own tests and disagree
    only on an exact tie" is the likeliest way this schema event goes wrong. These
    are robotmoney-frontend's published outputs; this asserts core agrees.

    Row 2 is why the rule is "earliest bucket" and not "first entry" or "largest
    bucket": moving the zero to index 0 moves the bp to index 1.
    """
    produced = bps_of(vector(shares))
    assert produced == expected, f"{why}: core produced {produced}, frontend published {expected}"
    assert sum(produced) == DEN


def test_the_tie_break_is_the_rule_and_not_the_sort_implementation():
    """Reverse the spec's bucket order and the leftover bp must move with it.

    A converter that got the right answer from `sorted`'s stability over an array
    it happened to build in canonical order would pass every row above and fail
    this. Python's `sorted` and JavaScript's `Array.prototype.sort` are both
    stable, but they are handed independently-constructed arrays, so stability
    guarantees nothing about agreement between the two repos.
    """
    tie = vector([THIRD, THIRD, THIRD, 0.0])
    reversed_spec = copy.deepcopy(SPEC)
    reversed_spec["canonical_bucket_order"] = list(reversed(BUCKETS))

    forward = {e["bucket"]: e["weight_bps"] for e in receipt.mean_weights_to_bps(tie, SPEC, DEN)}
    backward = {
        e["bucket"]: e["weight_bps"] for e in receipt.mean_weights_to_bps(tie, reversed_spec, DEN)
    }
    assert forward[BUCKETS[0]] == 3334 and forward[BUCKETS[2]] == 3333
    # Under the reversed order, BUCKETS[2] is the earliest of the three tied
    # buckets, so it takes the bp and BUCKETS[0] does not.
    assert backward[BUCKETS[2]] == 3334 and backward[BUCKETS[0]] == 3333


def test_a_one_ulp_difference_is_not_a_tie_and_the_larger_remainder_simply_wins():
    """`tie_break` fires ONLY on bitwise-equal binary64 remainders.

    Nudging one of two tied shares by a single ULP must hand the bp to the larger
    remainder regardless of position — an implementation that tie-broke on
    "approximately equal" would keep giving it to the earlier bucket.
    """
    nudged = math.nextafter(0.100045, 1.0)
    # index 1 now holds the strictly larger share, so it takes the bp instead of index 0
    produced = bps_of(vector([0.100045, nudged, 0.5, 0.29991 - (nudged - 0.100045)]))
    assert produced[1] == 1001 and produced[0] == 1000
    assert sum(produced) == DEN


# ── the arithmetic domain, proved rather than described ───────────────────────


def test_the_specs_divergent_example_proves_the_arithmetic_is_binary64():
    """The self-test `bps_conversion.divergent_example` ships FOR THIS PURPOSE.

    Two buckets' shares both end `.6132`. In DECIMAL their remainders are exactly
    equal, the tie-break fires, and canonical order awards the bp to
    `conservative_defi_yield`. In BINARY64 they are 0.6131999999997788 and
    0.6132000000000062 — one ULP-scale apart, no tie, and `real_world_assets`
    takes it outright. Same prose, same input, two different signed artifacts.

    Python's `Decimal` is exactly the instinct `arithmetic_domain` forbids by
    name, and the schema-1.0 implementation here used it. This converts the
    vector and asserts the binary64 answer AND, explicitly, not the decimal one.
    """
    example = CONVERSION["divergent_example"]
    produced = bps_of(example["shares"])
    assert produced == example["bps_binary64"]
    assert produced != example["bps_decimal_WRONG"]
    assert sum(produced) == DEN


def test_a_share_is_read_as_the_binary64_double_and_not_through_its_decimal_text():
    """`_share` is the domain boundary, and it is the opposite of what 1.0 did."""
    assert receipt._share(0.05, "x") == 0.05
    assert isinstance(receipt._share(0.05, "x"), float)
    with pytest.raises(receipt.CanonicalizationError, match="not a number"):
        receipt._share("0.05", "x")
    with pytest.raises(receipt.CanonicalizationError, match="not a finite number"):
        receipt._share(float("inf"), "x")


# ── negative settle dust: absorbed, not authored, and not refused ─────────────


def test_the_producers_negative_settle_dust_is_floored_rather_than_refused():
    """`negative_dust_clamp`, executed on the value the producer actually emits.

    `meanTakeWeights` settles its positionally last entry to `round(1 − prefix, 8)`,
    which lands on exactly `−1e-8` for ~12.4% of zero-RWA sessions. Refusing it
    would reintroduce the defect largest remainder was adopted to remove, as an
    unnamed internal error rather than a named refusal.
    """
    mean = vector([THIRD, THIRD, 1.0 - THIRD - THIRD + 1e-8, -1e-8])
    weights = receipt.mean_weights_to_bps(mean, SPEC, DEN)
    assert sum(e["weight_bps"] for e in weights) == DEN
    assert weights[-1]["weight_bps"] == 0


def test_negative_zero_is_accepted_and_converts_to_a_plain_zero_weight():
    """The producer emits `-0.0`, and it must convert rather than trip anything.

    HONEST SCOPE. `negative_dust_clamp` requires the clamp be written `> 0` and
    not `< 0` because `-0 < 0` is FALSE in IEEE-754, so a `< 0` clamp lets `-0`
    through, `Math.floor(-0 * 10000)` is `-0`, and JavaScript returns an integer
    `-0`. That hazard is REAL on the frontend and NOT reproducible here: Python's
    `math.floor` returns an `int`, and there is no negative zero integer. So this
    test asserts what it can honestly assert on this side — `-0.0` is accepted as
    a share, converts to a plain `0`, and the vector still closes. The `> 0` form
    is written into `mean_weights_to_bps` for cross-repo parity with the clause,
    not because Python needs it.
    """
    mean = vector([0.25, 0.25, 0.5, -0.0])
    weights = receipt.mean_weights_to_bps(mean, SPEC, DEN)
    assert weights[-1]["weight_bps"] == 0
    assert isinstance(weights[-1]["weight_bps"], int)
    assert sum(e["weight_bps"] for e in weights) == DEN


def test_a_share_more_negative_than_the_tolerance_is_still_refused_by_name():
    """The clamp is dust absorption, not a licence to author a negative allocation."""
    mean = vector([0.4, 0.4, 0.2 + 1e-3, -1e-3])
    with pytest.raises(receipt.CanonicalizationError, match="settle dust"):
        receipt.mean_weights_to_bps(mean, SPEC, DEN)


def test_a_share_above_one_is_refused():
    mean = vector([1.5, 0.0, 0.0, -0.5])
    with pytest.raises(receipt.CanonicalizationError, match="share in 0..1"):
        receipt.mean_weights_to_bps(mean, SPEC, DEN)


# ── the degenerate cases a hand-picked example set never contains ─────────────


@pytest.mark.parametrize("held", BUCKETS)
def test_single_bucket_holds_everything(held):
    weights = convert({bucket: (1 if bucket == held else 0) for bucket in BUCKETS})
    assert {entry["bucket"]: entry["weight_bps"] for entry in weights} == {
        bucket: (DEN if bucket == held else 0) for bucket in BUCKETS
    }


def test_all_zeros_is_refused_not_zero_filled():
    """There is no allocation to convert, and inventing one would anchor a lie."""
    with pytest.raises(receipt.CanonicalizationError, match="totals zero"):
        convert({bucket: 0 for bucket in BUCKETS})


def test_a_negative_weight_is_refused():
    with pytest.raises(receipt.CanonicalizationError, match="negative"):
        convert({**{bucket: 1 for bucket in BUCKETS}, BUCKETS[0]: -0.1})


def test_an_equal_split_needs_no_apportionment():
    weights = convert({bucket: 1 for bucket in BUCKETS})
    assert [entry["weight_bps"] for entry in weights] == [DEN // len(BUCKETS)] * len(BUCKETS)


def test_the_leftover_goes_to_a_remainder_holder_and_never_to_a_zeroed_bucket():
    """THE DEFECT'S OTHER SIGN, and the reason this is not merely a refusal fix.

    Under settle-the-last, a prefix that UNDERSHOT silently handed 1 bp to
    `real_world_assets` — a vault the session had allocated nothing to. That is a
    WRONG receipt rather than no receipt, and it tripped no range check
    (robotmoney-frontend measured 12.44% on the same corpus). Largest remainder
    cannot do it: a bucket whose share is 0 has remainder 0, so it is last in the
    apportionment order and only ever reached if the leftover exceeds the number
    of buckets with a non-zero remainder — which cannot happen for a share vector.
    """
    raw = {bucket: 0 for bucket in BUCKETS}
    for bucket in BUCKETS[:-1]:
        raw[bucket] = 1
    weights = {entry["bucket"]: entry["weight_bps"] for entry in convert(raw)}
    assert weights[BUCKETS[-1]] == 0, "a bucket the session zeroed was handed a basis point"
    assert sorted(weights[b] for b in BUCKETS[:-1]) == [3333, 3333, 3334]
    assert sum(weights.values()) == DEN

    # And the same, measured: over the zero-last-bucket corpus, the zeroed bucket
    # never receives a bp. This is the row robotmoney-frontend asked to be added.
    rand = lcg(SEED + 20)
    strays = sampled = 0
    for _ in range(10_000):
        candidate = {bucket: round(rand(), 5) for bucket in BUCKETS}
        candidate[BUCKETS[-1]] = 0
        if sum(candidate.values()) <= 0:
            continue
        sampled += 1
        if bps_of(candidate)[-1] != 0:
            strays += 1
    assert sampled > 9_000
    assert strays == 0, f"{strays} of {sampled} zero-RWA vectors were handed a stray bp"


def test_flooring_is_floor_and_not_nearest():
    """`floor_rule` says floor, never nearest — 0.9 bps of a bucket floors to 0.

    Under the superseded nearest-rounding this bucket took 1 bp outright. Here it
    floors to 0 and then wins the leftover back on remainder, which is a different
    mechanism reaching a similar place — so the assertion is on the FLOOR itself,
    where the two rules genuinely differ.
    """
    raw = vector([0.00009, 0.00004, 0.5, 0.49987])
    floors = [math.floor(share * DEN) for share in raw.values()]
    assert floors == [0, 0, 5000, 4998]
    produced = bps_of(raw)
    assert sum(produced) == DEN
    # Two bps are left over; they go to the two largest remainders (.9 and .87),
    # not to the two buckets nearest-rounding would have picked.
    assert produced == [1, 0, 5000, 4999]


# ── the archived corpus does not move ─────────────────────────────────────────


def test_the_six_archived_vectors_do_not_move_under_the_new_rule():
    """"The rule change moves no already-settled data", executed on both rules.

    The superseded rule is RECOMPUTED here rather than transcribed, and its output
    is compared entry for entry against the shipped rule's, for all six real
    archived allocations. Their means are whole bps, so there is nothing to
    redistribute and the two rules must agree exactly. If a future archived vector
    is added whose mean is not whole-bps, this is what would name the difference.
    """
    assert len(LEGACY["vectors"]) >= 6
    for entry in LEGACY["vectors"]:
        normalized = receipt.normalize_weights(entry["legacy_weights"])
        old = superseded_settle_the_last(normalized)
        new = [w["weight_bps"] for w in receipt.mean_weights_to_bps(normalized, SPEC, DEN)]
        assert old is not None, f"{entry['source']}: the superseded rule refused an archived vector"
        assert new == old, f"{entry['source']}: settled data moved — was {old}, now {new}"
        # And the fixture's own recorded array, which is the committed pin.
        assert new == [w["weight_bps"] for w in entry["canonical_weights"]]
        assert sum(new) == DEN


def test_the_four_archived_zero_rwa_allocations_have_whole_bps_means():
    """The reason the real corpus never hit the 1-in-8 case, kept as an assertion.

    Still worth pinning after the fix: it is the premise of the test above. If a
    future archived vector's zero-RWA mean is NOT whole-bps, the two rules can
    diverge on it, and this names why rather than leaving it to look like a bug.
    """
    zero_last = [v for v in LEGACY["vectors"] if float(v["legacy_weights"][BUCKETS[-1]]) == 0]
    assert len(zero_last) >= 4
    for entry in zero_last:
        for bucket, share in receipt.normalize_weights(entry["legacy_weights"]).items():
            scaled = share * DEN
            assert scaled == math.floor(scaled), (
                f"{entry['source']}: {bucket} is {scaled} bps, not a whole number"
            )


# ── the converter's contract ──────────────────────────────────────────────────


def test_an_unnormalized_mean_is_refused_rather_than_normalized_silently():
    """`bps_conversion.input` says the mean arrives already normalized.

    Normalizing inside the converter would invent a rule the other repo does not
    implement, so a vector that does not sum to 1 is a caller bug and is reported
    as one. `normalize_weights` is the explicit caller-side step.
    """
    with pytest.raises(receipt.CanonicalizationError, match="not 1 — normalize before converting"):
        receipt.mean_weights_to_bps({bucket: 0.5 for bucket in BUCKETS}, SPEC, DEN)


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
    assert [e["bucket"] for e in receipt.float_vector_to_bps(raw, reversed_spec, DEN)] == list(
        reversed(BUCKETS)
    )
    assert receipt.float_vector_to_bps(raw, reversed_spec, DEN) != convert(raw)


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


def test_the_rule_change_did_not_move_the_anchored_digest():
    """`bps_conversion` is a DERIVATION rule, not a serialization rule.

    The receipt bytes are untouched by #1290, so the keccak256 an anchor commits
    to must be exactly what it was. This reads the golden and re-derives it rather
    than trusting the constant, which is the #1280 discipline.
    """
    anchor = receipt.load_json(receipt.ANCHOR_DIGEST_PATH)
    pinned = {row["file"]: row for row in anchor["goldens"]}
    assert receipt.canonicalize_receipt(VALID, SPEC) == GOLDEN
    assert len(GOLDEN.encode("utf-8")) == pinned["consensus-receipt.valid.canonical.txt"]["byte_length"]


def test_the_shared_fixture_manifest_still_matches_every_file_on_disk():
    """AC5: the cross-repo pin, re-hashed. The canonicalization fixture MOVED here.

    `consensus-receipt.canonicalization.json` is the one file #1290 changes, and
    it was changed by ADOPTING robotmoney-frontend's already-published bytes
    rather than by editing this side's copy. Its manifest row must have moved with
    it, and the other eight must not have.
    """
    anchor = receipt.load_json(receipt.ANCHOR_DIGEST_PATH)
    assert receipt.shared_manifest_errors(anchor) == []
    rows = {row["file"]: row for row in anchor["shared_fixture_manifest"]["files"]}
    assert set(rows) == set(receipt.SHARED_WITH_FRONTEND)
    canon = rows["consensus-receipt.canonicalization.json"]
    assert canon["byte_length"] == receipt.CANONICALIZATION_PATH.stat().st_size


def test_the_archived_map_payloads_reconcile_and_lose_nothing_at_bucket_level():
    """Test-plan item 4, through the same code the CI guard runs."""
    import jsonschema

    validator = jsonschema.Draft7Validator(SCHEMA, format_checker=jsonschema.FormatChecker())
    assert receipt.legacy_errors(LEGACY, SPEC, SCHEMA, DEN, VALID, validator) == []
    assert len(LEGACY["vectors"]) >= 6


# ── the append-only rule, as a regression rather than a promise ───────────────


def test_appending_a_new_optional_field_does_not_move_a_byte_of_a_payload_that_omits_it():
    """Test-plan item 3, and the property every published signature depends on."""
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
