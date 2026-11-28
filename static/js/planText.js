// Text for the plan, made when it is shown: the plan itself stores only data (op types, ids, names
// the user typed, i18n keys with their parameters), so it reads in the current language and with the
// current crate names. Plans saved by older versions hold ready-made text (change.label, op.text);
// that text is shown only where the data to rebuild it is missing.
import { _, _n, has } from './i18n.js';

/**
 * Context for naming things: { eff, changes, quality(assetId) → label }.
 * eff: the effective library (model.applyPlan); changes: the plan's changes.
 */

/** Display name of a song: "Artist – Title", or the file name of a song the plan adds. */
export function trackName(ctx, id) {
  const t = ctx.eff.base.tracks.get(id);
  if (t) return t.artist ? `${t.artist} – ${t.title || t.fileName}` : t.title || t.fileName;
  const imported = findOp(ctx, (o) => o.type === 'importTrack' && o.id === id);
  return imported ? fileName(imported.path) : `#${id}`;
}

/** Full path of a crate as it is now; one the plan deletes or merges away keeps its last known path. */
export function crateName(ctx, id) {
  const { eff } = ctx;
  if (eff.crates.has(id)) return eff.pathOf(id);
  const base = eff.base;
  if (base.crates.has(id)) {
    const parts = [];
    for (let c = base.crates.get(id); c; c = c.parent === base.rootId ? null : base.crates.get(c.parent)) parts.unshift(c.name);
    return parts.join(' / ');
  }
  return findOp(ctx, (o) => o.type === 'createCrate' && o.id === id)?.name ?? `#${id}`;
}

/** A removal reason: an i18n key, or text saved by an older version. */
export function reasonText(reason) {
  return has(reason) ? _(reason) : reason || '';
}

/** Title of a change: { key, n?, params?, extra? } stored by Store.commit, or older ready-made text. */
export function changeTitle(ctx, change) {
  const t = change.title;
  if (!t) return change.label ?? '';
  if (t.fromOp) return opText(ctx, change.ops[0]);
  return [t, ...(t.extra || [])].map((part) => render(ctx, part)).join('');
}

function render(ctx, { key, n, params = {} }) {
  const p = {};
  for (const [name, value] of Object.entries(params)) p[name] = value && typeof value === 'object' && 'quality' in value ? ctx.quality(value.quality) : value;
  return n == null ? _(key, p) : _n(n, key, p);
}

/** What one op does, e.g. 'Add to "House / Opening": Artist – Title'. */
export function opText(ctx, op) {
  const crate = (id) => crateName(ctx, id);
  const track = (id) => trackName(ctx, id);
  const { eff } = ctx;
  switch (op.type) {
    case 'add':
      return _('op.addToCrate', { crate: crate(op.crate), track: track(op.asset) });
    case 'remove':
      return _('op.removeFromCrate', { crate: crate(op.crate), track: track(op.asset) });
    case 'createCrate':
      return op.parent === eff.rootId ? _('op.createCrateTop', { name: op.name }) : _('op.createCrateUnder', { name: op.name, parent: crate(op.parent) });
    case 'renameCrate':
      // Older plans did not keep the previous name; their text has it.
      return op.from == null && op.text ? op.text : _('op.renameCrate', { crate: op.from ?? crate(op.crate), name: op.name });
    case 'moveCrate': {
      if (op.before === undefined) {
        return op.parent === eff.rootId ? _('op.moveCrateTop', { crate: crate(op.crate) }) : _('op.moveCrateUnder', { crate: crate(op.crate), parent: crate(op.parent) });
      }
      const level = op.parent === eff.rootId ? _('store.levelTop') : _('store.levelCrate', { name: crate(op.parent) });
      const before = op.before != null ? crateName(ctx, op.before).split(' / ').pop() : null;
      if (op.reorder) return before != null ? _('op.reorderBefore', { crate: crate(op.crate), before }) : _('op.reorderEnd', { crate: crate(op.crate), level });
      return before != null ? _('op.moveBefore', { crate: crate(op.crate), level, before }) : _('op.moveEnd', { crate: crate(op.crate), level });
    }
    case 'deleteCrate':
      return _('op.deleteCrate', { crate: crate(op.crate) });
    case 'mergeCrate':
      return _('op.mergeCrate', { from: crate(op.from), into: crate(op.into) });
    case 'removeTrack': {
      if (op.deleteFile && op.reason === 'common.reject') return _('op.rejectTrack', { track: track(op.asset) });
      const main = op.deleteFile ? _('op.removeAndTrash', { track: track(op.asset) }) : _('op.removeTrack', { track: track(op.asset) });
      const reason = reasonText(op.reason);
      return `${main}${reason ? _('sep.reason', { reason }) : ''}`;
    }
    case 'relocate':
      return _('op.relocate', { track: track(op.asset), path: op.path });
    case 'importTrack': {
      if (op.crate == null) return _('op.import', { file: fileName(op.path) });
      const where = eff.crates.has(op.crate) || eff.base.crates.has(op.crate) ? crate(op.crate) : op.crateName ?? crate(op.crate);
      return _('op.importInto', { file: fileName(op.path), crate: where });
    }
    default:
      return op.text || op.type;
  }
}

function findOp(ctx, pred) {
  for (const ch of ctx.changes) for (const op of ch.ops) if (pred(op)) return op;
  return null;
}

function fileName(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}
