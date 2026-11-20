#!/usr/bin/env python3
"""Nested struct layout for scripts/ci/check-core-storage-layout.sh (Deploy 4 v0.9.0 upgrade audit, regression test 1).

The gate used to list an ERC-7201 namespace as the flat source lines of its struct (`mapping(uint256 id => Request)
requests;`), so the MEMBERS of a struct reached through that mapping were never compared. Release v0.9.0 changed
`Request`, `Settlement` and `StepParams` in the middle and the gate passed.

  nested <raw-layout.json>
      Every struct type in the `types` section of a `forge inspect <C> storageLayout --json` layout, as
      {type: {bytes, arrayElement, members: [{label, slot, offset, type}]}}. solc lists every type reachable from
      the layout (through mappings, arrays and nested structs), each struct member with its slot and offset
      relative to the struct. `arrayElement` is true when the struct is the element of a static or dynamic array:
      its size is then the element stride, so growing it into a new slot moves every later element.

  labels <raw-layout.json>
      The member labels of the struct the layout's single state variable holds (the probe's root struct).

  check --live <snapshot> --base <snapshot> --contract <name> --migrations <file> --ref <name> [--abi <artifact>]
      The append-only rule. Every struct of the baseline must be a prefix of the same struct in the live layout:
      a struct may only gain members at its end. A reorder, removal, retype or mid-struct insert fails and names
      the struct and the member. An array-element struct may not change size. A break passes only when the
      migrations file declares it: contract, struct, the hash of the baseline members, the hash of the live
      members, and the migration function that rewrites the legacy entries. With --abi the migration function
      must also exist in that artifact's ABI.

  hashes <snapshot>
      The layout hash of every struct in a snapshot (what a migrations entry names as `from` and `to`).

A layout hash is sha256 over the compact, key-sorted JSON of the member rows [{label, offset, slot, type}].
Exit codes: 0 ok; 1 a struct breaks the rule; 2 input error.
"""
import argparse
import hashlib
import json
import re
import sys

ME = "check-core-storage-layout"
_ID = re.compile(r"\)[0-9]+")
_MIGRATION = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$")
_HASH = re.compile(r"^[0-9a-f]{64}$")
ROW = ("label", "slot", "offset", "type")


def die(msg):
    print(f"{ME}: {msg}", file=sys.stderr)
    sys.exit(2)


def noid(type_id):
    """Strip solc's AST ids from a type id (the same rule as the gate's jq `noid`)."""
    return _ID.sub(")", type_id)


def load(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError) as exc:
        die(f"cannot read {path}: {exc}")


def layout_hash(members):
    rows = [{k: m[k] for k in ROW} for m in members]
    return hashlib.sha256(json.dumps(rows, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def nested_of(raw):
    types = raw.get("types") or {}
    arrayed = set()
    for t in types.values():
        base = t.get("base")
        if base is None:
            continue
        # An array of arrays of a struct: the struct is still the stride of the innermost array.
        while base in types and types[base].get("base") is not None:
            base = types[base]["base"]
        arrayed.add(base)
    out = {}
    for type_id, t in types.items():
        if t.get("members") is None:
            continue
        key = noid(type_id)
        entry = {
            "bytes": int(t["numberOfBytes"]),
            "arrayElement": type_id in arrayed,
            "members": [{"label": m["label"], "slot": m["slot"], "offset": m["offset"], "type": noid(m["type"])}
                        for m in t["members"]],
        }
        if key in out and out[key] != entry:
            die(f"two different structs share the type name {key}: the snapshot cannot tell them apart")
        out[key] = entry
    return out


def cmd_nested(args):
    print(json.dumps(nested_of(load(args.layout)), sort_keys=True))


def cmd_labels(args):
    raw = load(args.layout)
    rows = raw.get("storage") or []
    if len(rows) != 1:
        die(f"a layout probe must hold exactly one state variable, {args.layout} holds {len(rows)}")
    root = (raw.get("types") or {}).get(rows[0]["type"]) or {}
    if root.get("members") is None:
        die(f"the state variable of the layout probe {args.layout} is not a struct")
    print(json.dumps([m["label"] for m in root["members"]]))


def scopes_of(snapshot):
    """{scope: {struct: entry}}. A snapshot older than the nested section pins its sequential structs in `structs`."""
    if isinstance(snapshot.get("nested"), dict):
        return snapshot["nested"]
    return {"storage": {k: {"members": v} for k, v in (snapshot.get("structs") or {}).items()}}


def short(struct):
    m = re.match(r"^t_struct\((.+)\)_storage$", struct)
    return m.group(1) if m else struct


def where(m):
    return f"slot {m['slot']} offset {m['offset']}"


def violation(struct, old, new):
    """The first reason `new` is not `old` plus appended members, or None."""
    name = short(struct)
    if new is None:
        return f"struct {name}: the struct is no longer in the layout"
    om, nm = old["members"], new["members"]
    new_labels = [m["label"] for m in nm]
    old_labels = [m["label"] for m in om]
    for i, o in enumerate(om):
        n = nm[i] if i < len(nm) else None
        if n is not None and all(o[k] == n[k] for k in ROW):
            continue
        label = o["label"]
        if n is None or (n["label"] != label and label not in new_labels):
            return f"struct {name}: member {label} ({o['type']}, {where(o)}) was removed"
        if n["label"] != label:
            moved = nm[new_labels.index(label)]
            if n["label"] not in old_labels:
                return (f"struct {name}: member {n['label']} was inserted before {label}, "
                        f"which moved from {where(o)} to {where(moved)}")
            return f"struct {name}: member {label} was reordered, from {where(o)} to {where(moved)}"
        if n["type"] != o["type"]:
            return f"struct {name}: member {label} was retyped from {o['type']} to {n['type']} ({where(o)})"
        return f"struct {name}: member {label} moved from {where(o)} to {where(n)}"
    if (old.get("arrayElement") or new.get("arrayElement")) and "bytes" in old and "bytes" in new \
            and old["bytes"] != new["bytes"]:
        grown = nm[len(om)]["label"] if len(nm) > len(om) else om[-1]["label"]
        return (f"struct {name}: it is an array element and its size changed from {old['bytes']} to "
                f"{new['bytes']} bytes (member {grown}), so every element after the first moves")
    return None


def load_migrations(path):
    doc = load(path)
    entries = doc.get("migrations")
    if not isinstance(entries, list):
        die(f"{path}: `migrations` must be a list")
    for e in entries:
        for field in ("contract", "struct", "from", "to", "migration"):
            if not isinstance(e.get(field), str) or not e[field]:
                die(f"{path}: a migrations entry lacks `{field}`: {json.dumps(e)}")
        if not _HASH.match(e["from"]) or not _HASH.match(e["to"]):
            die(f"{path}: `from` and `to` of {e['contract']}.{e['struct']} must be sha256 layout hashes")
        if not _MIGRATION.match(e["migration"]):
            die(f"{path}: migration `{e['migration']}` must be Contract.function")
    return entries


def abi_functions(path):
    return {x.get("name") for x in (load(path).get("abi") or []) if x.get("type") == "function"}


def cmd_check(args):
    live, base = scopes_of(load(args.live)), scopes_of(load(args.base))
    migrations = load_migrations(args.migrations)
    functions = abi_functions(args.abi) if args.abi else None
    bad = []
    for scope in sorted(base):
        for struct in sorted(base[scope]):
            old = base[scope][struct]
            new = (live.get(scope) or {}).get(struct)
            reason = violation(struct, old, new)
            if reason is None:
                continue
            h_from, h_to = layout_hash(old["members"]), layout_hash(new["members"] if new else [])
            declared = [e for e in migrations
                        if e["contract"] == args.contract and e["struct"] in (struct, short(struct))
                        and e["from"] == h_from and e["to"] == h_to]
            if declared:
                fn = declared[0]["migration"]
                if functions is not None and fn.split(".")[1] not in functions:
                    bad.append(f"{reason}; the declared migration {fn} is not a function of {args.contract}")
                    continue
                print(f"{ME}: {args.contract} {scope}: struct {short(struct)} breaks the layout of {args.ref}: "
                      f"declared, legacy entries are rewritten by {fn}")
                continue
            bad.append(f"{scope}: {reason} (no migration declared for {args.contract}, from {h_from} to {h_to})")
    if bad:
        print("\n".join(bad), file=sys.stderr)
        sys.exit(1)


def cmd_hashes(args):
    for scope, structs in sorted(scopes_of(load(args.snapshot)).items()):
        for struct, entry in sorted(structs.items()):
            print(f"{layout_hash(entry['members'])}  {scope}  {short(struct)}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("nested")
    p.add_argument("layout")
    p.set_defaults(fn=cmd_nested)
    p = sub.add_parser("labels")
    p.add_argument("layout")
    p.set_defaults(fn=cmd_labels)
    p = sub.add_parser("check")
    for flag in ("--live", "--base", "--contract", "--migrations", "--ref"):
        p.add_argument(flag, required=True)
    p.add_argument("--abi")
    p.set_defaults(fn=cmd_check)
    p = sub.add_parser("hashes")
    p.add_argument("snapshot")
    p.set_defaults(fn=cmd_hashes)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
