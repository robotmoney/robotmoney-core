#!/usr/bin/env python3
"""Upgradeable storage-layout gate (ADR-0014 §8).

Canonical: docs/adr/ADR-0014-governed-upgrades-and-freeze.md §8 (the storage-layout tool and its CI job).
Driven by scripts/ci/check-storage-layout.sh; see its header for usage.

For every contract named in contracts/test/fixtures/storage-layout/proxied.txt, the gate builds a
normalized layout record from `forge inspect` (after `forge build`):

  storage        label, slot, offset, bytes, type label and defining contract of every state variable
                 (type labels keep their defining contract, e.g. `struct BasketAssetConfigGuard.AssetInfo[]`)
  structs        the members of every storage struct, keyed by the struct's label
  enums          the members, in declaration order, of every enum storage can hold, keyed by the enum's
                 label (`forge inspect` gives an enum type no member list, so they are read from the
                 enum's definition in the contract's own compiled sources). A stored enum is its member's
                 index, so inserting or reordering a member reinterprets every stored value.
  linearization  the ordered inheritance list (`forge inspect <C> linearization`)
  libraries      every linked library, recursively, with keccak256 of its deployedBytecode in out/
  openzeppelin   the gitlink commits of lib/openzeppelin-contracts and lib/openzeppelin-contracts-upgradeable

and compares it with the committed snapshot contracts/test/fixtures/storage-layout/<C>.json. A snapshot
is the layout of the code in the same tree, exactly: `--write` rewrites it in the change that appends
to the layout, and the release tags hold the layouts releases put live (`--release-anchor`). Rules, all
of which fail the gate:

  - an existing variable moves, changes type, offset or size, or disappears;
  - a new variable sits anywhere but after the last existing one, except inside a storage gap
    (`__gap`) that shrinks by exactly the slots the new variables take, end-aligned;
  - any storage struct changes at all (a new field needs a new struct in a new mapping);
  - a storage enum's existing members change in any way (members may only be appended);
  - the newer record stores a struct or an enum (in a variable, a mapping, an array or a struct
    member) whose members it does not record, so a change to it could not be seen;
  - the same-tree compare only: the committed snapshot differs from the code's layout record in any
    way, an append included (security round 3). An append that skipped `--write` would leave the
    snapshot, and the layout identifier a release records from its sha256, on the old layout, and a
    later insert before the unrecorded variable would then pass every compare;
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

The compare above reads the snapshot from the same tree as the code, so a change that also reruns
`--write` would pass it whatever it did to the layout. `--base <ref>` closes that: it compares the
snapshot committed at <ref> (the PR base, or the previous tip of a pushed branch) with the committed
snapshot, under the storage rules above (variables, gaps, structs, enums, `GovernedUpgrade`). A
rewritten snapshot must therefore itself be append-only against what was there before. The release
pins (linearization, library code, OpenZeppelin commits) are reported, not failed, in that mode: a
release that links a new library build rewrites them on purpose (§8 "Library links in detail").
A snapshot at <ref> in the pre-ADR-0014 shape (the gateway's, re-baselined once in P1 per §8) has no
normalized rows to compare. A contract is new at <ref>, with nothing to protect yet, only when <ref>
has neither its snapshot nor its name in proxied.txt. Two shapes fail instead:
  - a contract listed in proxied.txt at <ref> with no snapshot there (a snapshot deleted in one
    commit cannot come back rewritten in the next as "new");
  - a contract proxied at <ref> (listed there, or with a snapshot there) that the current proxied.txt
    no longer lists (a rename or a delisting would leave the live proxy's layout uncompared).

The parent alone is not an anchor. A red commit that rewrote a snapshot becomes the parent of the
next commit, which then compares equal and goes green, and every later commit with it. So
`--release-anchor` runs the same compare against every annotated production `release/<version>` tag
in the clone (a `-rehearsal` tag or a lightweight tag never deploys to 8453): the layout a release
put live. Each release sha passed this compare against the releases before it, and the release gate
deploys only a green sha, so the chain holds from release to release. CI fetches the tags first.

Exit codes: 0 pass; 1 a rule failed; 2 tooling or input error.
"""

from __future__ import annotations

import copy
import json
import os
import re
import subprocess
import sys
import tempfile
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


def _run(args: list[str], cwd: Path = REPO_ROOT, env: dict[str, str] | None = None) -> str:
    try:
        res = subprocess.run(
            args, cwd=cwd, env=env, capture_output=True, text=True, check=False, timeout=900
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


# Comments and string literals, blanked before the enum scan so a brace or an `enum` inside either
# cannot open a scope or define an enum.
_SRC_NOISE = re.compile(r"//[^\n]*|/\*.*?\*/|\"(?:\\.|[^\"\\\n])*\"|'(?:\\.|[^'\\\n])*'", re.S)
_ENUM_SCAN = re.compile(
    r"\b(?:abstract\s+contract|contract|library|interface)\s+(\w+)[^{;]*\{"  # a named scope opens
    r"|\benum\s+(\w+)\s*\{([^{}]*)\}"  # an enum definition (its body holds no braces)
    r"|[{}]",
    re.S,
)


def enum_definitions(src: str) -> dict[str, list[str]]:
    """`Scope.Name` (or `Name` at file level) -> members in declaration order, for every enum in `src`.
    Solidity declares an enum only at file level or directly in a contract, library or interface body,
    so the innermost open scope names it, matching `forge inspect`'s `enum Scope.Name` type label."""
    out: dict[str, list[str]] = {}
    stack: list[str | None] = []
    for m in _ENUM_SCAN.finditer(_SRC_NOISE.sub(" ", src)):
        if m.group(1):
            stack.append(m.group(1))
        elif m.group(2):
            scope = stack[-1] if stack else None
            members = [x.strip() for x in m.group(3).split(",") if x.strip()]
            out[f"{scope}.{m.group(2)}" if scope else m.group(2)] = members
        elif m.group(0) == "{":
            stack.append(None)
        elif stack:
            stack.pop()
    return out


def _enum_members(contract: str, labels: list[str]) -> dict[str, list[str]]:
    """The members of each `enum Scope.Name` label, read from the sources `contract` was compiled from
    (`forge inspect <C> metadata`). Fails closed: a label with no definition, or two definitions of one
    name with different members, is a tooling error, never an unrecorded enum."""
    if not labels:
        return {}
    defs: dict[str, list[str]] = {}
    for path in sorted((_inspect(contract, "metadata").get("sources") or {})):
        p = REPO_ROOT / path
        if not p.is_file():
            raise ToolError(f"{contract}: compiled source {path} is not in the checkout")
        for name, members in enum_definitions(p.read_text()).items():
            if name in defs and defs[name] != members:
                raise ToolError(f"{contract}: enum {name} is defined twice with different members ({path})")
            defs[name] = members
    out = {}
    for label in labels:
        name = label[len("enum "):]
        if not defs.get(name):
            raise ToolError(f"{contract}: storage type {label!r} has no enum definition in its sources")
        out[label] = defs[name]
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
    # Every enum type the layout reaches: a variable, a mapping key or value, an array element or a
    # struct member. forge lists each such type in `types` with its label and no members.
    enum_labels = sorted({t["label"] for t in types.values() if t.get("label", "").startswith("enum ")})
    lin = [f'{x["source"]}:{x["contract"]}' for x in _inspect(contract, "linearization")]
    return {
        "contract": contract,
        "storage": [row(e) for e in layout.get("storage", [])],
        "structs": dict(sorted(structs.items())),
        "enums": _enum_members(contract, enum_labels),
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


_STRUCT_REF = re.compile(r"\bstruct [\w$.]+")
_ENUM_REF = re.compile(r"\benum [\w$.]+")


def _reached(rec: dict, ref: re.Pattern) -> set[str]:
    """Every type label `ref` matches in the record's storage rows and struct members: a variable, a
    mapping key or value, an array element, or a member of a recorded struct."""
    types = [r["type"] for r in rec["storage"]]
    types += [m["type"] for members in rec["structs"].values() for m in members]
    return {m.group(0) for t in types for m in ref.finditer(t)}


def unrecorded_types(rec: dict) -> list[str]:
    """Every struct and enum the record's storage reaches without recording its members. Neither can be
    compared, so a changed struct member or a reordered enum member would go unseen. `normalize` records
    every one by construction; a snapshot edited by hand may not."""
    enums = rec.get("enums") or {}
    v = [
        f"the layout record stores {s!r} and does not record its members, so a changed member "
        "could not be seen" for s in sorted(_reached(rec, _STRUCT_REF) - set(rec["structs"]))
    ]
    v += [
        f"the layout record stores {e!r} and does not record its members, so a reordered or inserted "
        "member could not be seen" for e in sorted(_reached(rec, _ENUM_REF) - set(enums))
    ]
    return v


def compare(old: dict, live: dict, release_pins: bool = True) -> list[str]:
    """Rule violations of `live` against the committed snapshot `old` (empty means pass).
    `release_pins=False` is the `--base` mode: the storage rules only, with the linearization, library
    and OpenZeppelin pins left to `release_pin_changes` (a release rewrites those on purpose)."""
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
            continue  # no variable uses it any more (a removed variable fails above), or unrecorded_types fails it below
        if live["structs"][s] != members:
            v.append(f"{name}: storage struct {s!r} changed (a new field needs a new struct)")

    # A stored enum is the index of its member, so only an append keeps every stored value's meaning.
    # A snapshot from before enums were recorded has no "enums" key and nothing to hold `live` to.
    for e, members in old.get("enums", {}).items():
        now = live.get("enums", {}).get(e)
        if now is None:
            continue  # no variable reaches it any more (a removed or retyped one fails above), or unrecorded_types fails it below
        if now[: len(members)] != members:
            v.append(
                f"{name}: storage enum {e!r} changed its existing members {members} -> {now} "
                "(members may only be appended: every stored value is a member's index)"
            )

    # Security round 3 (review: SECURITY_LAYOUT_GATE_GAP): the two loops above skip a struct or an enum the
    # newer record leaves out, so a snapshot with `struct BasketAssetConfigGuard.AssetInfo` and its
    # `enum BasketAssetConfigGuard.Venue` deleted by hand would pass a changed struct or a reordered enum.
    # The newer record must therefore record every struct and enum its storage reaches.
    v.extend(f"{name}: {x}" for x in unrecorded_types(live))

    if not any(x.endswith(f":{BASE}") for x in live["linearization"]):
        v.append(f"{name}: {BASE} is missing from the linearization (ADR-0014 §3)")
    if release_pins:
        v.extend(release_pin_changes(old, live))
    return v


def release_pin_changes(old: dict, live: dict) -> list[str]:
    """Differences in the pins a release rewrites on purpose: linearization, linked library code and
    the OpenZeppelin submodule commits. Violations in the same-tree compare; notes in `--base` mode."""
    v: list[str] = []
    name = live.get("contract", "?")
    if live["linearization"] != old["linearization"]:
        v.append(
            f"{name}: inheritance linearization changed:\n    was {old['linearization']}\n"
            f"    now {live['linearization']}"
        )

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


def _members(members: list) -> str:
    """A struct's members (`label@slot+offset type`) or an enum's member names, on one line."""
    return "[" + ", ".join(
        f"{m['label']}@{m['slot']}+{m['offset']} {m['type']}" if isinstance(m, dict) else str(m) for m in members
    ) + "]"


def snapshot_drift(snapshot: dict, live: dict) -> list[str]:
    """Every way the committed snapshot differs from the code's layout record: a storage row, a struct, an
    enum or a release pin. Empty: the snapshot is exactly what `--write` would write.

    Security round 3 (review: SECURITY_LAYOUT_GATE_GAP). `compare` lets the code append to the snapshot,
    so on its own the same-tree compare passed code that appends V while the snapshot keeps S. Every
    compare after it then trusts S: the upgrade-proxy row passes equal layout identifiers (the sha256 of
    the snapshot file) with no compare, and a later change that inserts W before V moves V while the
    same-tree compare, `--base` and `--release-anchor` all see S plus appended rows. The same-tree compare
    therefore requires an exact match: an append is recorded with `--write` in the change that makes it,
    and `--base` and `--release-anchor` then hold the rewritten snapshot append-only against history."""
    v: list[str] = []
    name = live.get("contract", "?")
    file = f"{name}.json"
    show = lambda k: k[0] if k[1] == 0 else f"{k[0]}#{k[1]}"  # noqa: E731
    row = lambda r: f"slot {r['slot']}+{r['offset']} ({r['bytes']} bytes) {r['type']}"  # noqa: E731
    old_rows, new_rows = _keyed(snapshot["storage"]), _keyed(live["storage"])
    for k, n in new_rows.items():
        o = old_rows.get(k)
        if o is None:
            v.append(f"{name}: the code holds variable {show(k)} at {row(n)} and {file} does not record it")
        elif o != n:
            v.append(f"{name}: variable {show(k)} is at {row(n)} in the code and at {row(o)} in {file}")
    for k in sorted(old_rows.keys() - new_rows.keys()):
        v.append(f"{name}: {file} records variable {show(k)} and the code does not hold it")
    if not v and snapshot["storage"] != live["storage"]:
        v.append(f"{name}: {file} lists the storage variables in another order than the code")
    for kind in ("structs", "enums"):
        recorded, code = snapshot.get(kind) or {}, live.get(kind) or {}
        for t in sorted(set(recorded) | set(code)):
            if t not in recorded:
                v.append(f"{name}: the code's layout reaches {t!r} and {file} does not record it")
            elif t not in code:
                v.append(f"{name}: {file} records {t!r} and the code's layout does not reach it")
            elif recorded[t] != code[t]:
                v.append(
                    f"{name}: {t!r} is {_members(code[t])} in the code and {_members(recorded[t])} in {file}"
                )
    for k in ("contract", "linearization", "libraries", "openzeppelin"):
        if snapshot.get(k) != live.get(k):
            v.append(f"{name}: {k} differs between the code and {file}")
    return v


def same_tree_problems(snapshot: dict, live: dict) -> tuple[list[str], list[str]]:
    """The same-tree compare of `cmd_check`: (rule violations of the code against its committed snapshot,
    differences that are no violation but leave the snapshot behind the code). The second list is only
    filled when the first is empty, so a moved slot is reported once, as the rule it breaks."""
    problems = compare(snapshot, live)
    return problems, ([] if problems else snapshot_drift(snapshot, live))


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


def _parse_listed(text: str) -> list[str]:
    return [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]


def _listed() -> list[str]:
    if not PROXIED_LIST.is_file():
        raise ToolError(f"{PROXIED_LIST} missing")
    names = _parse_listed(PROXIED_LIST.read_text())
    if not names:
        raise ToolError(f"{PROXIED_LIST} lists no contract")
    return names


def _snapshot_path(contract: str) -> Path:
    return FIXTURES / f"{contract}.json"


SHAPE = ("storage", "structs", "enums", "linearization", "libraries", "openzeppelin")


def _load(path: Path) -> dict:
    if not path.is_file() or path.stat().st_size == 0:
        raise ToolError(f"snapshot missing or empty: {path}")
    data = json.loads(path.read_text())
    for k in SHAPE:
        if k not in data:
            raise ToolError(f"snapshot {path} is not in the normalized shape (no {k!r})")
    return data


FIXTURES_REL = FIXTURES.relative_to(REPO_ROOT).as_posix()


class _Repo:
    """Read-only git access to one checkout: this repository, or the selftest's throwaway history."""

    def __init__(self, root: Path = REPO_ROOT, env: dict[str, str] | None = None):
        self.root, self.env = root, env

    def git(self, *args: str) -> str:
        return _run(["git", *args], cwd=self.root, env=self.env)

    def commit_of(self, ref: str) -> str | None:
        res = subprocess.run(
            ["git", "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"],
            cwd=self.root, env=self.env, capture_output=True, text=True, check=False,
        )
        return res.stdout.strip() if res.returncode == 0 and res.stdout.strip() else None

    def show(self, commit: str, rel: str) -> str | None:
        """The text of `rel` at `commit`, or None when that commit has no such file."""
        probe = subprocess.run(
            ["git", "cat-file", "-e", f"{commit}:{rel}"], cwd=self.root, env=self.env,
            capture_output=True, check=False,
        )
        return self.git("show", f"{commit}:{rel}") if probe.returncode == 0 else None

    def names(self, commit: str, rel_dir: str) -> list[str]:
        """The file names directly under `rel_dir` at `commit` (empty when the folder is absent)."""
        out = self.git("ls-tree", "--name-only", commit, "--", rel_dir + "/")
        return [Path(p).name for p in out.splitlines() if p.strip()]


def release_anchors(repo: _Repo) -> list[tuple[str, str]]:
    """(tag, commit) of every annotated production `release/<version>` tag in the clone, by name.
    Mirrors publish-contracts/src/release-tag.ts: a lightweight tag is no release tag, and a tag that
    mentions `rehearsal` never deploys to 8453, so neither one is the layout a release put live."""
    out = repo.git("for-each-ref", "--format=%(objecttype)|%(refname:strip=2)", "refs/tags/release/")
    anchors = []
    for line in out.splitlines():
        kind, _, tag = line.strip().partition("|")
        if kind != "tag" or not tag or re.search(r"rehearsal", tag, re.I):
            continue
        commit = repo.commit_of(f"refs/tags/{tag}")
        if commit is None:
            raise ToolError(f"release tag {tag} does not resolve to a commit in this clone")
        anchors.append((tag, commit))
    return sorted(anchors)


def base_compare(repo: _Repo, commit: str, listed_now: list[str], committed, only: list[str],
                 label: str, say=print) -> tuple[list[str], int]:
    """Rule violations of the snapshots under test against those committed at `commit`, and the number
    of snapshots compared. `committed(c)` loads the snapshot under test for `c`.

    A contract counts as proxied at `commit` when that commit lists it in proxied.txt or holds its
    snapshot. Such a contract must still be listed now, or its live proxy's layout is never compared
    again (a rename or a delisting). A listed contract with no snapshot at `commit` is new only when
    `commit` does not list it either: otherwise a snapshot deleted in one commit could come back
    rewritten in the next as a new contract."""
    short = commit[:12]
    listed_text = repo.show(commit, f"{FIXTURES_REL}/{PROXIED_LIST.name}")
    listed_then = _parse_listed(listed_text) if listed_text is not None else []
    snapshots_then = {n[: -len(".json")] for n in repo.names(commit, FIXTURES_REL) if n.endswith(".json")}
    failures: list[str] = []
    for c in sorted((set(listed_then) | snapshots_then) - set(listed_now)):
        if only and c not in only:
            continue
        failures.append(
            f"{c} is proxied at {short} but the current {PROXIED_LIST.name} does not list it: a renamed or "
            "delisted proxied contract leaves its live proxy's storage behind, and its snapshot would never "
            "be compared again"
        )
    compared = 0
    for c in only or listed_now:
        rel = f"{FIXTURES_REL}/{c}.json"
        text = repo.show(commit, rel)
        if text is None:
            if c in listed_then:
                failures.append(
                    f"{c} is listed in {PROXIED_LIST.name} at {short} but has no snapshot there, so the "
                    "snapshot under test cannot be proven append-only against it (a snapshot deleted in one "
                    "commit is not a new contract in the next)"
                )
            else:
                say(f"check-storage-layout {label}: {c} is neither listed nor snapshotted at {short} (a new proxied contract)")
            continue
        try:
            base = json.loads(text)
        except json.JSONDecodeError as e:
            raise ToolError(f"{commit}:{rel} is not JSON: {e}") from e
        if any(k not in base for k in SHAPE if k != "enums"):
            say(
                f"check-storage-layout {label}: {c} snapshot at {short} predates the normalized "
                "ADR-0014 shape (the one-time P1 re-baseline); nothing to compare"
            )
            continue
        live = committed(c)
        compared += 1
        problems = compare(base, live, release_pins=False)
        if problems:
            failures.extend(problems)
            continue
        for n in release_pin_changes(base, live):
            say(f"check-storage-layout {label}: note (a release pin, review it): {n}")
        say(f"check-storage-layout {label}: {c} snapshot is append-only against {short}")
    return failures, compared


def cmd_check(only: list[str]) -> int:
    listed = _listed()
    names = only or listed
    failures = coverage(listed)
    stale: list[str] = []
    for c in names:
        live = normalize(c)
        problems, drift = same_tree_problems(_load(_snapshot_path(c)), live)
        failures.extend(problems)
        stale.extend(drift)
        if not problems and not drift:
            print(
                f"check-storage-layout: {c} matches {_snapshot_path(c).name} "
                f"({len(live['storage'])} variables, {len(live['structs'])} structs, "
                f"{len(live['enums'])} enums, {len(live['libraries'])} libraries)"
            )
    if failures or stale:
        print("check-storage-layout: FAILED", file=sys.stderr)
        for f in failures + stale:
            print(f"  - {f}", file=sys.stderr)
    if failures:
        print(
            "  Proxied state may only be appended (or take slots from a storage gap), and enum members "
            "only appended. Rewriting the snapshot with --write does not make a non-append change pass: "
            "CI also compares the committed snapshot with the base branch's (--base) and with every "
            "production release tag's (--release-anchor), and a live proxy cannot take a layout whose "
            "existing slots moved. Change the code back to an append-only layout.",
            file=sys.stderr,
        )
    if stale:
        print(
            "  The committed snapshot must equal the code's layout exactly, so the snapshot hash a release "
            "records is its code's layout and the next upgrade compares against it. Record an append-only "
            "change in the change that makes it: run `scripts/ci/check-storage-layout.sh --write <Contract>` "
            "and commit the reviewed diff. --base and --release-anchor then hold it append-only.",
            file=sys.stderr,
        )
    if failures or stale:
        return 1
    print(f"check-storage-layout: {len(names)} proxied contract(s) pass")
    return 0


def cmd_base(ref: str, only: list[str]) -> int:
    """Compare the snapshot committed at `ref` with the committed snapshot of every listed contract,
    under the storage rules (ADR-0014 §8). The same-tree compare in `cmd_check` reads its reference from
    the change under test, so this is what stops `--write` from laundering a non-append layout.
    The parent alone is not enough (see `cmd_release_anchor`)."""
    repo = _Repo()
    commit = repo.commit_of(ref)
    if commit is None:
        raise ToolError(
            f"base ref {ref!r} is not a commit in this clone (CI fetches it first: "
            f"git fetch --no-tags --depth=1 origin <sha>)"
        )
    listed = _listed()
    names = only or listed
    failures, compared = base_compare(
        repo, commit, listed, lambda c: _load(_snapshot_path(c)), only, "--base"
    )
    if failures:
        print(f"check-storage-layout --base: FAILED against {commit[:12]}", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        print(
            "  The committed snapshot itself breaks the append-only rules against the base branch's "
            "snapshot, so the layout it records cannot upgrade the proxies built from the base. A "
            "snapshot rewritten with --write is held to the same rules as the code.",
            file=sys.stderr,
        )
        return 1
    print(
        f"check-storage-layout --base: {compared} of {len(names)} proxied contract snapshot(s) compared, "
        f"all append-only against {commit[:12]}"
    )
    return 0


def cmd_release_anchor(only: list[str]) -> int:
    """`cmd_base` against every annotated production release/<version> tag: the layout a release put
    live. The parent compare launders a red commit: X1 rewrites a snapshot with --write and its run is
    red, then X2 compares X1 with X2, finds them equal and goes green, and so does every later commit.
    The release tags cannot be rewritten by the change under test, so they anchor the chain."""
    repo = _Repo()
    anchors = release_anchors(repo)
    if not anchors:
        raise ToolError(
            "no annotated production release/<version> tag in this clone, so there is no deployed layout "
            "to anchor to (CI fetches them first: git fetch --no-tags --depth=1 origin "
            "'+refs/tags/release/*:refs/tags/release/*')"
        )
    listed = _listed()
    failures: list[str] = []
    for tag, commit in anchors:
        f, compared = base_compare(
            repo, commit, listed, lambda c: _load(_snapshot_path(c)), only, f"--release-anchor {tag}"
        )
        failures.extend(f"{tag}: {x}" for x in f)
        print(
            f"check-storage-layout --release-anchor: {tag} ({commit[:12]}): {compared} snapshot(s) "
            f"compared, {len(f)} violation(s)"
        )
    if failures:
        print("check-storage-layout --release-anchor: FAILED", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        print(
            "  The committed snapshot breaks the append-only rules against the layout a production release "
            "put live. A green parent does not make it safe: a red commit that rewrote the snapshot becomes "
            "the next commit's parent. Change the code back to a layout that only appends to the release's.",
            file=sys.stderr,
        )
        return 1
    print(
        f"check-storage-layout --release-anchor: every snapshot is append-only against "
        f"{len(anchors)} production release tag(s)"
    )
    return 0


def cmd_write(only: list[str]) -> int:
    names = only or _listed()
    FIXTURES.mkdir(parents=True, exist_ok=True)
    for c in names:
        data = normalize(c)
        _snapshot_path(c).write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
        print(f"check-storage-layout: wrote {_snapshot_path(c)}")
    return 0


def _selftest_history(live: dict, moved: dict, appended: dict) -> int:
    """Build a throwaway git history and run the `--base` and `--release-anchor` compares over it.
    `moved` is `live` with a slot moved; `appended` is `live` with a variable appended. Returns the
    number of failed cases."""
    fails = 0

    def check(label: str, ok: bool, detail: object = "") -> None:
        nonlocal fails
        if ok:
            print(f"ok   {label}")
        else:
            fails += 1
            print(f"FAIL {label}: {detail}")

    name = live["contract"]
    snap = f"{FIXTURES_REL}/{name}.json"
    listing = f"{FIXTURES_REL}/{PROXIED_LIST.name}"
    quiet = lambda *_: None  # noqa: E731
    # The throwaway repository reads no system or user git config, so a signing or hook setting on the
    # machine cannot change what the history holds, and a GIT_DIR in the caller's environment cannot
    # point these commands at this checkout.
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(
        GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
        GIT_AUTHOR_NAME="selftest", GIT_AUTHOR_EMAIL="selftest@invalid",
        GIT_COMMITTER_NAME="selftest", GIT_COMMITTER_EMAIL="selftest@invalid",
    )
    with tempfile.TemporaryDirectory(prefix="storage-layout-selftest-") as tmp:
        root = Path(tmp)
        repo = _Repo(root, env)
        repo.git("init", "-q")

        def commit(files: dict, msg: str) -> str:
            for rel, content in files.items():
                p = root / rel
                if content is None:
                    p.unlink(missing_ok=True)
                    continue
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(content if isinstance(content, str) else json.dumps(content, indent=2, sort_keys=True) + "\n")
            repo.git("add", "-A")
            repo.git("commit", "-q", "--allow-empty", "-m", msg)
            return repo.git("rev-parse", "HEAD").strip()

        def tag(tag_name: str, at: str, annotated: bool = True) -> None:
            repo.git(*(["tag", "-a", "-m", tag_name, tag_name, at] if annotated else ["tag", tag_name, at]))

        def under_test(head: str):
            """The proxied.txt and the snapshots committed at `head`, as the change under test."""
            text = repo.show(head, listing)

            def committed(c: str) -> dict:
                t = repo.show(head, f"{FIXTURES_REL}/{c}.json")
                if t is None:
                    raise ToolError(f"selftest history: {c} has no snapshot at {head[:12]}")
                return json.loads(t)
            return (_parse_listed(text) if text is not None else []), committed

        def parent_fails(parent: str, head: str) -> list[str]:
            listed, committed = under_test(head)
            return base_compare(repo, parent, listed, committed, [], "--base", quiet)[0]

        def anchor_fails(head: str) -> list[str]:
            listed, committed = under_test(head)
            out: list[str] = []
            for _tag, at in release_anchors(repo):
                out += base_compare(repo, at, listed, committed, [], "--release-anchor", quiet)[0]
            return out

        released = commit({listing: f"{name}\n", snap: live}, "S: the layout a release deploys")
        tag("release/v9.9.9", released)
        x1 = commit({snap: moved}, "X1: a moved slot and a snapshot rewritten with --write (its run is red)")
        tag("release/v9.9.9-rehearsal", x1)
        tag("release/v9.9.10", x1, annotated=False)
        x2 = commit({"NOTES": "x2\n"}, "X2: an unrelated change on top of the red X1")

        anchors = [t for t, _ in release_anchors(repo)]
        check("history: only the annotated production tag anchors (a -rehearsal or lightweight tag does not)",
              anchors == ["release/v9.9.9"], anchors)
        got = parent_fails(x1, x2)
        check("history S -> S' (moved slot, red) -> S' unchanged: the parent compare passes at the third commit",
              not got, got)
        got = anchor_fails(x2)
        check("history S -> S' (moved slot, red) -> S' unchanged: --release-anchor still fails at the third commit",
              any("changed slot" in f for f in got), got)
        grown = commit({snap: appended}, "the released S plus one appended variable")
        got = anchor_fails(grown)
        check("history: --release-anchor passes a snapshot that only appends to the released one", not got, got)

        d1 = commit({snap: None}, "the snapshot deleted, the listing kept (red)")
        d2 = commit({snap: moved}, "the snapshot re-added, rewritten")
        got = parent_fails(d1, d2)
        check("delete then re-add: the parent compare fails (listed at the parent with no snapshot there)",
              any("has no snapshot there" in f for f in got), got)
        check("delete then re-add: --release-anchor fails", bool(anchor_fails(d2)))
        u1 = commit({snap: None, listing: "# nothing proxied\n"}, "the snapshot and the listing deleted (red)")
        u2 = commit({snap: moved, listing: f"{name}\n"}, "both re-added, rewritten")
        got = parent_fails(u1, u2)
        check("delist then re-add: the parent compare sees a new contract and passes (the hole the anchor closes)",
              not got, got)
        got = anchor_fails(u2)
        check("delist then re-add: --release-anchor fails", any("changed slot" in f for f in got), got)

        r = commit({snap: None, f"{FIXTURES_REL}/Renamed.json": live, listing: "Renamed\n"},
                   "the proxied contract renamed, its snapshot carried over")
        got = anchor_fails(r)
        check("rename: a contract proxied at the release that proxied.txt no longer lists fails --release-anchor",
              any("does not list it" in f for f in got), got)
    return fails


def cmd_selftest() -> int:
    """Prove each rule fires on a mutated record, and the allowed changes pass."""
    listed = _listed()
    # A basket kind: it has both storage gaps (AdminFloorAccessControlCounter and BasketVault).
    subject = next((c for c in listed if c.endswith("BasketVault") or c == "ProtocolAssetVault"), listed[0])
    live = normalize(subject)
    fails = 0

    def expect(label: str, old: dict, new: dict, want_fail: bool, release_pins: bool = True) -> None:
        nonlocal fails
        got = compare(old, new, release_pins)
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

    # Enums: a stored enum is its member's index, so only an appended member keeps every stored value.
    def with_enum(*members):
        return mutated(lambda d: d["enums"].update({"enum SelfTest.Mode": list(members)}))
    enum_old = with_enum("Active", "DepositsPaused", "Retired")
    expect("an enum member appended at the end passes", enum_old, with_enum("Active", "DepositsPaused", "Retired", "Sunset"), False)
    expect("an enum member inserted before the last member fails", enum_old, with_enum("Active", "DepositsPaused", "Paused", "Retired"), True)
    expect("reordered enum members fail", enum_old, with_enum("Active", "Retired", "DepositsPaused"), True)
    expect("a removed enum member fails", enum_old, with_enum("Active", "DepositsPaused"), True)
    expect("a renamed enum member fails", enum_old, with_enum("Active", "DepositsPaused", "Closed"), True)
    if live["enums"] and all(live["enums"].values()):
        print(f"ok   {subject}'s storage enums are recorded with their members: {sorted(live['enums'])}")
    else:
        fails += 1
        print(f"FAIL {subject} records no storage enum members (enums={live['enums']}): the enum rule would be vacuous")
    enum_src = (
        "enum Top { X, Y }\n"
        "library L { enum Venue { V3, V4, /* note */ Aerodrome } }\n"
        'contract C { string s = "contract Z { enum Fake { Q } }"; // enum Fake2 { R }\n'
        "  struct S { uint8 a; } enum Status { Active, DepositsPaused, Retired }\n"
        "  function f() public { if (true) { } } }\n"
        "abstract contract D is C { enum Status { One } }\n"
    )
    want = {"Top": ["X", "Y"], "L.Venue": ["V3", "V4", "Aerodrome"],
            "C.Status": ["Active", "DepositsPaused", "Retired"], "D.Status": ["One"]}
    got_enums = enum_definitions(enum_src)
    if got_enums == want:
        print("ok   enum definitions are read per scope, past comments, strings and nested braces")
    else:
        fails += 1
        print(f"FAIL enum_definitions read {got_enums}, expected {want}")

    expect("a reordered linearization fails", live, mutated(lambda d: d["linearization"].reverse()), True)
    expect("a missing GovernedUpgrade fails", live, mutated(lambda d: d.update(linearization=[x for x in d["linearization"] if not x.endswith(":" + BASE)])), True)
    if live["libraries"]:
        l0 = next(iter(live["libraries"]))
        expect("a changed library fails", live, mutated(lambda d: d["libraries"].update({l0: "0x" + "00" * 32})), True)
        expect("a removed library fails", live, mutated(lambda d: d["libraries"].pop(l0)), True)
    expect("an added library fails", live, mutated(lambda d: d["libraries"].update({"contracts/lib/X.sol:X": "0x" + "11" * 32})), True)
    expect("an OpenZeppelin commit change fails", live, mutated(lambda d: d["openzeppelin"].update({OZ_SUBMODULES[0]: "0" * 40})), True)

    # --base: the committed snapshot against the base branch's. The same-tree compare reads its reference
    # from the change under test, so a change that also reruns --write passes it whatever it did.
    moved = mutated(lambda d: d["storage"][mid].update(slot=d["storage"][mid]["slot"] + 7))
    if not compare(moved, copy.deepcopy(moved)) and compare(live, moved, release_pins=False):
        print("ok   base S, committed S' with a moved slot, live == S': the same-tree compare passes and --base fails")
    else:
        fails += 1
        print("FAIL a snapshot rewritten with --write to move a slot was not caught by the --base compare")
    expect("--base: a variable appended at the end passes", live, mutated(append_end), False, release_pins=False)
    expect("--base: an enum member inserted before the last member fails", enum_old,
           with_enum("Active", "Paused", "DepositsPaused", "Retired"), True, release_pins=False)
    if live["structs"]:
        s1 = next(iter(live["structs"]))
        expect("--base: a field appended to a storage struct fails", live,
               mutated(lambda d: d["structs"][s1].append({"label": "x", "slot": 99, "offset": 0, "type": "uint256"})), True, release_pins=False)
    expect("--base: a missing GovernedUpgrade fails", live, mutated(lambda d: d.update(linearization=[x for x in d["linearization"] if not x.endswith(":" + BASE)])), True, release_pins=False)
    expect("--base: an OpenZeppelin commit a release recorded is a note, not a failure", live,
           mutated(lambda d: d["openzeppelin"].update({OZ_SUBMODULES[0]: "0" * 40})), False, release_pins=False)
    legacy = {k: v for k, v in live.items() if k != "enums"}
    expect("--base: a base snapshot from before enums were recorded still holds the storage rules", legacy, moved, True, release_pins=False)

    # Security round 3 (review: SECURITY_LAYOUT_GATE_GAP): the committed snapshot must be the code's layout.
    def verdict(label: str, ok: bool, detail: object = "") -> None:
        nonlocal fails
        if ok:
            print(f"ok   {label}")
        else:
            fails += 1
            print(f"FAIL {label}: {detail}")

    def same_tree(snapshot: dict, code: dict) -> list[str]:
        problems, drift = same_tree_problems(snapshot, code)
        return problems + drift

    def row_at(label: str, slot: int) -> dict:
        return {"contract": live["storage"][-1]["contract"], "label": label, "slot": slot, "offset": 0,
                "bytes": 32, "type": "uint256"}

    # R1 appends V and skips --write; R2 inserts W before V, which moves V one slot on. The append rule alone
    # passes both against S, so S's layout identifier would stay on builds that hold V.
    r1 = mutated(lambda d: d["storage"].append(row_at("V", last_end)))
    r2 = mutated(lambda d: d["storage"].extend([row_at("W", last_end), row_at("V", last_end + 1)]))
    got = same_tree(live, r1)
    verdict("same tree: code S plus an appended V against snapshot S (no --write) fails",
            any("does not record it" in f for f in got), got)
    got = same_tree(live, r2)
    verdict("same tree: code S plus W, then V a slot later, against snapshot S fails (the append rule alone passes it)",
            not compare(live, r2) and any("does not record it" in f for f in got), got)
    verdict("same tree: code S against snapshot S passes", not same_tree(live, copy.deepcopy(live)),
            same_tree(live, copy.deepcopy(live)))
    verdict("--base: snapshot S, then snapshot R1 written with --write: the append passes", not compare(live, r1, release_pins=False),
            compare(live, r1, release_pins=False))
    if live["enums"]:
        e0 = next(iter(live["enums"]))
        got = same_tree(live, mutated(lambda d: d["enums"][e0].append("Unrecorded")))
        verdict("same tree: an enum member appended in the code and not recorded in the snapshot fails",
                any(e0 in f for f in got), got)

    # A struct whose member is an enum: deleting both from the newer record hid a changed struct or a reordered enum.
    held = next((s for s, ms in live["structs"].items() if any(_ENUM_REF.search(m["type"]) for m in ms)), None)
    if held is None:
        fails += 1
        print(f"FAIL selftest subject {subject} stores no struct with an enum member to exercise")
    else:
        inner = {m.group(0) for x in live["structs"][held] for m in _ENUM_REF.finditer(x["type"])}

        def drop(d):
            del d["structs"][held]
            for e in inner:
                d["enums"].pop(e, None)
        dropped = mutated(drop)
        got = compare(live, dropped, release_pins=False)
        verdict(f"--base: a committed snapshot that still stores {held!r} but drops it and {sorted(inner)} fails",
                any(held in f for f in got), got)
        got = compare(live, dropped)
        verdict("same-tree rules: a newer record that drops a stored struct and its enum fails", bool(got), got)
        got = same_tree(dropped, live)
        verdict(f"same tree: a snapshot with {held!r} and its enum deleted by hand fails against the code",
                any("does not record it" in f for f in got), got)
        only_enum = mutated(lambda d: [d["enums"].pop(e, None) for e in inner])
        got = compare(live, only_enum, release_pins=False)
        verdict(f"--base: a committed snapshot that keeps {held!r} but drops {sorted(inner)} fails",
                all(any(e in f for f in got) for e in inner), got)

    # --base and --release-anchor over a real git history, through the same base_compare CI runs.
    fails += _selftest_history(live, moved, mutated(append_end))

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
        if argv and argv[0] == "--base":
            if len(argv) < 2 or argv[1].startswith("-"):
                print("--base needs a git ref (the PR base or the previous branch tip)", file=sys.stderr)
                return 2
            return cmd_base(argv[1], argv[2:])
        if argv and argv[0] == "--release-anchor":
            return cmd_release_anchor(argv[1:])
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
