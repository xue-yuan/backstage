// Plan summary: the staged ops grouped by what they do, e.g. "Inbox / 0425 → 12 songs into Future House".
// Each group lists its items (one song, one duplicate merge, one crate edit…) so any of them can be undone alone.
// Pure data: takes the plan's changes and the effective library, returns groups for the Plan view.
import { _, _n } from './i18n.js';

const STRUCTURE = ['createCrate', 'renameCrate', 'moveCrate', 'deleteCrate', 'mergeCrate'];

/**
 * The removal from the source crate staged together with an add (sorting with "remove from the
 * source crate"). Older plans did not record the source: then any removal of the same song in the
 * same change counts.
 */
export function pairedRemove(change, add) {
  return change.ops.find(
    (o) => o.type === 'remove' && o.asset === add.asset && (add.source != null ? o.crate === add.source : o.crate !== add.crate),
  );
}

/**
 * Ops that stop making sense once `ops` are undone: everything that uses a crate they create
 * (songs added to it, crates created or moved under it…), with the source removals paired to those adds.
 */
export function dependentOps(changes, ops) {
  const created = new Set(ops.filter((o) => o.type === 'createCrate').map((o) => o.id));
  if (!created.size) return [];
  const all = changes.flatMap((c) => c.ops);
  for (let grew = true; grew; ) {
    grew = false;
    for (const o of all) {
      if (o.type === 'createCrate' && created.has(o.parent) && !created.has(o.id)) {
        created.add(o.id);
        grew = true;
      }
    }
  }
  const uses = (o) => [o.crate, o.parent, o.into, o.type === 'mergeCrate' ? o.from : null, o.type === 'createCrate' ? o.id : null].some((r) => r != null && created.has(r));
  const out = new Set();
  for (const ch of changes) {
    for (const o of ch.ops) {
      if (ops.includes(o) || !uses(o)) continue;
      out.add(o);
      if (o.type === 'add') {
        const pair = pairedRemove(ch, o);
        if (pair && !ops.includes(pair)) out.add(pair);
      }
    }
  }
  return [...out];
}

/**
 * changes: the plan's changes; eff: effective library (applyPlan); skip: ids of unsorted crates;
 * trackLabel(id): display name of a song; issues: eff.issues.
 * Returns [{ key, title, meta, at, items: [{ key, text, tag, ops, at, issue }] }], most recent first.
 */
export function summarizePlan({ changes, eff, skip, trackLabel, issues = [] }) {
  const issueOf = new Map(issues.map((i) => [i.op, i.message]));
  const groups = new Map();
  const groupFor = (key, info) => {
    if (!groups.has(key)) groups.set(key, { key, ...info, items: new Map(), at: 0 });
    return groups.get(key);
  };
  const addItem = (group, key, at, ops, fields = {}) => {
    const item = group.items.get(key);
    if (item) {
      item.ops.push(...ops);
      item.at = Math.max(item.at, at);
    } else group.items.set(key, { key, at, ops: [...ops], ...fields });
    group.at = Math.max(group.at, at);
  };
  // Where a song was sorted from when the plan did not record it: its only unsorted crate in Serato.
  const guessSource = (asset) => {
    const own = (eff.base.baseCratesOf.get(asset) || []).filter((c) => skip.has(c));
    return own.length === 1 ? own[0] : null;
  };

  for (const ch of changes) {
    const used = new Set();
    // Duplicate merges and missing-file fixes are tagged by Cleanup: one item per group / song.
    for (const op of ch.ops) {
      if (op.group != null) {
        addItem(groupFor('dupes', { kind: 'dupes' }), `dupe:${op.group}`, ch.at, [op]);
        used.add(op);
      } else if (op.missing != null) {
        addItem(groupFor('missing', { kind: 'missing' }), `missing:${op.missing}`, ch.at, [op], { asset: op.missing });
        used.add(op);
      }
    }
    for (const op of ch.ops) {
      if (used.has(op) || op.type !== 'add') continue;
      const pair = pairedRemove(ch, op);
      const from = op.source ?? pair?.crate ?? guessSource(op.asset);
      const ops = pair && !used.has(pair) ? [op, pair] : [op];
      for (const o of ops) used.add(o);
      const group = groupFor(`add:${from ?? ''}>${op.crate}`, { kind: 'add', from, to: op.crate });
      addItem(group, `add:${ch.id}:${op.crate}:${op.asset}`, ch.at, ops, { asset: op.asset, movedOut: ops.length > 1 });
    }
    for (const op of ch.ops) {
      if (used.has(op)) continue;
      const key = `${ch.id}:${ch.ops.indexOf(op)}`;
      if (op.type === 'remove') addItem(groupFor(`remove:${op.crate}`, { kind: 'remove', crate: op.crate }), key, ch.at, [op], { asset: op.asset });
      else if (op.type === 'removeTrack') addItem(groupFor(op.deleteFile ? 'reject' : 'removeTrack', { kind: op.deleteFile ? 'reject' : 'removeTrack' }), key, ch.at, [op], { asset: op.asset, reason: op.reason });
      else if (op.type === 'relocate') addItem(groupFor('relocate', { kind: 'relocate' }), key, ch.at, [op]);
      else if (op.type === 'importTrack') addItem(groupFor(`import:${op.crate ?? ''}`, { kind: 'import', crate: op.crate ?? null }), key, ch.at, [op]);
      else if (STRUCTURE.includes(op.type)) {
        const kind = op.type === 'moveCrate' && op.reorder ? 'reorderCrate' : op.type;
        addItem(groupFor(kind, { kind }), key, ch.at, [op]);
      }
      else addItem(groupFor('other', { kind: 'other' }), key, ch.at, [op]);
    }
  }

  const out = [];
  for (const g of groups.values()) {
    const items = [...g.items.values()].sort((a, b) => b.at - a.at);
    for (const it of items) {
      it.text = itemText(g, it, trackLabel);
      it.issue = it.ops.map((o) => issueOf.get(o)).find(Boolean) || null;
    }
    const { title, meta } = groupTitle(g, items, eff);
    out.push({ key: g.key, kind: g.kind, from: g.from, to: g.to, crate: g.crate, title, meta, at: g.at, items, issues: items.filter((i) => i.issue).length });
  }
  return out.sort((a, b) => b.at - a.at);
}

function itemText(g, it, trackLabel) {
  switch (g.kind) {
    case 'add':
    case 'remove':
      return trackLabel(it.asset);
    case 'reject':
    case 'removeTrack':
      return it.reason ? _('summary.trackReason', { track: trackLabel(it.asset), reason: it.reason }) : trackLabel(it.asset);
    case 'dupes': {
      const keeper = it.ops.find((o) => o.keeper != null)?.keeper;
      const removed = it.ops.filter((o) => o.type === 'removeTrack');
      const trashed = removed.filter((o) => o.deleteFile).length;
      const text = _n(removed.length, 'summary.keepCopy', { keeper: keeper != null ? trackLabel(keeper) : '?' });
      return trashed ? `${text}${_n(trashed, 'summary.filesToTrash')}` : text;
    }
    case 'import':
      return it.ops[0].path.slice(it.ops[0].path.lastIndexOf('/') + 1);
    case 'missing': {
      const relocate = it.ops.find((o) => o.type === 'relocate');
      return relocate ? _('summary.trackRelocated', { track: trackLabel(it.asset), path: relocate.path }) : _('summary.trackMerged', { track: trackLabel(it.asset) });
    }
    default:
      return it.ops.map((o) => o.text || o.type).join(' · ');
  }
}

function groupTitle(g, items, eff) {
  const n = items.length;
  const path = (id) => eff.pathOf(id);
  switch (g.kind) {
    case 'add': {
      const moved = items.filter((i) => i.movedOut).length;
      const title = g.from != null
        ? _n(n, 'summary.sortedInto', { from: path(g.from), to: path(g.to) })
        : _n(n, 'summary.addedTo', { to: path(g.to) });
      const meta = !moved ? '' : moved === n ? _('summary.leftSource') : _n(moved, 'summary.leftSourceCount');
      return { title, meta };
    }
    case 'remove':
      return { title: _n(n, 'summary.removedFrom', { crate: path(g.crate) }) };
    case 'reject':
      return { title: _n(n, 'summary.rejected') };
    case 'removeTrack':
      return { title: _n(n, 'summary.removedFromLibrary') };
    case 'dupes':
      return { title: _n(n, 'summary.duplicatesMerged') };
    case 'missing':
      return { title: _n(n, 'summary.missingFixed') };
    case 'relocate':
      return { title: _n(n, 'summary.relocatedFiles') };
    case 'import':
      return {
        title: g.crate != null && eff.crates.has(g.crate)
          ? _n(n, 'summary.importInto', { crate: path(g.crate) })
          : _n(n, 'summary.importLibrary'),
        meta: _('summary.importNote'),
      };
    default: {
      if (n === 1) return { title: items[0].text };
      const title = {
        createCrate: 'summary.cratesCreated',
        renameCrate: 'summary.cratesRenamed',
        moveCrate: 'summary.cratesMoved',
        reorderCrate: 'summary.cratesReordered',
        deleteCrate: 'summary.cratesDeleted',
        mergeCrate: 'summary.cratesMerged',
        other: 'summary.otherActions',
      }[g.kind];
      return { title: _n(n, title) };
    }
  }
}
