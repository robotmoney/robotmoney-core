#!/usr/bin/env python3
"""Upgradeable storage-layout gate (ADR-0014 §8).

Canonical: docs/adr/ADR-0014-governed-upgrades-and-freeze.md §8 (the storage-layout tool and its CI job).
Driven by scripts/ci/check-storage-layout.sh; see its header for usage.

For every contract named in contracts/test/fixtures/storage-layout/proxied.txt, the gate builds a
normalized layout record from `forge inspect` (after `forge build`):

  storage        label, slot, offset, bytes, type label and defining contract of every state variable
                 (type labels keep their defining contract, e.g. `struct BasketAssetConfigGuard.AssetInfo[]`)
  structs        the members of every storage struct, keyed by the struct's label
  linearization  the ordered inheritance list (`forge inspect <C> linearization`)
  libraries      every linked library, recursively, with keccak256 of its deployedBytecode in out/
  openzeppelin   the gitlink commits of lib/openzeppelin-contracts and lib/openzeppelin-contracts-upgradeable

and compares it with the committed snapshot contracts/test/fixtures/storage-layout/<C>.json. A snapshot
is the layout of the implementation live on the release chain; `--write` rewrites it when a release
deploys a new implementation. Rules, all of which fail the gate:

  - an existing variable moves, changes type, offset or size, or disappears;
  - a new variable sits anywhere but after the last existing one, except inside a storage gap
    (`__gap`) that shrinks by exactly the slots the new variables take, end-aligned;
  - any storage struct changes at all (a new field needs a new struct in a new mapping);
  - the linearization differs in any way, including order;
  - `GovernedUpgrade` is missing from a proxied contract's linearization;
  - a linked library is added, removed, or has different code;
  - an OpenZeppelin submodule commit differs;
  - a production contract (under contracts/, outside contracts/test and contracts/script) inherits
    `GovernedUpgrade` but is not listed in proxied.txt, a listed name does not inherit it, or a listed
    name is missing from the ADR-0014 §1 table;
  - a production function declares `reinitializer(n)` without `onlyUpgradeAuthority` in the same header
    (ADR-0014 §3: a reinitializer runs only as the `data` of a timelock-executed `upgradeToAndCall`; an
    upgrade installed with empty data would otherwise leave it callable by anyone).

Exit codes: 0 pass; 1 a rule failed; 2 tooling or input error.
"""

from __future__ import annotations

import copy
import json
import os
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = REPO_ROOT / "contracts" / "test" / "fixtures" / "storage-layout"
PROXIED_LIST = FIXTURES / "proxied.txt"
ADR = REPO_ROOT / "docs" / "adr" / "ADR-0014-governed-upgrades-and-freeze.md"
OUT_DIR = REPO_ROOT / "out"
FORGE = os.environ.get("FORGE", "forge")
CAST = os.environ.get("CAST", "cast")
OZ_SUBMODULES = ("lib/openzeppelin-contracts", "lib/openzeppelin-contracts-upgradeable")
BASE = "GovernedUpgrade"
GAP = "__gap"


class ToolError(Exception):
    """A tooling or input failure (exit 2), as opposed to a rule failure (exit 1)."""


def _run(args: list[str]) -> str:
    try:
        res = subprocess.run(
            args, cwd=REPO_ROOT, capture_output=True, text=True, check=False, timeout=900
        )
    except FileNotFoundError as e:
        raise ToolError(f"{args[0]} not found: {e}") from e
    if res.returncode != 0:
        raise ToolError(f"`{' '.join(args)}` failed:\n{res.stderr.strip()}")
    return res.stdout


def _inspect(contract: str, field: str):
    return json.loads(_run([FORGE, "inspect", contract, field, "--json"]))


def _slots(nbytes: int) -> int:
    return max(1, (nbytes + 31) // 32)


def _code_id(code: str) -> str:
    """keccak256 of a library's unlinked deployedBytecode text. Hashing the text keeps the
    `__$...$__` link placeholders, so a library that links a different library hashes differently."""
    return _run([CAST, "keccak", "bytecode:" + code]).strip()


def _artifact_code(qualified: str) -> str:
    """deployedBytecode of `path/File.sol:Name` from out/ (unlinked placeholders kept as-is)."""
    path, name = qualified.rsplit(":", 1)
    artifact = OUT_DIR / Path(path).name / f"{name}.json"
    if not artifact.is_file():
        raise ToolError(f"artifact {artifact} missing: run `forge build` first")
    obj = json.loads(artifact.read_text())["deployedBytecode"]["object"]
    return obj if obj.startswith("0x") else "0x" + obj


def _libraries(contract: str, seen: dict[str, str] | None = None) -> dict[str, str]:
    """Every linked library of `contract`, recursively, with the keccak256 of its code."""
    seen = {} if seen is None else seen
    for lib in _inspect(contract, "libraries"):
        if lib in seen:
            continue
        seen[lib] = _code_id(_artifact_code(lib))
        _libraries(lib, seen)
    return dict(sorted(seen.items()))


def _oz_commits() -> dict[str, str]:
    out = {}
    for sub in OZ_SUBMODULES:
        line = _run(["git", "ls-files", "--stage", "--", sub]).strip()
        m = re.match(r"^160000 ([0-9a-f]{40}) ", line)
        if not m:
            raise ToolError(f"{sub} is not a gitlink in the index (git ls-files --stage)")
        out[sub] = m.group(1)
    return out


def normalize(contract: str) -> dict:
    """The live normalized layout record of `contract`."""
    layout = _inspect(contract, "storageLayout")
    types = layout.get("types") or {}

    def tlabel(tid: str) -> str:
        return types.get(tid, {}).get("label", tid)

    def tbytes(tid: str) -> int:
        return int(types.get(tid, {}).get("numberOfBytes", "32"))

    def row(e: dict) -> dict:
        return {
            "contract": e.get("contract", ""),
            "label": e["label"],
            "slot": int(e["slot"]),
            "offset": int(e["offset"]),
            "bytes": tbytes(e["type"]),
            "type": tlabel(e["type"]),
        }

    structs = {}
    for t in types.values():
        if t.get("members"):
            members = [
                {
                    "label": m["label"],
                    "slot": int(m["slot"]),
                    "offset": int(m["offset"]),
                    "type": tlabel(m["type"]),
                }
                for m in t["members"]
            ]
            structs[t["label"]] = members
    lin = [f'{x["source"]}:{x["contract"]}' for x in _inspect(contract, "linearization")]
    return {
        "contract": contract,
        "storage": [row(e) for e in layout.get("storage", [])],
        "structs": dict(sorted(structs.items())),
        "linearization": lin,
        "libraries": _libraries(contract),
        "openzeppelin": _oz_commits(),
    }


def _keyed(rows: list[dict]) -> dict[tuple[str, int], dict]:
    """Rows keyed by (label, occurrence). `forge inspect` names the inspected contract, not the
    declaring base, so two bases' `__gap` share a label; their order in the layout tells them apart."""
    seen: dict[str, int] = {}
    out = {}
    for r in rows:
        n = seen.get(r["label"], 0)
        seen[r["label"]] = n + 1
        out[(r["label"], n)] = r
    return out


def compare(old: dict, live: dict) -> list[str]:
    """Rule violations of `live` against the committed snapshot `old` (empty means pass)."""
    v: list[str] = []
    name = live.get("contract", "?")
    old_rows = _keyed(old["storage"])
    live_rows = _keyed(live["storage"])
    show = lambda k: k[0] if k[1] == 0 else f"{k[0]}#{k[1]}"  # noqa: E731

    old_end = max((r["slot"] + _slots(r["bytes"]) for r in old["storage"]), default=0)
    gap_room: list[tuple[int, int]] = []  # [first slot, end slot) a gap gave up

    for k, o in old_rows.items():
        n = live_rows.get(k)
        if o["label"] == GAP:
            if n is None:
                v.append(f"{name}: storage gap {show(k)} disappeared")
                continue
            o_end, n_end = o["slot"] + _slots(o["bytes"]), n["slot"] + _slots(n["bytes"])
            if n_end != o_end or n["slot"] < o["slot"] or n["offset"] != 0:
                v.append(
                    f"{name}: storage gap {show(k)} must shrink from the front only "
                    f"(was slots {o['slot']}..{o_end - 1}, now {n['slot']}..{n_end - 1})"
                )
            elif n["slot"] > o["slot"]:
                gap_room.append((o["slot"], n["slot"]))
            continue
        if n is None:
            v.append(f"{name}: variable {show(k)} disappeared")
            continue
        for f in ("slot", "offset", "bytes", "type"):
            if n[f] != o[f]:
                v.append(f"{name}: variable {show(k)} changed {f}: {o[f]!r} -> {n[f]!r}")

    for k, n in live_rows.items():
        if k in old_rows:
            continue
        if n["slot"] >= old_end:
            continue  # appended after the last existing variable
        in_gap = any(
            lo <= n["slot"] and n["slot"] + _slots(n["bytes"]) <= hi for lo, hi in gap_room
        )
        if not in_gap:
            v.append(
                f"{name}: new variable {show(k)} at slot {n['slot']} is not appended after "
                f"the last existing slot ({old_end - 1}) nor placed in a shrunken storage gap"
            )

    for s, members in old["structs"].items():
        if s not in live["structs"]:
            continue  # no variable uses it any more: a removed variable already fails above
        if live["structs"][s] != members:
            v.append(f"{name}: storage struct {s!r} changed (a new field needs a new struct)")

    if live["linearization"] != old["linearization"]:
        v.append(
            f"{name}: inheritance linearization changed:\n    was {old['linearization']}\n"
            f"    now {live['linearization']}"
        )
    if not any(x.endswith(f":{BASE}") for x in live["linearization"]):
        v.append(f"{name}: {BASE} is missing from the linearization (ADR-0014 §3)")

    if live["libraries"] != old["libraries"]:
        for lib in sorted(set(old["libraries"]) | set(live["libraries"])):
            a, b = old["libraries"].get(lib), live["libraries"].get(lib)
            if a is None:
                v.append(f"{name}: linked library added: {lib}")
            elif b is None:
                v.append(f"{name}: linked library removed: {lib}")
            elif a != b:
                v.append(f"{name}: linked library code changed: {lib}")

    if live["openzeppelin"] != old["openzeppelin"]:
        v.append(
            f"{name}: OpenZeppelin submodule commit changed: {old['openzeppelin']} -> "
            f"{live['openzeppelin']}"
        )
    return v


# ─── Coverage: proxied.txt vs the sources vs the ADR table ─────────────────────

_DECL = re.compile(
    r"\b(abstract\s+contract|contract|library|interface)\s+(\w+)\s*(?:is\s+([^{]*))?\{", re.S
)


def _production_inheritance() -> dict[str, tuple[bool, list[str]]]:
    """name -> (concrete, direct bases) for every declaration under contracts/ (outside test, script, doc)."""
    decls: dict[str, tuple[bool, list[str]]] = {}
    root = REPO_ROOT / "contracts"
    for p in root.rglob("*.sol"):
        rel = p.relative_to(root).parts
        if rel[0] in ("test", "script", "doc"):
            continue
        src = re.sub(r"//[^\n]*|/\*.*?\*/", "", p.read_text(), flags=re.S)
        for m in _DECL.finditer(src):
            kind, nm, bases = m.group(1), m.group(2), m.group(3) or ""
            bases = re.sub(r"\([^()]*\)", "", bases)
            names = [b.strip().split(".")[-1] for b in bases.split(",") if b.strip()]
            decls[nm] = (kind == "contract", names)
    return decls


def _inherits(decls, nm: str, target: str, seen=None) -> bool:
    seen = set() if seen is None else seen
    if nm in seen or nm not in decls:
        return False
    seen.add(nm)
    return any(b == target or _inherits(decls, b, target, seen) for b in decls[nm][1])


def _adr_table() -> set[str]:
    text = ADR.read_text()
    m = re.search(r"### 1\. The proxied contracts.*?\n(.*?)\n### 2\.", text, re.S)
    if not m:
        raise ToolError(f"{ADR}: section 1 (the proxied contracts) not found")
    return set(re.findall(r"^\| `(\w+)`", m.group(1), re.M))


_FUNC_HEADER = re.compile(r"\bfunction\s+(\w+)\s*\([^)]*\)([^{;]*)[{;]", re.S)


def reinitializer_violations(sources: dict[str, str]) -> list[str]:
    """Every function header that uses `reinitializer(` must also carry `onlyUpgradeAuthority`."""
    v = []
    for path, text in sorted(sources.items()):
        src = re.sub(r"//[^\n]*|/\*.*?\*/", "", text, flags=re.S)
        for m in _FUNC_HEADER.finditer(src):
            mods = m.group(2)
            if re.search(r"\breinitializer\s*\(", mods) and not re.search(r"\bonlyUpgradeAuthority\b", mods):
                v.append(
                    f"{path}: function {m.group(1)} uses reinitializer(...) without onlyUpgradeAuthority "
                    "(ADR-0014 §3: only the timelock may run a pending reinitializer)"
                )
    return v


def _production_sources() -> dict[str, str]:
    root = REPO_ROOT / "contracts"
    out = {}
    for p in root.rglob("*.sol"):
        if p.relative_to(root).parts[0] in ("test", "script", "doc"):
            continue
        out[str(p.relative_to(REPO_ROOT))] = p.read_text()
    return out


def coverage(listed: list[str]) -> list[str]:
    v = reinitializer_violations(_production_sources())
    decls = _production_inheritance()
    governed = sorted(n for n, (concrete, _) in decls.items() if concrete and _inherits(decls, n, BASE))
    adr = _adr_table()
    for n in governed:
        if n not in listed:
            v.append(f"{n} inherits {BASE} but is not listed in {PROXIED_LIST.name}")
    for n in listed:
        if not _inherits(decls, n, BASE):
            v.append(f"{n} is listed in {PROXIED_LIST.name} but does not inherit {BASE}")
        if n not in adr:
            v.append(f"{n} is listed in {PROXIED_LIST.name} but is missing from the ADR-0014 §1 table")
    return v


def _listed() -> list[str]:
    if not PROXIED_LIST.is_file():
        raise ToolError(f"{PROXIED_LIST} missing")
    names = [
        ln.strip() for ln in PROXIED_LIST.read_text().splitlines()
        if ln.strip() and not ln.lstrip().startswith("#")
    ]
    if not names:
        raise ToolError(f"{PROXIED_LIST} lists no contract")
    return names


def _snapshot_path(contract: str) -> Path:
    return FIXTURES / f"{contract}.json"


def _load(path: Path) -> dict:
    if not path.is_file() or path.stat().st_size == 0:
        raise ToolError(f"snapshot missing or empty: {path}")
    data = json.loads(path.read_text())
    for k in ("storage", "structs", "linearization", "libraries", "openzeppelin"):
        if k not in data:
            raise ToolError(f"snapshot {path} is not in the normalized shape (no {k!r})")
    return data


def cmd_check(only: list[str]) -> int:
    listed = _listed()
    names = only or listed
    failures = coverage(listed)
    for c in names:
        live = normalize(c)
        problems = compare(_load(_snapshot_path(c)), live)
        if problems:
            failures.extend(problems)
        else:
            print(
                f"check-storage-layout: {c} matches {_snapshot_path(c).name} "
                f"({len(live['storage'])} variables, {len(live['structs'])} structs, "
                f"{len(live['libraries'])} libraries)"
            )
    if failures:
        print("check-storage-layout: FAILED", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        print(
            "  Proxied state may only be appended (or take slots from a storage gap). If a release "
            "deploys a new implementation on purpose, review the diff and rerun with --write.",
            file=sys.stderr,
        )
        return 1
    print(f"check-storage-layout: {len(names)} proxied contract(s) pass")
    return 0


def cmd_write(only: list[str]) -> int:
    names = only or _listed()
    FIXTURES.mkdir(parents=True, exist_ok=True)
    for c in names:
        data = normalize(c)
        _snapshot_path(c).write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
        print(f"check-storage-layout: wrote {_snapshot_path(c)}")
    return 0


def cmd_selftest() -> int:
    """Prove each rule fires on a mutated record, and the allowed changes pass."""
    listed = _listed()
    # A basket kind: it has both storage gaps (AdminFloorAccessControlCounter and BasketVault).
    subject = next((c for c in listed if c.endswith("BasketVault") or c == "ProtocolAssetVault"), listed[0])
    live = normalize(subject)
    fails = 0

    def expect(label: str, old: dict, new: dict, want_fail: bool) -> None:
        nonlocal fails
        got = compare(old, new)
        if bool(got) == want_fail:
            print(f"ok   {label}")
        else:
            fails += 1
            print(f"FAIL {label}: violations={got}")

    def mutated(fn) -> dict:
        d = copy.deepcopy(live)
        fn(d)
        return d

    plain = [i for i, r in enumerate(live["storage"]) if r["label"] != GAP]
    mid = plain[len(plain) // 2]
    last_end = max(r["slot"] + _slots(r["bytes"]) for r in live["storage"])
    gaps = [i for i, r in enumerate(live["storage"]) if r["label"] == GAP]

    expect("identical layout passes", live, copy.deepcopy(live), False)
    expect("a moved slot fails", live, mutated(lambda d: d["storage"][mid].update(slot=d["storage"][mid]["slot"] + 7)), True)
    expect("a retyped variable fails", live, mutated(lambda d: d["storage"][mid].update(type="int8")), True)
    expect("a changed offset fails", live, mutated(lambda d: d["storage"][mid].update(offset=d["storage"][mid]["offset"] + 1)), True)
    expect("a removed variable fails", live, mutated(lambda d: d["storage"].pop(mid)), True)

    def insert_middle(d):
        r = copy.deepcopy(d["storage"][mid])
        r.update(label="inserted", contract=r["contract"])
        d["storage"].append(r)
    expect("a variable inserted in the middle fails", live, mutated(insert_middle), True)

    def append_end(d):
        d["storage"].append({"contract": d["storage"][-1]["contract"], "label": "appended",
                             "slot": last_end, "offset": 0, "bytes": 32, "type": "uint256"})
    expect("a variable appended at the end passes", live, mutated(append_end), False)

    if gaps:
        g = gaps[0]

        def take_gap(d):
            gap = d["storage"][g]
            gap.update(slot=gap["slot"] + 1, bytes=gap["bytes"] - 32,
                       type=re.sub(r"\[(\d+)\]", lambda m: f"[{int(m.group(1)) - 1}]", gap["type"]))
            d["storage"].append({"contract": gap["contract"], "label": "fromGap",
                                 "slot": gap["slot"] - 1, "offset": 0, "bytes": 32, "type": "uint256"})
        expect("a variable that takes one slot from its gap passes", live, mutated(take_gap), False)

        def gap_moved(d):
            d["storage"][g].update(slot=d["storage"][g]["slot"] + 1)
        expect("a gap whose end moves fails", live, mutated(gap_moved), True)
    else:
        fails += 1
        print(f"FAIL selftest subject {subject} has no storage gap to exercise")

    if live["structs"]:
        s0 = next(iter(live["structs"]))
        expect("a changed storage struct fails", live, mutated(lambda d: d["structs"][s0].reverse() if len(d["structs"][s0]) > 1 else d["structs"][s0].append({"label": "x", "slot": 9, "offset": 0, "type": "uint256"})), True)
    expect("a reordered linearization fails", live, mutated(lambda d: d["linearization"].reverse()), True)
    expect("a missing GovernedUpgrade fails", live, mutated(lambda d: d.update(linearization=[x for x in d["linearization"] if not x.endswith(":" + BASE)])), True)
    if live["libraries"]:
        l0 = next(iter(live["libraries"]))
        expect("a changed library fails", live, mutated(lambda d: d["libraries"].update({l0: "0x" + "00" * 32})), True)
        expect("a removed library fails", live, mutated(lambda d: d["libraries"].pop(l0)), True)
    expect("an added library fails", live, mutated(lambda d: d["libraries"].update({"contracts/lib/X.sol:X": "0x" + "11" * 32})), True)
    expect("an OpenZeppelin commit change fails", live, mutated(lambda d: d["openzeppelin"].update({OZ_SUBMODULES[0]: "0" * 40})), True)

    # Coverage rule on the real tree: must pass, and must fail for a list missing a contract.
    real = coverage(listed)
    if real:
        fails += 1
        print(f"FAIL coverage on the real tree: {real}")
    else:
        print("ok   proxied.txt, the sources and the ADR-0014 table agree")
    if coverage(listed[1:]):
        print("ok   a contract missing from proxied.txt fails")
    else:
        fails += 1
        print("FAIL a contract missing from proxied.txt did not fail")

    # Reinitializer rule (ADR-0014 §3): a bare reinitializer fails, the paired form passes.
    bare = {"contracts/X.sol": "contract X { function initializeV2(uint256 a) external reinitializer(2) { a; } }"}
    paired = {"contracts/X.sol": "contract X { function initializeV2(uint256 a)\n external\n onlyUpgradeAuthority\n reinitializer(2)\n { a; } }"}
    commented = {"contracts/X.sol": "contract X { // function f() external reinitializer(2) {}\n function g() external {} }"}
    if reinitializer_violations(bare) and not reinitializer_violations(paired) and not reinitializer_violations(commented):
        print("ok   a reinitializer without onlyUpgradeAuthority fails, the paired form passes")
    else:
        fails += 1
        print("FAIL the reinitializer rule did not separate the bare and the paired form")

    # Every committed snapshot is in the normalized shape.
    for c in listed:
        try:
            _load(_snapshot_path(c))
            print(f"ok   committed snapshot {c}.json is normalized")
        except ToolError as e:
            fails += 1
            print(f"FAIL {e}")

    if fails:
        print(f"check-storage-layout selftest: {fails} case(s) failed", file=sys.stderr)
        return 1
    print("check-storage-layout selftest: all cases passed")
    return 0


def main(argv: list[str]) -> int:
    try:
        if argv and argv[0] == "--selftest":
            return cmd_selftest()
        if argv and argv[0] == "--write":
            return cmd_write(argv[1:])
        if argv and argv[0] in ("-h", "--help"):
            print(__doc__)
            return 0
        if argv and argv[0].startswith("-"):
            print(f"unknown argument: {argv[0]}", file=sys.stderr)
            return 2
        return cmd_check(argv)
    except ToolError as e:
        print(f"check-storage-layout: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
