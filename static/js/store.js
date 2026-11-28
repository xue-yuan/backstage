// App state: snapshot (base) + staged plan. Every edit is a "change" holding ops.
import { APPLY_SUPPORTED, applyPlan, baseName, buildBase, buildProfiles, classificationRules, dirOf, effectivePath, pathKey } from './model.js';
import { describeQuality, suspicionOf } from './quality.js';
import { prefs, toast } from './ui.js';
import { _, _n } from './i18n.js';
import { changeTitle, crateName, opText, trackName } from './planText.js';

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `${res.status} ${res.statusText}`), { status: res.status });
  return data;
}

const withoutRev = ({ rev, ...rest }) => rest;

export const api = {
  library: () => request('GET', '/api/library'),
  refreshSnapshot: () => request('POST', '/api/snapshot', {}),
  /** A document the page edits as a whole: plan, screen, notes, rules or marks (see documents.py). */
  doc: (name) => request('GET', `/api/${name}`),
  relocateCandidates: () => request('GET', '/api/relocate-candidates'),
  folders: (refresh = false) => request('GET', `/api/folders${refresh ? '?refresh=1' : ''}`),
  reveal: (path) => request('POST', '/api/reveal', { path }),
  audioInfo: (items = false) => request('GET', `/api/audio-info${items ? '?items=1' : ''}`),
  startAudioInfo: () => request('POST', '/api/audio-info', {}),
  spectrum: (items = false) => request('GET', `/api/spectrum${items ? '?items=1' : ''}`),
  spectrumAction: (body) => request('POST', '/api/spectrum', body),
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
    this.spectrum = new Map(); // pathKey -> [cutoff kHz, kind] (spotting transcodes; needs ffmpeg)
    this.spectrumProgress = null; // { available, running, done, total }
    this.screen = { reject: new Set(), keep: new Set() }; // marks for files not in Serato (saved on the server)
    this.lastTrashed = []; // paths moved to the Trash in the last batch (for one-click restore)
    this.notes = []; // [{ id, text, song: { id?, path, title, artist } | null, created, updated }] newest first (notes.json)
    this.notesError = null; // set when notes.json could not be read: saving is then refused, so nothing is lost
    this.ruleOverrides = {}; // crateId -> 'count' | 'skip' (saved on the server in rules.json)
    // Saved on the server in marks.json: files marked genuine (path keys), dismissed duplicate groups, pinned crates.
    this.marks = { genuine: new Set(), dismissedDuplicates: new Set(), pinnedCrates: [] };
    this.revs = {}; // document name -> revision this page last read or wrote
    this.conflicts = new Set(); // documents another window changed: no longer saved from here
    this._saves = {}; // document name -> promise of the last save (saves of one document run in order)
    this._conflictToastAt = 0;
    this._screenTimer = null;
    this._saveTimer = null;
    this.saving = false;
  }

  async load() {
    const [lib, plan, screen, rules, notes, marks] = await Promise.all([
      api.library(),
      api.doc('plan'),
      api.doc('screen'),
      api.doc('rules'),
      api.doc('notes').catch((e) => ({ error: e.message })),
      api.doc('marks'),
    ]);
    for (const [name, doc] of Object.entries({ plan, screen, rules, notes, marks })) {
      if (typeof doc.rev === 'number') this.revs[name] = doc.rev;
    }
    this.base = buildBase(lib);
    this.notes = Array.isArray(notes.notes) ? notes.notes : [];
    this.notesError = notes.error || null;
    this.plan = { version: 1, changes: [], ...withoutRev(plan) };
    this.screen = { reject: new Set(screen.reject || []), keep: new Set(screen.keep || []) };
    this.ruleOverrides = rules.overrides || {};
    // One-time move of overrides saved by older versions in this browser's storage.
    const legacy = prefs.get('classify.overrides', null);
    if (!rules.saved && legacy && Object.keys(legacy).length) {
      this.ruleOverrides = legacy;
      this.saveDoc('rules', { overrides: legacy }, 'store.saveRulesFailed');
    }
    this.marks = { genuine: new Set(marks.genuine || []), dismissedDuplicates: new Set(marks.dismissedDuplicates || []), pinnedCrates: marks.pinnedCrates || [] };
    if (!marks.rev) this.moveLegacyMarks();
    this.recompute();
  }

  /** Until 2026-11-28 these marks were kept in the page's storage: move them to marks.json once. */
  moveLegacyMarks() {
    const genuine = prefs.get('quality.genuine', []);
    const dismissed = prefs.get('dupes.dismissed', []);
    const pinned = prefs.get('inbox.pinned', []);
    if (!genuine.length && !dismissed.length && !pinned.length) return;
    this.marks = { genuine: new Set(genuine), dismissedDuplicates: new Set(dismissed), pinnedCrates: pinned };
    this.saveMarks().then(() => {
      if (this.revs.marks) for (const key of ['quality.genuine', 'dupes.dismissed', 'inbox.pinned']) prefs.remove(key);
    });
  }

  /**
   * Save a document the page edits as a whole (plan, screen, notes, rules, marks). Saves of one
   * document run one after another, each naming the revision it was based on. If another window
   * changed the document, the server refuses and this page stops saving it until it is reloaded,
   * so neither window silently overwrites the other.
   */
  saveDoc(name, body, failKey) {
    this._saves[name] = (this._saves[name] || Promise.resolve()).then(async () => {
      if (this.conflicts.has(name)) return this.warnConflict();
      try {
        const { rev } = await request('PUT', `/api/${name}`, { ...body, rev: this.revs[name] ?? 0 });
        this.revs[name] = rev;
      } catch (e) {
        if (e.status !== 409) return toast(_(failKey, { error: e.message }), { tone: 'danger', timeout: 8000 });
        this.conflicts.add(name);
        this.warnConflict();
      }
    });
    return this._saves[name];
  }

  warnConflict() {
    if (Date.now() - this._conflictToastAt < 10000) return;
    this._conflictToastAt = Date.now();
    toast(_('store.conflict'), { tone: 'danger', timeout: 600000, action: () => location.reload(), actionLabel: _('store.reloadPage') });
  }

  saveMarks() {
    const { genuine, dismissedDuplicates, pinnedCrates } = this.marks;
    return this.saveDoc('marks', { genuine: [...genuine], dismissedDuplicates: [...dismissedDuplicates], pinnedCrates }, 'store.saveMarksFailed');
  }

  // ---- duplicate groups the user dismissed, crates pinned in Sort (marks.json) ----
  get dismissedDuplicates() {
    return this.marks.dismissedDuplicates;
  }
  setDuplicatesDismissed(keys, on = true) {
    for (const k of keys) {
      if (on) this.marks.dismissedDuplicates.add(k);
      else this.marks.dismissedDuplicates.delete(k);
    }
    this.notify();
    this.saveMarks();
  }
  clearDismissedDuplicates() {
    this.marks.dismissedDuplicates = new Set();
    this.notify();
    this.saveMarks();
  }
  get pinnedCrates() {
    return this.marks.pinnedCrates;
  }
  setPinnedCrates(ids) {
    this.marks.pinnedCrates = [...ids];
    this.notify();
    this.saveMarks();
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
    this.saveDoc('rules', { overrides }, 'store.saveRulesFailed');
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
    this.refreshSpectrum(); // results of earlier checks only: the check itself runs when asked (Quality tab)
  }

  // ---- transcode check (server: spectrum.py). Never starts on its own, to save power. ----
  /** Read the saved results and how many files are still unchecked; follow a run that is going on. */
  async refreshSpectrum() {
    try {
      const status = await api.spectrum(true);
      this.setSpectrum(status);
      if (status.running) this.followSpectrum();
    } catch (e) {
      this.spectrumProgress = { error: e.message };
    }
    this.notify();
  }
  /** speed: 'saver' (1 file at a time) | 'normal' (3) | 'fast' (6). Only new or changed files are analysed. */
  async runSpectrum(speed) {
    const status = await api.spectrumAction({ action: 'start', speed });
    this.spectrumProgress = { ...status, startedAt: Date.now(), startDone: status.done };
    this.notify();
    this.followSpectrum();
  }
  async stopSpectrum() {
    this.spectrumProgress = { ...this.spectrumProgress, stopping: true };
    this.notify();
    try {
      await api.spectrumAction({ action: 'stop' });
    } catch (e) {
      this.spectrumProgress = { ...this.spectrumProgress, stopping: false };
      this.notify();
      toast(_('store.stopCheckFailed', { error: e.message }), { tone: 'danger' });
    }
  }
  async followSpectrum() {
    if (this._following) return;
    this._following = true;
    try {
      let lastItems = Date.now();
      for (;;) {
        await new Promise((r) => setTimeout(r, 3000));
        const fresh = Date.now() - lastItems > 20000; // show results as they come in
        const status = await api.spectrum(fresh || undefined);
        if (fresh) lastItems = Date.now();
        if (!status.running) {
          this.setSpectrum(await api.spectrum(true));
          break;
        }
        this.setSpectrum(status);
        this.notify();
      }
    } catch (e) {
      this.spectrumProgress = { error: e.message };
    }
    this._following = false;
    this.notify();
  }
  setSpectrum(status) {
    const { items, ...rest } = status;
    // startedAt / startDone: when this page started watching the run and how far it was then, so the
    // time left is right even when the page opens in the middle of a run.
    const prev = this.spectrumProgress?.startedAt ? this.spectrumProgress : null;
    this.spectrumProgress = rest.running
      ? { ...rest, startedAt: prev?.startedAt ?? Date.now(), startDone: prev ? (prev.startDone ?? 0) : rest.done }
      : { ...rest, startedAt: null, startDone: 0 };
    if (items) this.spectrum = new Map(Object.entries(items).map(([path, v]) => [pathKey(path), [...v, path]])); // [cutoff, kind, path]
  }

  /** Whether the values that `deps` lists are the same objects as on the last call for `name` (memo helper). */
  unchanged(name, deps) {
    const prev = (this._deps ||= {})[name];
    this._deps[name] = deps;
    return !!prev && prev.length === deps.length && prev.every((d, i) => d === deps[i]);
  }

  /**
   * Every file the transcode check flagged, including the ones marked fine:
   * [{ key, path, dir, track, q (with suspect), s, genuine }]. Recomputed only when the plan, the
   * check results, the audio formats or the genuine marks change (not on every update of the page).
   */
  suspects() {
    if (this.unchanged('suspects', [this.eff, this.spectrum, this.audioInfo, this.marks.genuine, this._genuineRev])) return this._suspects;
    const eff = this.eff;
    // All songs, also those removed in the plan, so a rejected song still shows as a Serato song.
    const byPath = new Map([...eff.base.tracks.values()].map((t) => [pathKey(effectivePath(eff, t)), t]));
    const out = [];
    for (const [key, [cutoff, kind, path]] of this.spectrum) {
      const track = byPath.get(key);
      const q = this.qualityOf(path, track);
      const genuine = this.genuine.has(key);
      const s = q.suspect || (genuine ? suspicionOf(q, [cutoff, kind]) : null);
      if (s) out.push({ key, path, dir: dirOf(path), track, q: { ...q, suspect: s }, s, genuine });
    }
    this._suspects = out;
    return out;
  }

  // ---- notes about songs (Notes tab). Saved in notes.json on the server; never written to Serato ----
  /** What a note keeps about its song: the Serato id and the file, plus title / artist to show if both go away. */
  songRef(track, path) {
    if (track) return { id: track.id, path: effectivePath(this.eff, track), title: track.title || track.fileName, artist: track.artist || '' };
    return { path, title: baseName(path).replace(/\.[^.]+$/, ''), artist: '' };
  }
  /** The library song a note points to now: by Serato id, else by file (a file noted before it was imported). */
  noteTrack(song) {
    if (!song) return null;
    if (song.id != null && this.base.tracks.has(song.id)) return this.base.tracks.get(song.id);
    return song.path ? (this.notesIndex().byPath.get(pathKey(song.path)) ?? null) : null;
  }
  /** Notes about this library song, newest first. */
  notesFor(track) {
    return track ? (this.notesIndex().byTrack.get(track.id) ?? []) : [];
  }
  notesForPath(path) {
    const track = this.notesIndex().byPath.get(pathKey(path));
    return track ? this.notesFor(track) : this.notes.filter((n) => !n.song?.id && n.song?.path && pathKey(n.song.path) === pathKey(path));
  }
  /** Notes by library song, and library songs by file. Recomputed when the notes or the plan change. */
  notesIndex() {
    if (this.unchanged('notesIndex', [this.notes, this.eff])) return this._notesIndex;
    const byPath = new Map([...this.base.tracks.values()].map((t) => [pathKey(effectivePath(this.eff, t)), t]));
    this._notesIndex = { byPath, byTrack: new Map() };
    for (const n of this.notes) {
      const t = this.noteTrack(n.song);
      if (!t) continue;
      if (!this._notesIndex.byTrack.has(t.id)) this._notesIndex.byTrack.set(t.id, []);
      this._notesIndex.byTrack.get(t.id).push(n);
    }
    return this._notesIndex;
  }
  addNote(text, song = null) {
    const now = Date.now();
    const note = { id: `n${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, text, song, created: now, updated: now };
    this.setNotes([note, ...this.notes]);
    return note;
  }
  updateNote(id, patch) {
    this.setNotes(this.notes.map((n) => (n.id === id ? { ...n, ...patch, updated: Date.now() } : n)));
  }
  deleteNote(id) {
    const at = this.notes.findIndex((n) => n.id === id);
    if (at < 0) return;
    const note = this.notes[at];
    this.setNotes(this.notes.filter((n) => n.id !== id));
    toast(_('store.noteDeleted'), { action: () => this.setNotes([...this.notes.slice(0, at), note, ...this.notes.slice(at)]), timeout: 6000 });
  }
  setNotes(notes) {
    if (this.notesError) {
      toast(_('common.notesReadFailed', { error: this.notesError }), { tone: 'danger', timeout: 8000 });
      return;
    }
    this.notes = notes;
    this.notify();
    this.saveDoc('notes', { notes }, 'store.saveNotesFailed'); // right away, no debounce
  }

  // ---- files the user checked and marked genuine: no "Suspect" mark (marks.json) ----
  get genuine() {
    return this.marks.genuine;
  }
  setGenuine(path, on) {
    const k = pathKey(path);
    if (on) this.marks.genuine.add(k);
    else this.marks.genuine.delete(k);
    this._genuineRev = (this._genuineRev || 0) + 1;
    this.notify();
    this.saveMarks();
  }

  /** Quality of the file at `path` (a Serato track's file when `track` is given). */
  qualityOf(path, track) {
    const p = path ?? (track ? effectivePath(this.eff, track) : '');
    const q = describeQuality(this.audioInfo.get(pathKey(p)), p, track);
    const k = pathKey(p);
    const suspect = this.genuine.has(k) ? null : suspicionOf(q, this.spectrum.get(k));
    return suspect ? { ...q, suspect } : q;
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
    // Crates pinned before they existed in Serato keep their pin under the id Serato gave them.
    const pinned = this.marks.pinnedCrates.map((id) => newIds[id] ?? id);
    if (pinned.some((id, i) => id !== this.marks.pinnedCrates[i])) this.setPinnedCrates(pinned);
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
    this._screenTimer = setTimeout(() => this.saveDoc('screen', { reject: [...this.screen.reject], keep: [...this.screen.keep] }, 'store.saveScreenFailed'), 250);
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

  /**
   * Stage `ops` as one change. title: { key, n?, params?, extra? } (see planText.changeTitle), or
   * { fromOp: true } to name the change after its only op. Only data is stored; text is made when shown.
   */
  commit(title, ops, { silent = false } = {}) {
    ops = ops.filter(Boolean);
    if (!ops.length) return null;
    const change = { id: uid(), at: Date.now(), title, ops };
    const issuesBefore = this.eff.issues.length;
    this.plan.changes.push(change);
    this.recompute();
    const newIssues = this.eff.issues.slice(issuesBefore).filter((i) => i.changeId === change.id);
    if (newIssues.length) {
      // Reject edits that cannot be applied cleanly (e.g. name clash).
      this.plan.changes.pop();
      this.recompute();
      toast(_('store.cannotApply', { error: newIssues[0].message }), { tone: 'danger' });
      return null;
    }
    this.persist();
    if (!silent) toast(this.changeTitle(change), { action: () => this.undo(change.id) });
    return change;
  }

  // ---- text for the plan, made when shown (planText.js) ----
  textContext() {
    return { eff: this.eff, changes: this.plan.changes, quality: (id) => this.trackQuality(this.base.tracks.get(id)).label };
  }
  changeTitle(change) {
    return changeTitle(this.textContext(), change);
  }
  opText(op) {
    return opText(this.textContext(), op);
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

  /**
   * Take back staged additions of `asset` to `crate`, with the removal from the source crate staged
   * together with them (sorting with "remove from the source crate"). Returns the removed ops.
   */
  revertAdd(crate, asset) {
    const removed = [];
    for (const ch of this.plan.changes) {
      const adds = ch.ops.filter((o) => o.type === 'add' && o.crate === crate && o.asset === asset);
      if (!adds.length) continue;
      const sources = adds.map((o) => o.source).filter((s) => s != null);
      const paired = (o) => o.type === 'remove' && o.asset === asset && (sources.length ? sources.includes(o.crate) : o.crate !== crate);
      ch.ops = ch.ops.filter((o) => {
        const drop = adds.includes(o) || paired(o);
        if (drop) removed.push(o);
        return !drop;
      });
    }
    if (removed.length) {
      this.plan.changes = this.plan.changes.filter((c) => c.ops.length);
      this.recompute();
      this.persist();
    }
    return removed;
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
    this._saveTimer = setTimeout(() => this.saveDoc('plan', { ...this.plan, snapshotTakenAt: this.base?.snapshot?.takenAt }, 'store.savePlanFailed'), 250);
  }

  // ---- display names ----
  trackLabel(id) {
    return trackName(this.textContext(), id);
  }
  crateLabel(id) {
    return crateName(this.textContext(), id);
  }

  // ---- op builders ----
  opAdd(crate, asset) {
    return { type: 'add', crate, asset };
  }
  opRemove(crate, asset) {
    return { type: 'remove', crate, asset };
  }
  opCreate(name, parent) {
    return { type: 'createCrate', id: newCrateId(), name, parent };
  }
  /** from: the crate's name before the rename, so the plan can show "old → new" later. */
  opRename(crate, name) {
    return { type: 'renameCrate', crate, name, from: this.eff.crates.get(crate)?.name };
  }
  /** before: undefined = last (the original move), a sibling id = just before it, null = last of that level. */
  opMove(crate, parent, before) {
    if (before === undefined) return { type: 'moveCrate', crate, parent };
    return { type: 'moveCrate', crate, parent, before, reorder: this.eff.crates.get(crate)?.parent === parent };
  }
  /**
   * Add a file on disk to the Serato library (optionally into a crate). Serato analyses it later.
   * crateName: the path of a crate created in the same change, shown until that crate exists.
   */
  opImport(path, crate = null, crateName = null) {
    const op = { type: 'importTrack', id: `imp-${uid()}`, path, crate };
    if (crateName != null) op.crateName = crateName;
    return op;
  }
  /** Is this file already planned to be added to Serato? */
  planned(path) {
    return this.eff.imports.get(pathKey(path)) ?? null;
  }
  opDelete(crate) {
    return { type: 'deleteCrate', crate };
  }
  opMerge(from, into) {
    return { type: 'mergeCrate', from, into };
  }
  /** reason: an i18n key ('' for none). deleteFile: also move the file to the Trash once the removal is written to Serato. */
  opRemoveTrack(asset, reason, { deleteFile = false } = {}) {
    const op = { type: 'removeTrack', asset, reason };
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
        const { deleteFile, text, ...rest } = op; // keep group / keeper / missing tags
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
    return { type: 'removeTrack', asset, reason: 'common.reject', deleteFile: true };
  }
  opRelocate(asset, path) {
    return { type: 'relocate', asset, path };
  }
}

export const store = new Store();
