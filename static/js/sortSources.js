// Data for the Sort view: which songs a source holds, which are done, the tree of unsorted crates and
// the next crate to sort. Pure functions of the library (base, eff) and the unsorted-crate rules.
//
// A source is { kind: 'crate', id } | { kind: 'folder', path } | { kind: 'recent', days } | { kind: 'uncategorized' }.
import { addedInPlan, effectivePath, isClassified, liveTracks, pathKey } from './model.js';

/** Songs of a source. A crate keeps listing songs moved out of it in the plan (they show as sorted). */
export function sourceSongs(base, eff, src, now = Date.now()) {
  let list;
  if (src.kind === 'uncategorized') {
    list = [...base.tracks.values()].filter((t) => !(base.baseCratesOf.get(t.id) || []).length);
  } else if (src.kind === 'recent') {
    const cutoff = now / 1000 - src.days * 86400;
    list = [...base.tracks.values()].filter((t) => t.addedAt >= cutoff);
  } else if (src.kind === 'folder') {
    const prefix = `${pathKey(src.path)}/`;
    list = liveTracks(eff).filter((t) => pathKey(effectivePath(eff, t)).startsWith(prefix));
  } else {
    const ids = [...new Set([...(base.members.get(src.id) || []), ...(eff.members.get(src.id) || [])])];
    list = ids.map((id) => base.tracks.get(id)).filter(Boolean);
  }
  return list.filter((t) => !eff.removedTracks.has(t.id));
}

/**
 * Whether a song of `src` is done. As in the Folders report, a song is done once it sits in a crate
 * that is not unsorted; only when reorganising an already-sorted crate does "got another crate /
 * left this one" count.
 */
export function isDoneIn(eff, rules, src, t) {
  if (src.kind !== 'crate' || rules.skip.has(src.id)) return isClassified(eff, rules, t.id);
  if (addedInPlan(eff, t.id).some((c) => c !== src.id)) return true;
  return !(eff.members.get(src.id) || []).includes(t.id);
}

const SORTS = {
  added: (a, b) => b.addedAt - a.addedAt || a.id - b.id,
  bpm: (a, b) => (a.bpm || 999) - (b.bpm || 999),
  artist: (a, b) => (a.artist || '￿').localeCompare(b.artist || '￿') || (a.title || '').localeCompare(b.title || ''),
  title: (a, b) => (a.title || a.fileName).localeCompare(b.title || b.fileName),
};

/** Songs in the chosen order: 'added', 'bpm', 'artist', 'title', or 'order' (as listed in the crate). */
export function sortSongs(list, sort) {
  const by = SORTS[sort];
  return by ? list.slice().sort(by) : list;
}

/** Unsorted crates that still exist (Inbox and everything under it, plus any crate marked unsorted). */
export function unsortedCrates(eff, rules) {
  return [...rules.skip].filter((id) => eff.crates.has(id));
}

/**
 * The unsorted crates as a tree, in no particular order:
 * [{ id, total, left, leftIds (whole subtree), children, active, hasActive }]. A crate with no songs
 * of its own, no child crates and not the current source is left out. activeId: the current source crate.
 */
export function unsortedCrateTree(base, eff, rules, activeId = null) {
  const skip = rules.skip;
  const build = (id) => {
    const src = { kind: 'crate', id };
    const tracks = sourceSongs(base, eff, src);
    const left = tracks.filter((t) => !isDoneIn(eff, rules, src, t));
    const children = (eff.children.get(id) || []).filter((c) => skip.has(c)).map(build).filter(Boolean);
    const leftIds = new Set(left.map((t) => t.id));
    for (const c of children) for (const a of c.leftIds) leftIds.add(a);
    const active = id === activeId;
    const node = { id, total: tracks.length, left: left.length, leftIds, children, active, hasActive: active || children.some((c) => c.hasActive) };
    return node.total || children.length || active ? node : null;
  };
  const roots = unsortedCrates(eff, rules).filter((id) => !skip.has(eff.crates.get(id).parent));
  return roots.map(build).filter(Boolean);
}

/**
 * Order a crate tree so it stays stable while songs get sorted: a crate keeps the position it got when
 * first seen (`rank`: { ids: Map(id → position), next }), and new crates come in by songs left, then by name.
 */
export function orderCrateTree(nodes, eff, rank) {
  const fresh = nodes
    .filter((n) => !rank.ids.has(n.id))
    .sort((a, b) => b.leftIds.size - a.leftIds.size || eff.pathOf(a.id).localeCompare(eff.pathOf(b.id), undefined, { numeric: true }));
  for (const n of fresh) rank.ids.set(n.id, rank.next++);
  for (const n of nodes) n.children = orderCrateTree(n.children, eff, rank);
  return nodes.sort((a, b) => rank.ids.get(a.id) - rank.ids.get(b.id));
}

/** Crates with songs of their own, in list order (collapsed and finished ones included). */
export function crateOrder(nodes, out = []) {
  for (const n of nodes) {
    if (n.total) out.push(n);
    crateOrder(n.children, out);
  }
  return out;
}

/** The next crate after the active one (in list order, wrapping) that still has songs to sort. */
export function nextCrate(nodes) {
  const list = crateOrder(nodes);
  const i = list.findIndex((n) => n.active);
  for (let k = 1; k <= list.length; k++) {
    const n = list[(i + k) % list.length];
    if (!n.active && n.left) return n;
  }
  return null;
}

/** Songs of an unsorted crate that are already sorted elsewhere but still sit in it. */
export function staleSongs(eff, rules, crateId) {
  if (!rules.skip.has(crateId)) return [];
  return (eff.members.get(crateId) || []).filter((a) => isClassified(eff, rules, a));
}
