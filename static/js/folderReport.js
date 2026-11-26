// Folder status report: match files found on disk to Serato tracks and roll the status up per folder.
// Pure data (no DOM), used by the Folders view.
import { baseName, dirOf, effectivePath, isClassified, liveTracks, pathKey } from './model.js';
import { fmt } from './ui.js';
import { _, _n } from './i18n.js';

export const STATUSES = ['classified', 'unsorted', 'notImported', 'copy', 'rejected', 'missing'];
export const LABEL = { classified: _('Sorted'), unsorted: _('Unsorted'), notImported: _('Not imported'), copy: _('Copy'), rejected: _('Rejected'), missing: _('Missing') };
export const HINT = {
  classified: _('In Serato and in at least one sorting crate'),
  unsorted: _('In Serato, but only in Inbox or folder crates, or in no crate'),
  notImported: _('On disk but not in Serato'),
  copy: _('Not imported, but identical to another file Serato uses (a duplicate copy)'),
  rejected: _('Marked as reject, not moved to the Trash yet'),
  missing: _('Serato expects the file here, but it is gone'),
};
export const BAR = ['classified', 'unsorted', 'notImported', 'copy', 'rejected'];
const zero = () => ({ classified: 0, unsorted: 0, notImported: 0, copy: 0, rejected: 0, missing: 0, files: 0, low: 0, unreadable: 0, kept: 0 });
export const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

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
    if ((file.status === 'notImported' || file.status === 'copy') && screen?.keep.has(path)) {
      file.kept = true;
      node.direct.kept++;
    }
    file.quality = qualityOf ? qualityOf(path, file.assetId != null ? eff.base.tracks.get(file.assetId) : undefined) : null;
    if (file.quality?.low) node.direct.low++;
    if (file.quality?.unreadable) node.direct.unreadable++;
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

