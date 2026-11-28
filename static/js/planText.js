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

/** A crate's own name (without its parents), wherever it is known from. */
export function crateOwnName(ctx, id) {
  const { eff } = ctx;
  return eff.crates.get(id)?.name ?? eff.base.crates.get(id)?.name ?? findOp(ctx, (o) => o.type === 'createCrate' && o.id === id)?.name ?? `#${id}`;
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
  for (const [name, value] of Object.entries(params)) {
    // { quality: songId, label }: the song's quality label now, or the one saved with it if the song is gone
    p[name] = value && typeof value === 'object' && 'quality' in value ? (ctx.quality(value.quality) ?? value.label ?? '') : value;
  }
  return n == null ? _(key, p) : _n(n, key, p);
}

/**
 * What one op does, e.g. 'Add to "House / Opening": Artist – Title'. Crates are named as they were at
 * that step of the plan (model.applyPlan records it), so a list of the steps reads in order.
 */
export function opText(ctx, op) {
  const { eff } = ctx;
  const at = eff.stepNames?.get(op) || {};
  const path = (field, id) => at[field] ?? crateName(ctx, id);
  const track = (id) => trackName(ctx, id);
  switch (op.type) {
    case 'add':
      return _('op.addToCrate', { crate: path('crate', op.crate), track: track(op.asset) });
    case 'remove':
      return _('op.removeFromCrate', { crate: path('crate', op.crate), track: track(op.asset) });
    case 'createCrate':
      return op.parent === eff.rootId ? _('op.createCrateTop', { name: op.name }) : _('op.createCrateUnder', { name: op.name, parent: path('parent', op.parent) });
    case 'renameCrate': {
      const from = op.from ?? at.name; // plans from before "from" was kept: the name at that step
      return from == null && op.text ? op.text : _('op.renameCrate', { crate: from ?? crateName(ctx, op.crate), name: op.name });
    }
    case 'moveCrate': {
      const moved = at.crate ?? crateOwnName(ctx, op.crate); // where it was, before the move
      if (op.before === undefined) {
        return op.parent === eff.rootId ? _('op.moveCrateTop', { crate: moved }) : _('op.moveCrateUnder', { crate: moved, parent: path('parent', op.parent) });
      }
      const level = op.parent === eff.rootId ? _('store.levelTop') : _('store.levelCrate', { name: path('parent', op.parent) });
      const before = op.before != null ? (at.before ?? crateOwnName(ctx, op.before)) : null;
      if (op.reorder) return before != null ? _('op.reorderBefore', { crate: moved, before }) : _('op.reorderEnd', { crate: moved, level });
      return before != null ? _('op.moveBefore', { crate: moved, level, before }) : _('op.moveEnd', { crate: moved, level });
    }
    case 'deleteCrate':
      return _('op.deleteCrate', { crate: path('crate', op.crate) });
    case 'mergeCrate':
      return _('op.mergeCrate', { from: path('from', op.from), into: path('into', op.into) });
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
      return _('op.importInto', { file: fileName(op.path), crate: at.crate ?? op.crateName ?? crateName(ctx, op.crate) });
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
