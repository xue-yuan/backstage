// App state: snapshot (base) + staged plan. Every edit is a "change" holding ops.
import { APPLY_SUPPORTED, applyPlan, buildBase, buildProfiles, classificationRules, effectivePath, pathKey } from './model.js';
import { describeQuality } from './quality.js';
import { prefs, toast } from './ui.js';

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
    api.saveRules({ overrides }).catch((e) => toast(`未分類設定儲存失敗：${e.message}`, { tone: 'danger', timeout: 8000 }));
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
        toast(`篩選標記儲存失敗：${e.message}`, { tone: 'danger', timeout: 8000 });
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
      toast(`無法套用：${newIssues[0].message}`, { tone: 'danger' });
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
        toast(`變更計畫儲存失敗：${e.message}`, { tone: 'danger', timeout: 8000 });
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
    return { type: 'add', crate, asset, text: `加入「${this.crateLabel(crate)}」：${this.trackLabel(asset)}` };
  }
  opRemove(crate, asset) {
    return { type: 'remove', crate, asset, text: `從「${this.crateLabel(crate)}」移除：${this.trackLabel(asset)}` };
  }
  opCreate(name, parent) {
    const id = newCrateId();
    const where = parent === this.eff.rootId ? '最上層' : `「${this.crateLabel(parent)}」底下`;
    return { type: 'createCrate', id, name, parent, text: `在${where}建立 crate「${name}」` };
  }
  opRename(crate, name) {
    return { type: 'renameCrate', crate, name, text: `重新命名「${this.crateLabel(crate)}」→「${name}」` };
  }
  opMove(crate, parent) {
    const where = parent === this.eff.rootId ? '最上層' : `「${this.crateLabel(parent)}」底下`;
    return { type: 'moveCrate', crate, parent, text: `把「${this.crateLabel(crate)}」移到${where}` };
  }
  opDelete(crate) {
    return { type: 'deleteCrate', crate, text: `刪除 crate「${this.crateLabel(crate)}」` };
  }
  opMerge(from, into) {
    return { type: 'mergeCrate', from, into, text: `把「${this.crateLabel(from)}」合併進「${this.crateLabel(into)}」` };
  }
  opRemoveTrack(asset, reason) {
    return { type: 'removeTrack', asset, reason, text: `從 Serato 資料庫移除（不刪檔案）：${this.trackLabel(asset)}${reason ? `（${reason}）` : ''}` };
  }
  opReject(asset) {
    return { type: 'removeTrack', asset, reason: '不要', deleteFile: true, text: `不要：從 Serato 移除，檔案丟到垃圾桶：${this.trackLabel(asset)}` };
  }
  opRelocate(asset, path) {
    return { type: 'relocate', asset, path, text: `重新指定檔案位置：${this.trackLabel(asset)} → ${path}` };
  }
}

export const store = new Store();
