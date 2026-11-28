// Folder status report: match files found on disk to Serato tracks and roll the status up per folder.
// Pure data (no DOM), used by the Folders view.
import { baseName, dirOf, effectivePath, isClassified, liveTracks, norm, pathKey } from './model.js';
import { fmt } from './ui.js';
import { _, _n } from './i18n.js';

export const STATUSES = ['classified', 'unsorted', 'notImported', 'copy', 'rejected', 'missing'];
export const LABEL = { classified: _('common.sorted'), unsorted: _('common.unsorted'), notImported: _('common.notImported'), copy: _('status.copy'), rejected: _('common.rejected'), missing: _('status.missing') };
export const HINT = {
  classified: _('status.sortedHint'),
  unsorted: _('status.unsortedHint'),
  notImported: _('status.notImportedHint'),
  copy: _('status.copyHint'),
  rejected: _('status.rejectedHint'),
  missing: _('status.missingHint'),
};
export const BAR = ['classified', 'unsorted', 'notImported', 'copy', 'rejected'];
const zero = () => ({ classified: 0, unsorted: 0, notImported: 0, copy: 0, rejected: 0, missing: 0, files: 0, low: 0, unreadable: 0, suspect: 0, kept: 0 });
export const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/**
 * Child folders of a report node for the folder tree: sorted by name, or with the most left to do
 * first ('todo'); hideDone leaves out finished folders except those with missing files and `keepKey`.
 */
export function folderChildren(node, { sortBy = 'name', hideDone = false, keepKey = null } = {}) {
  let list = node.children.slice();
  if (hideDone) list = list.filter((c) => !c.done || c.total.missing || c.key === keepKey);
  return list.sort(sortBy === 'todo' ? (a, b) => b.todo - a.todo || b.total.missing - a.total.missing || byName(a, b) : byName);
}

/** Files of a folder, with those of its subfolders (by name, depth first) when includeSub. */
export function folderFiles(node, includeSub) {
  if (!includeSub) return node.files;
  const out = [];
  const walk = (n) => {
    out.push(...n.files);
    n.children.slice().sort(byName).forEach(walk);
  };
  walk(node);
  return out;
}

/** Whether a file matches a search: every word appears in its file name or its song's title or artist. */
export function fileMatches(file, track, query) {
  if (!query) return true;
  const hay = `${file.name} ${track?.title || ''} ${track?.artist || ''}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

// "Serato already has this song": for a file Serato does not use, find live Serato tracks that are
// the same song by name, so importing the file would make a duplicate (Serato writes its analysis
// into the tags, so such copies are rarely byte-identical). A match is the same file name; or
// "Artist - Title" with the same title and a shared artist word; or a title of 3+ words on its own.
const ARTIST_STOP = new Set(['feat', 'ft', 'featuring', 'vs', 'x', 'and', 'with', 'the', 'dj', 'mc']);
const artistWords = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 1 && !ARTIST_STOP.has(w)));
const stemOf = (name) => name.replace(/\.[^./]+$/, '');

export function songMatcher(tracks) {
  const byFile = new Map();
  const byTitle = new Map();
  const add = (map, key, t) => key && map.set(key, [...(map.get(key) || []), t]);
  for (const t of tracks) {
    add(byFile, norm(stemOf(t.fileName || '')), t);
    add(byTitle, norm(t.title), t);
  }
  return (fileName) => {
    const stem = stemOf(fileName);
    const byName = byFile.get(norm(stem));
    if (byName) return byName;
    const dash = stem.indexOf(' - ');
    if (dash > 0) {
      const artists = artistWords(stem.slice(0, dash));
      const same = (byTitle.get(norm(stem.slice(dash + 3))) || []).filter((t) => {
        const theirs = artistWords(t.artist);
        return !theirs.size || [...artists].some((w) => theirs.has(w));
      });
      if (same.length) return same;
    }
    const title = norm(stem);
    return title.split(' ').length >= 3 ? byTitle.get(title) || null : null;
  };
}

// qualityOf(path, track?) -> describeQuality result (optional); used to count low-quality files.
// screen: { reject: Set<path>, keep: Set<path> } marks for files that are not in Serato.
export function buildReport(scan, eff, rules, qualityOf, screen) {
  const tracks = liveTracks(eff);
  const assetsAt = new Map(); // pathKey -> [assetId]
  for (const t of tracks) {
    const k = pathKey(effectivePath(eff, t));
    const list = assetsAt.get(k);
    if (list) list.push(t.id);
    else assetsAt.set(k, [t.id]);
  }
  const classified = (id) => isClassified(eff, rules, id);
  // Serato tracks the plan removes because the user does not want them (their file goes too).
  const rejectedAt = new Map();
  for (const id of eff.rejectedTracks || []) {
    const t = eff.base.tracks.get(id);
    if (t) rejectedAt.set(pathKey(effectivePath(eff, t)), id);
  }

  // Copy groups: which Serato tracks own a file in each group of byte-identical files.
  const groupAssets = new Map();
  const groupSize = new Map();
  const addGroup = (g, path) => {
    groupSize.set(g, (groupSize.get(g) || 0) + 1);
    const ids = assetsAt.get(pathKey(path));
    if (ids) groupAssets.set(g, [...(groupAssets.get(g) || []), ...ids]);
  };
  for (const [d, name, , , g] of scan.files) if (g != null) addGroup(g, `${scan.dirs[d]}/${name}`);
  for (const [path, g] of scan.outside) addGroup(g, path);

  const gone = new Set((scan.goneDirs || []).map(pathKey));
  const nodes = new Map();
  const roots = scan.roots.map((path) => {
    const node = { path, key: pathKey(path), name: fmt.shortPath(path), depth: 0, parent: null, children: [], files: [], direct: zero(), total: zero(), ghost: false };
    nodes.set(node.key, node);
    return node;
  });
  const rootFor = (p) => roots.find((r) => pathKey(p).startsWith(`${r.key}/`));
  const ensureNode = (path) => {
    const key = pathKey(path);
    let node = nodes.get(key);
    if (node) return node;
    const parent = ensureNode(dirOf(path));
    node = { path, key, name: baseName(path), depth: parent.depth + 1, parent, children: [], files: [], direct: zero(), total: zero(), ghost: gone.has(key) };
    parent.children.push(node);
    nodes.set(key, node);
    return node;
  };

  const matched = new Set();
  let matchSong = null; // built on first use
  const dirNodes = scan.dirs.map((d) => (rootFor(d) || nodes.get(pathKey(d)) ? ensureNode(d) : null));
  for (const [d, name, size, mtime, group] of scan.files) {
    const node = dirNodes[d];
    if (!node) continue;
    const path = `${scan.dirs[d]}/${name}`;
    const k = pathKey(path);
    const ids = assetsAt.get(k);
    const file = { path, name, size, mtime, group, node, status: 'notImported', assetId: null, twins: null, sameCopies: group != null ? groupSize.get(group) - 1 : 0 };
    if (ids) {
      matched.add(k);
      file.assetId = ids.find(classified) ?? ids[0];
      file.status = ids.some(classified) ? 'classified' : 'unsorted';
    } else if (rejectedAt.has(k)) {
      matched.add(k);
      file.status = 'rejected';
      file.viaPlan = true; // in Serato: removed and trashed when the plan is applied
      file.assetId = rejectedAt.get(k);
    } else if (screen?.reject.has(path)) {
      file.status = 'rejected';
    } else if (group != null && groupAssets.get(group)?.length) {
      file.status = 'copy';
      file.twins = groupAssets.get(group);
    }
    if (file.status === 'notImported') {
      const same = (matchSong ||= songMatcher(tracks))(name);
      if (same) file.inSerato = same.map((t) => t.id);
    }
    if ((file.status === 'notImported' || file.status === 'copy') && screen?.keep.has(path)) {
      file.kept = true;
      node.direct.kept++;
    }
    file.quality = qualityOf ? qualityOf(path, file.assetId != null ? eff.base.tracks.get(file.assetId) : undefined) : null;
    if (file.quality?.low) node.direct.low++;
    if (file.quality?.unreadable) node.direct.unreadable++;
    if (file.quality?.suspect) node.direct.suspect++;
    node.files.push(file);
    node.direct[file.status]++;
  }

  let outsideCount = 0;
  let outsideMissing = 0;
  for (const t of tracks) {
    const path = effectivePath(eff, t);
    if (matched.has(pathKey(path))) continue;
    const missing = !t.exists && !eff.relocated.has(t.id);
    if (!missing) {
      outsideCount++; // Serato reads it from somewhere the scan does not cover (e.g. ~/Desktop, _Serato_)
      continue;
    }
    if (!rootFor(path)) {
      outsideMissing++;
      continue;
    }
    const node = ensureNode(dirOf(path));
    node.files.push({ path, name: baseName(path), node, status: 'missing', assetId: t.id, sameCopies: 0 });
    node.direct.missing++;
  }

  const total = (node) => {
    const sum = { ...node.direct };
    sum.files = node.files.length - node.direct.missing;
    for (const child of node.children) {
      const c = total(child);
      for (const k of Object.keys(sum)) sum[k] += c[k];
    }
    node.total = sum;
    node.todo = sum.unsorted + sum.notImported;
    node.done = sum.files > 0 && node.todo === 0;
    return sum;
  };
  roots.forEach(total);

  const folderCrates = new Map(); // dir key -> [crate ids] dragged in as a whole folder
  for (const [id, a] of rules.auto) {
    if (a.kind !== 'folder' || !eff.crates.has(id)) continue;
    const k = pathKey(a.dir);
    folderCrates.set(k, [...(folderCrates.get(k) || []), id]);
  }

  const visibleRoots = roots.filter((r) => r.total.files || r.total.missing);
  const sum = zero();
  for (const r of visibleRoots) for (const k of Object.keys(sum)) sum[k] += r.total[k];
  return { roots: visibleRoots, nodes, sum, outsideCount, outsideMissing, folderCrates };
}

