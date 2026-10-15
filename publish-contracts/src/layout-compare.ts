// Security round 1 (review: SECURITY_PROVENANCE_BYPASS): the append-only storage rules of scripts/ci/storage_layout_gate.py `compare` (ADR-0014 §8), applied by the
// upgrade-proxy row to the layout of the implementation a proxy runs now and the layout of the build it would install. The CI gate compares a checkout's code with that
// checkout's committed snapshot; nothing compared the LIVE layout with the NEW one, so a build whose snapshot was rewritten (or that was never seen by CI) could reorder
// state under a live proxy. The rules kept here are the storage rules, each failing the upgrade:
//   - an existing variable moves, changes type, offset or size, or disappears;
//   - a new variable sits anywhere but after the last existing one, except inside a storage gap (`__gap`) that shrinks from the front by exactly the slots it takes;
//   - a storage struct changes at all (a new field needs a new struct in a new mapping);
//   - a storage enum's existing members change in any way: members may only be appended (security round 2, review SECURITY_LAYOUT_GATE_GAP). A stored enum is its
//     member's index, and a reorder or an insert keeps every type label and struct member list byte-identical, so no other rule sees it: VaultRegistry.VaultStatus
//     reordered would read every Retired vault as DepositsPaused. A build snapshot that does not record the members of an enum its storage holds is refused too, and
//     with `requireEnums` (8453) so is either snapshot without an `enums` map while storage holds an enum (a snapshot recorded before enums were): nothing to compare;
//   - the build's snapshot stores a struct (or, with an enums map, an enum) it does not record (security round 3, review SECURITY_LAYOUT_GATE_GAP): the struct and enum
//     rules skip what the build leaves out, so deleting AssetInfo and Venue from the JSON by hand hid a changed struct or a reordered enum;
//   - the inheritance linearization differs in any way, or GovernedUpgrade is missing from it.
// Library code and the OpenZeppelin commits are code, not layout: the masked code compare (verify/codehash.ts, linked libraries followed) and the CI gate cover them.
// Keep in step with storage_layout_gate.py `compare`. This module is pure.

interface Row { contract?: string; label: string; slot: number; offset: number; bytes: number; type: string }
interface Member { label: string; slot: number; offset: number; type: string }
/**
 * The normalized layout record the gate writes (contracts/test/fixtures/storage-layout/<Artifact>.json); only the fields the storage rules read. `enums`: the members, in
 * declaration order, of every enum storage can hold, keyed by the enum's type label (`enum VaultRegistry.VaultStatus`); absent in a snapshot recorded before enums were.
 */
export interface LayoutSnapshot { contract?: string; storage: Row[]; structs: Record<string, Member[]>; enums?: Record<string, string[]>; linearization: string[] }

const GAP = "__gap";
const BASE = "GovernedUpgrade";
const slots = (bytes: number): number => Math.max(1, Math.floor((bytes + 31) / 32));

/** A snapshot read from JSON, or a reason it is not one. */
export function asLayoutSnapshot(x: unknown): LayoutSnapshot | string {
  const o = x as Partial<LayoutSnapshot> | null;
  if (!o || typeof o !== "object") return "not a JSON object";
  if (!Array.isArray(o.storage)) return "no storage list";
  if (!o.structs || typeof o.structs !== "object" || Array.isArray(o.structs)) return "no structs map";
  if (!Array.isArray(o.linearization)) return "no linearization list";
  for (const r of o.storage) if (typeof r?.label !== "string" || !Number.isInteger(r.slot) || !Number.isInteger(r.offset) || !Number.isInteger(r.bytes) || typeof r.type !== "string") return "a storage row lacks label, slot, offset, bytes or type";
  if (o.enums !== undefined) {
    if (!o.enums || typeof o.enums !== "object" || Array.isArray(o.enums)) return "the enums map is not a map";
    for (const [e, m] of Object.entries(o.enums)) if (!Array.isArray(m) || m.some((x) => typeof x !== "string")) return `enum ${JSON.stringify(e)} has no list of member names`;
  }
  return o as LayoutSnapshot;
}

/** Every type label `ref` matches in a snapshot's storage: a variable, a mapping key or value, an array element, or a member of a recorded storage struct. */
function storedTypesOf(s: LayoutSnapshot, ref: RegExp): Set<string> {
  const out = new Set<string>();
  const scan = (type: string): void => { for (const m of type.matchAll(ref)) out.add(m[0]); };
  for (const r of s.storage) scan(r.type);
  for (const members of Object.values(s.structs)) for (const m of members) if (typeof m?.type === "string") scan(m.type);
  return out;
}
/** Every enum type label a snapshot's storage reaches: a variable, a mapping key or value, an array element, or a member of a storage struct. */
export const storedEnumsOf = (s: LayoutSnapshot): Set<string> => storedTypesOf(s, /\benum [\w$.]+/g);
/** Every struct type label a snapshot's storage reaches (`struct BasketAssetConfigGuard.AssetInfo` from `struct BasketAssetConfigGuard.AssetInfo[]`). */
export const storedStructsOf = (s: LayoutSnapshot): Set<string> => storedTypesOf(s, /\bstruct [\w$.]+/g);

/** Rows keyed by (label, occurrence): two bases' `__gap` share a label, their order in the layout tells them apart. */
function keyed(rows: readonly Row[]): Map<string, Row> {
  const seen = new Map<string, number>();
  const out = new Map<string, Row>();
  for (const r of rows) {
    const n = seen.get(r.label) ?? 0;
    seen.set(r.label, n + 1);
    out.set(`${r.label}#${n}`, r);
  }
  return out;
}
const show = (k: string): string => (k.endsWith("#0") ? k.slice(0, -2) : k);

/**
 * Rule violations of `next` (the build's layout) against `live` (the layout the proxy runs now). Empty: the upgrade keeps every live slot where it is.
 * `requireEnums` (8453): a snapshot without an `enums` map is unreadable when storage holds an enum, because an insert or a reorder could not be seen.
 */
export function layoutAppendOnlyProblems(live: LayoutSnapshot, next: LayoutSnapshot, opt: { requireEnums?: boolean } = {}): string[] {
  const v: string[] = [];
  const name = next.contract ?? live.contract ?? "?";
  const oldRows = keyed(live.storage), newRows = keyed(next.storage);
  const oldEnd = Math.max(0, ...live.storage.map((r) => r.slot + slots(r.bytes)));
  const gapRoom: [number, number][] = [];
  for (const [k, o] of oldRows) {
    const n = newRows.get(k);
    if (o.label === GAP) {
      if (!n) { v.push(`${name}: storage gap ${show(k)} disappeared`); continue; }
      const oEnd = o.slot + slots(o.bytes), nEnd = n.slot + slots(n.bytes);
      if (nEnd !== oEnd || n.slot < o.slot || n.offset !== 0) v.push(`${name}: storage gap ${show(k)} must shrink from the front only (was slots ${o.slot}..${oEnd - 1}, now ${n.slot}..${nEnd - 1})`);
      else if (n.slot > o.slot) gapRoom.push([o.slot, n.slot]);
      continue;
    }
    if (!n) { v.push(`${name}: variable ${show(k)} disappeared`); continue; }
    for (const f of ["slot", "offset", "bytes", "type"] as const) if (n[f] !== o[f]) v.push(`${name}: variable ${show(k)} changed ${f}: ${JSON.stringify(o[f])} -> ${JSON.stringify(n[f])}`);
  }
  for (const [k, n] of newRows) {
    if (oldRows.has(k) || n.slot >= oldEnd) continue;
    if (!gapRoom.some(([lo, hi]) => lo <= n.slot && n.slot + slots(n.bytes) <= hi)) v.push(`${name}: new variable ${show(k)} at slot ${n.slot} is not appended after the last existing slot (${oldEnd - 1}) nor placed in a shrunken storage gap`);
  }
  for (const [s, members] of Object.entries(live.structs)) {
    if (!Object.hasOwn(next.structs, s)) continue; // no variable uses it any more (a removed variable fails above), or the build leaves it unrecorded (refused below)
    if (JSON.stringify(next.structs[s]) !== JSON.stringify(members)) v.push(`${name}: storage struct ${JSON.stringify(s)} changed (a new field needs a new struct)`);
  }
  // Security round 2: a stored enum is the index of its member, so only an append keeps every stored value's meaning (storage_layout_gate.py compare).
  const nextStored = storedEnumsOf(next);
  for (const [e, members] of Object.entries(live.enums ?? {})) {
    const now = next.enums?.[e];
    if (now === undefined) continue; // no variable reaches it any more (a removed or retyped variable fails above), or the build leaves it unrecorded (refused below)
    if (JSON.stringify(now.slice(0, members.length)) !== JSON.stringify(members)) v.push(`${name}: storage enum ${JSON.stringify(e)} changed its existing members ${JSON.stringify(members)} -> ${JSON.stringify(now)} (members may only be appended: every stored value is a member's index)`);
  }
  // Security round 3 (review: SECURITY_LAYOUT_GATE_GAP): the two loops above skip a struct or an enum the build's snapshot leaves out, and storedEnumsOf cannot see an
  // enum reached only through a struct the snapshot dropped. A build snapshot with `struct BasketAssetConfigGuard.AssetInfo` and its `enum BasketAssetConfigGuard.Venue`
  // deleted by hand therefore passed a changed struct or a reordered enum. The build's snapshot must record every struct, and (when it has an enums map) every enum, its
  // storage reaches, on every chain (storage_layout_gate.py unrecorded_types). A snapshot with no enums map at all is the requireEnums rule's below.
  for (const s of [...storedStructsOf(next)].sort()) if (!Object.hasOwn(next.structs, s)) v.push(`${name}: the build's layout snapshot stores ${JSON.stringify(s)} and records none of its members, so a changed member could not be seen`);
  if (next.enums !== undefined) for (const e of [...nextStored].sort()) if (!Object.hasOwn(next.enums, e)) v.push(`${name}: the build's layout snapshot stores ${JSON.stringify(e)} and records none of its members, so a reordered or inserted member could not be seen`);
  if (opt.requireEnums) {
    const stored = new Set([...storedEnumsOf(live), ...nextStored]);
    for (const [which, snap] of [["live", live], ["build's", next]] as const) {
      if (snap.enums === undefined && stored.size > 0) v.push(`${name}: the ${which} layout snapshot records no enum members (recorded before enums were) and storage holds ${[...stored].sort().join(", ")}: a reordered or inserted member could not be seen, so the compare is refused (ADR-0014 §8)`);
    }
  }
  if (JSON.stringify(next.linearization) !== JSON.stringify(live.linearization)) v.push(`${name}: inheritance linearization changed`);
  if (!next.linearization.some((x) => x.endsWith(`:${BASE}`))) v.push(`${name}: ${BASE} is missing from the linearization (ADR-0014 §3)`);
  return v;
}
