// App state: snapshot (base) + staged plan. Every edit is a "change" holding ops.
import { APPLY_SUPPORTED, applyPlan, buildBase, buildProfiles, classificationRules, effectivePath, pathKey } from './model.js';
import { describeQuality } from './quality.js';
import { prefs, toast } from './ui.js';
import { _, _n } from './i18n.js';

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

export const api = {
  library: () => request('GET', '/api/library'),
  refreshSnapshot: () => request('POST', '/api/snapshot', {}),
  plan: () => request('GET', '/api/plan'),
  savePlan: (plan) => request('PUT', '/api/plan', plan),
  relocateCandidates: () => request('GET', '/api/relocate-candidates'),
  folders: (refresh = false) => request('GET', `/api/folders${refresh ? '?refresh=1' : ''}`),
  reveal: (path) => request('POST', '/api/reveal', { path }),
  audioInfo: (items = false) => request('GET', `/api/audio-info${items ? '?items=1' : ''}`),
  startAudioInfo: () => request('POST', '/api/audio-info', {}),
  screen: () => request('GET', '/api/screen'),
  saveScreen: (screen) => request('PUT', '/api/screen', screen),
  rules: () => request('GET', '/api/rules'),
  saveRules: (rules) => request('PUT', '/api/rules', rules),
  trash: (paths) => request('POST', '/api/trash', { paths }),
  untrash: (paths) => request('POST', '/api/untrash', { paths }),
};

export const parseId = (v) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v);

const uid = () => Math.random().toString(36).slice(2, 10);
export const newCrateId = () => `new-${uid()}`;

class Store {
  constructor() {
    this.base = null;
    this.plan = { version: 1, changes: [] };
    this.eff = null;
    this.version = 0;
    this.listeners = new Set();
    this._profiles = null;
    this._rules = null;
    this.folderScan = null;
    this.audioInfo = new Map(); // pathKey -> [codec, bps, sampleRate, bitDepth]
    this.audioProgress = null; // { running, done, total } while files are being read
    this.screen = { reject: new Set(), keep: new Set() }; // marks for files not in Serato (saved on the server)
    this.lastTrashed = []; // paths moved to the Trash in the last batch (for one-click restore)
    this.ruleOverrides = {}; // crateId -> 'count' | 'skip' (saved on the server in rules.json)
    this._screenTimer = null;
    this._saveTimer = null;
    this.saving = false;
  }

  async load() {
    const [lib, plan, screen, rules] = await Promise.all([api.library(), api.plan(), api.screen(), api.rules()]);
    this.base = buildBase(lib);
    this.plan = { version: 1, changes: [], ...plan };
    this.screen = { reject: new Set(screen.reject || []), keep: new Set(screen.keep || []) };
    this.ruleOverrides = rules.overrides || {};
    // One-time move of overrides saved by older versions in this browser's storage.
    const legacy = prefs.get('classify.overrides', null);
    if (!rules.saved && legacy && Object.keys(legacy).length) {
      this.ruleOverrides = legacy;
      api.saveRules({ overrides: legacy }).catch(() => {});
    }
    this.recompute();
  }

  async refreshSnapshot() {
    const lib = await api.refreshSnapshot();
    this.base = buildBase(lib);
    this.recompute();
  }

  recompute() {
    this.eff = applyPlan(this.base, this.plan.changes);
    this._profiles = null;
    this._rules = null;
    this.notify();
  }

  notify() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  get profiles() {
    this._profiles ||= buildProfiles(this.eff);
    return this._profiles;
  }

  // ---- what counts as "classified" (see classificationRules); overrides live in this browser ----
  get rules() {
    this._rules ||= classificationRules(this.eff, this.classifyOverrides);
    return this._rules;
  }
  get classifyOverrides() {
    return this.ruleOverrides;
  }
  setClassifyOverride(crateId, value) {
    const next = { ...this.classifyOverrides };
    if (value) next[String(crateId)] = value;
    else delete next[String(crateId)];
    this.saveClassifyOverrides(next);
  }
  saveClassifyOverrides(overrides) {
    this.ruleOverrides = overrides;
    this._rules = null;
    this.notify();
    api.saveRules({ overrides }).catch((e) => toast(_('Could not save the unsorted settings: {error}', { error: e.message }), { tone: 'danger', timeout: 8000 }));
  }

  // ---- real codec / bit rate per file (read with afinfo on the server, cached there) ----
  async loadAudioInfo() {
    try {
      let status = await api.startAudioInfo();
      while (status.running) {
        this.audioProgress = status;
        this.notify();
        await new Promise((r) => setTimeout(r, 1000));
        status = await api.audioInfo();
      }
      const { items } = await api.audioInfo(true);
      this.audioInfo = new Map(Object.entries(items).map(([path, info]) => [pathKey(path), info]));
      this.audioProgress = status.error ? { error: status.error } : null;
    } catch (e) {
      this.audioProgress = { error: e.message };
    }
    this.notify();
  }

  /** Quality of the file at `path` (a Serato track's file when `track` is given). */
  qualityOf(path, track) {
    const p = path ?? (track ? effectivePath(this.eff, track) : '');
    return describeQuality(this.audioInfo.get(pathKey(p)), p, track);
  }
  trackQuality(t) {
    return this.qualityOf(null, t);
  }

  // ---- after Apply to Serato: drop the written ops, carry settings over to the real crate ids ----
  async afterApply(newIds) {
    this.plan.changes = this.plan.changes
      .map((ch) => ({ ...ch, ops: ch.ops.filter((o) => !APPLY_SUPPORTED.has(o.type)) }))
      .filter((ch) => ch.ops.length);
    const overrides = { ...this.ruleOverrides };
    let moved = false;
    for (const [tmp, real] of Object.entries(newIds)) {
      if (overrides[tmp]) {
        overrides[String(real)] = overrides[tmp];
        delete overrides[tmp];
        moved = true;
      }
    }
    if (moved) this.saveClassifyOverrides(overrides);
    this.persist();
    await this.refreshSnapshot();
  }

  // ---- screening files that are not in Serato: reject / keep ----
  /** mark: 'reject' | 'keep' | null (clear) */
  setScreenMark(paths, mark) {
    for (const p of paths) {
      this.screen.reject.delete(p);
      this.screen.keep.delete(p);
      if (mark) this.screen[mark].add(p);
    }
    this.notify();
    clearTimeout(this._screenTimer);
    this._screenTimer = setTimeout(async () => {
      try {
        await api.saveScreen({ reject: [...this.screen.reject], keep: [...this.screen.keep] });
      } catch (e) {
        toast(_('Could not save the screening marks: {error}', { error: e.message }), { tone: 'danger', timeout: 8000 });
      }
    }, 250);
  }

  /** Move files marked reject to the macOS Trash. Returns the server's per-file results. */
  async trashFiles(paths) {
    const { results } = await api.trash(paths);
    const done = results.filter((r) => r.ok).map((r) => r.path);
    if (done.length) {
      this.lastTrashed = done;
      this.setScreenMark(done, null);
    }
    await this.refreshSnapshot(); // the server took a fresh snapshot before trashing
    await this.loadFolders(true);
    return results;
  }

  async restoreFiles(paths) {
    const { results } = await api.untrash(paths);
    const back = new Set(results.filter((r) => r.ok).map((r) => r.path));
    this.lastTrashed = this.lastTrashed.filter((p) => !back.has(p));
    await this.loadFolders(true);
    return results;
  }

  // ---- disk scan for the folder report (read-only; cached on the server until refreshed) ----
  async loadFolders(refresh = false) {
    this.folderScan = await api.folders(refresh);
    this.notify();
    if (refresh && !this.audioProgress?.running) this.loadAudioInfo(); // read new files' format (cached ones are skipped)
    return this.folderScan;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  commit(label, ops, { silent = false } = {}) {
    ops = ops.filter(Boolean);
    if (!ops.length) return null;
    const change = { id: uid(), at: Date.now(), label, ops };
    const issuesBefore = this.eff.issues.length;
    this.plan.changes.push(change);
    this.recompute();
    const newIssues = this.eff.issues.slice(issuesBefore).filter((i) => i.changeId === change.id);
    if (newIssues.length) {
      // Reject edits that cannot be applied cleanly (e.g. name clash).
      this.plan.changes.pop();
      this.recompute();
      toast(_('Cannot apply: {error}', { error: newIssues[0].message }), { tone: 'danger' });
      return null;
    }
    this.persist();
    if (!silent) toast(label, { action: () => this.undo(change.id) });
    return change;
  }

  undo(changeId) {
    const idx = changeId ? this.plan.changes.findIndex((c) => c.id === changeId) : this.plan.changes.length - 1;
    if (idx < 0) return null;
    const [removed] = this.plan.changes.splice(idx, 1);
    this.recompute();
    this.persist();
    return removed;
  }

  /** Remove ops matching `pred` from every change (drops changes left empty). */
  revertOps(pred) {
    let touched = 0;
    for (const ch of this.plan.changes) {
      const before = ch.ops.length;
      ch.ops = ch.ops.filter((op) => !pred(op));
      touched += before - ch.ops.length;
    }
    this.plan.changes = this.plan.changes.filter((c) => c.ops.length);
    if (touched) {
      this.recompute();
      this.persist();
    }
    return touched;
  }

  findOps(pred) {
    return this.plan.changes.flatMap((c) => c.ops.filter(pred));
  }

  clearPlan() {
    this.plan.changes = [];
    this.recompute();
    this.persist();
  }

  persist() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(async () => {
      try {
        await api.savePlan({ ...this.plan, snapshotTakenAt: this.base?.snapshot?.takenAt });
      } catch (e) {
        toast(_('Could not save the plan: {error}', { error: e.message }), { tone: 'danger', timeout: 8000 });
      }
    }, 250);
  }

  // ---- naming helpers used when recording ops (text stays readable even after later ops) ----
  trackLabel(id) {
    const t = this.base.tracks.get(id);
    if (!t) return `#${id}`;
    return t.artist ? `${t.artist} – ${t.title || t.fileName}` : t.title || t.fileName;
  }
  crateLabel(id) {
    return this.eff.pathOf(id);
  }

  // ---- op builders ----
  opAdd(crate, asset) {
    return { type: 'add', crate, asset, text: _('Add to "{crate}": {track}', { crate: this.crateLabel(crate), track: this.trackLabel(asset) }) };
  }
  opRemove(crate, asset) {
    return { type: 'remove', crate, asset, text: _('Remove from "{crate}": {track}', { crate: this.crateLabel(crate), track: this.trackLabel(asset) }) };
  }
  opCreate(name, parent) {
    const id = newCrateId();
    const text =
      parent === this.eff.rootId
        ? _('Create crate "{name}" at the top level', { name })
        : _('Create crate "{name}" under "{parent}"', { name, parent: this.crateLabel(parent) });
    return { type: 'createCrate', id, name, parent, text };
  }
  opRename(crate, name) {
    return { type: 'renameCrate', crate, name, text: _('Rename "{crate}" → "{name}"', { crate: this.crateLabel(crate), name }) };
  }
  opMove(crate, parent) {
    const text =
      parent === this.eff.rootId
        ? _('Move "{crate}" to the top level', { crate: this.crateLabel(crate) })
        : _('Move "{crate}" under "{parent}"', { crate: this.crateLabel(crate), parent: this.crateLabel(parent) });
    return { type: 'moveCrate', crate, parent, text };
  }
  opDelete(crate) {
    return { type: 'deleteCrate', crate, text: _('Delete crate "{crate}"', { crate: this.crateLabel(crate) }) };
  }
  opMerge(from, into) {
    return { type: 'mergeCrate', from, into, text: _('Merge "{from}" into "{into}"', { from: this.crateLabel(from), into: this.crateLabel(into) }) };
  }
  /** deleteFile: also move the file to the Trash once the removal is written to Serato. */
  opRemoveTrack(asset, reason, { deleteFile = false } = {}) {
    const track = this.trackLabel(asset);
    const main = deleteFile ? _('Remove from the Serato library and move the file to the Trash: {track}', { track }) : _('Remove from the Serato library (file kept): {track}', { track });
    const op = { type: 'removeTrack', asset, reason, text: `${main}${reason ? _(' ({reason})', { reason }) : ''}` };
    if (deleteFile) op.deleteFile = true;
    return op;
  }
  /** Keep the file of a staged removal that would have moved it to the Trash (the removal itself stays). */
  keepFileOf(asset) {
    let touched = 0;
    for (const ch of this.plan.changes) {
      ch.ops = ch.ops.map((op) => {
        if (op.type !== 'removeTrack' || op.asset !== asset || !op.deleteFile) return op;
        touched++;
        const { deleteFile, ...rest } = op; // keep group / keeper / missing tags
        return { ...rest, ...this.opRemoveTrack(asset, op.reason) };
      });
    }
    if (touched) {
      this.recompute();
      this.persist();
    }
    return touched;
  }
  opReject(asset) {
    return { type: 'removeTrack', asset, reason: _('Reject'), deleteFile: true, text: _('Reject: remove from Serato and move the file to the Trash: {track}', { track: this.trackLabel(asset) }) };
  }
  opRelocate(asset, path) {
    return { type: 'relocate', asset, path, text: _('Relocate file: {track} → {path}', { track: this.trackLabel(asset), path }) };
  }
}

export const store = new Store();
