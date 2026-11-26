// Pure data logic: snapshot + staged plan -> effective library, plus analysis helpers.

export function buildBase(lib) {
  const tracks = new Map(lib.tracks.map((t) => [t.id, t]));
  const crates = new Map(lib.crates.map((c) => [c.id, { ...c }]));
  const members = new Map();
  for (const id of crates.keys()) members.set(id, []);
  for (const [c, a] of lib.memberships) members.get(c)?.push(a);
  const baseCratesOf = new Map();
  for (const [c, list] of members) for (const a of list) push(baseCratesOf, a, c);
  return { rootId: lib.rootId, tracks, crates, members, baseCratesOf, snapshot: lib.snapshot };
}

function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const sameName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

// Plan ops that Apply to Serato can write (see serato_crates/apply.py).
export const APPLY_SUPPORTED = new Set(['createCrate', 'renameCrate', 'moveCrate', 'deleteCrate', 'mergeCrate', 'add', 'remove', 'relocate', 'removeTrack']);

// ---------- Effective state ----------
export function applyPlan(base, changes) {
  const crates = new Map();
  for (const [id, c] of base.crates) crates.set(id, { ...c, status: {} });
  const members = new Map();
  for (const [id, list] of base.members) members.set(id, list.slice());
  const removedTracks = new Map();
  const rejectedTracks = new Set(); // removed because the user does not want the song: file goes to the Trash too
  const relocated = new Map();
  const issues = [];
  let maxOrder = Math.max(0, ...[...crates.values()].map((c) => c.order || 0));

  const isDescendant = (id, ancestor) => {
    for (let cur = crates.get(id)?.parent; cur != null; cur = crates.get(cur)?.parent) {
      if (cur === ancestor) return true;
    }
    return false;
  };
  const childrenOf = (parent) => [...crates.values()].filter((c) => c.parent === parent);
  const nameTaken = (parent, name, exceptId) =>
    childrenOf(parent).some((c) => c.id !== exceptId && sameName(c.name, name));
  const validParent = (p) => p === base.rootId || crates.has(p);

  const deleteCrate = (id) => {
    for (const child of childrenOf(id)) deleteCrate(child.id);
    crates.delete(id);
    members.delete(id);
  };

  const mergeInto = (from, into) => {
    const target = members.get(into);
    const have = new Set(target);
    for (const a of members.get(from) || []) if (!have.has(a)) target.push(a);
    crates.get(into).status.merged = true;
    for (const child of childrenOf(from)) {
      const clash = childrenOf(into).find((c) => sameName(c.name, child.name));
      if (clash) mergeInto(child.id, clash.id);
      else {
        child.parent = into;
        child.order = ++maxOrder;
      }
    }
    crates.delete(from);
    members.delete(from);
  };

  const apply = (op) => {
    switch (op.type) {
      case 'add': {
        if (!members.has(op.crate)) return 'crate 已不存在';
        if (!base.tracks.has(op.asset) || removedTracks.has(op.asset)) return '曲目已不存在';
        const list = members.get(op.crate);
        if (!list.includes(op.asset)) list.push(op.asset);
        return null;
      }
      case 'remove': {
        const list = members.get(op.crate);
        if (!list) return 'crate 已不存在';
        const i = list.indexOf(op.asset);
        if (i >= 0) list.splice(i, 1);
        return null;
      }
      case 'createCrate': {
        if (crates.has(op.id)) return 'crate 已存在';
        if (!validParent(op.parent)) return '上層 crate 已不存在';
        if (nameTaken(op.parent, op.name)) return `同一層已經有「${op.name}」`;
        crates.set(op.id, { id: op.id, parent: op.parent, name: op.name, order: ++maxOrder, status: { created: true } });
        members.set(op.id, []);
        return null;
      }
      case 'renameCrate': {
        const c = crates.get(op.crate);
        if (!c) return 'crate 已不存在';
        if (nameTaken(c.parent, op.name, c.id)) return `同一層已經有「${op.name}」`;
        if (!c.status.created && c.status.originalName == null) c.status.originalName = c.name;
        c.name = op.name;
        if (c.status.originalName === c.name) delete c.status.originalName;
        return null;
      }
      case 'moveCrate': {
        const c = crates.get(op.crate);
        if (!c) return 'crate 已不存在';
        if (!validParent(op.parent)) return '目標 crate 已不存在';
        if (op.parent === c.id || isDescendant(op.parent, c.id)) return '不能移到自己底下';
        if (nameTaken(op.parent, c.name, c.id)) return `目標裡已經有「${c.name}」`;
        if (!c.status.created && c.status.originalParent === undefined) c.status.originalParent = c.parent;
        c.parent = op.parent;
        c.order = ++maxOrder;
        if (c.status.originalParent === c.parent) delete c.status.originalParent;
        return null;
      }
      case 'deleteCrate': {
        if (!crates.has(op.crate)) return 'crate 已不存在';
        deleteCrate(op.crate);
        return null;
      }
      case 'mergeCrate': {
        if (!crates.has(op.from) || !crates.has(op.into)) return 'crate 已不存在';
        if (op.from === op.into || isDescendant(op.into, op.from)) return '不能合併到自己底下';
        mergeInto(op.from, op.into);
        return null;
      }
      case 'removeTrack': {
        if (!base.tracks.has(op.asset)) return '曲目已不存在';
        removedTracks.set(op.asset, op.reason || '');
        if (op.deleteFile) rejectedTracks.add(op.asset);
        for (const list of members.values()) {
          const i = list.indexOf(op.asset);
          if (i >= 0) list.splice(i, 1);
        }
        return null;
      }
      case 'relocate': {
        if (!base.tracks.has(op.asset)) return '曲目已不存在';
        relocated.set(op.asset, op.path);
        return null;
      }
      default:
        return `未知的動作 ${op.type}`;
    }
  };

  for (const ch of changes) {
    for (const op of ch.ops) {
      const problem = apply(op);
      if (problem) issues.push({ changeId: ch.id, op, message: problem });
    }
  }

  // Derived indexes
  const children = new Map();
  for (const c of crates.values()) push(children, c.parent, c.id);
  for (const list of children.values()) list.sort((a, b) => crates.get(a).order - crates.get(b).order);
  const cratesOf = new Map();
  for (const [c, list] of members) for (const a of list) push(cratesOf, a, c);

  const pathCache = new Map();
  const pathOf = (id) => {
    if (pathCache.has(id)) return pathCache.get(id);
    const c = crates.get(id);
    if (!c) return '(已刪除)';
    const p = c.parent === base.rootId || !crates.has(c.parent) ? c.name : `${pathOf(c.parent)} / ${c.name}`;
    pathCache.set(id, p);
    return p;
  };

  return { base, crates, members, children, cratesOf, removedTracks, rejectedTracks, relocated, issues, pathOf, rootId: base.rootId };
}

export function liveTracks(eff) {
  return [...eff.base.tracks.values()].filter((t) => !eff.removedTracks.has(t.id));
}

export function addedInPlan(eff, assetId) {
  const before = new Set(eff.base.baseCratesOf.get(assetId) || []);
  return (eff.cratesOf.get(assetId) || []).filter((c) => !before.has(c));
}

export function subtreeIds(eff, id) {
  const out = [id];
  for (const child of eff.children.get(id) || []) out.push(...subtreeIds(eff, child));
  return out;
}

// ---------- Text normalisation ----------
export function norm(s) {
  return (s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\.(mp3|wav|m4a|aiff?|flac|mp4)$/u, '')
    .replace(/[([]\s*original( mix)?\s*[)\]]/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function trackMatches(t, q) {
  if (!q) return true;
  const hay = norm(`${t.title} ${t.artist} ${t.remixer} ${t.genre} ${t.fileName}`);
  return norm(q).split(' ').every((w) => hay.includes(w));
}

export function crateSearch(eff, query, { exclude, limit = 12 } = {}) {
  const words = norm(query).split(' ').filter(Boolean);
  const results = [];
  for (const id of eff.crates.keys()) {
    if (exclude?.has(id)) continue;
    const path = eff.pathOf(id);
    const hay = norm(path);
    if (!words.every((w) => hay.includes(w))) continue;
    const leaf = norm(eff.crates.get(id).name);
    let score = path.length / 100;
    if (words.length && leaf.startsWith(words[words.length - 1])) score -= 2;
    if (words.length && leaf === words.join(' ')) score -= 3;
    results.push({ id, path, score });
  }
  results.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path));
  return results.slice(0, limit);
}

// ---------- Suggestions ----------
// Signals: words from the track's genre tag, folder names and the crates it already sits in
// (e.g. "TBD / Future House"), matched against each crate's own name and its tracks' words.
// BPM only adjusts a score; it never produces a suggestion on its own.
const STOP = new Set(['the', 'and', 'feat', 'ft', 'mix', 'music', 'pack', 'vol', 'edit', 'users', 'download', 'all', 'by', 'of', 'x', 'tbd', 'temp', 'inbox', 'new', 'crate', 'spotify', 'playlist']);

function words(s, out = new Set()) {
  for (const w of norm(s).split(' ')) if (w.length >= 2 && !STOP.has(w) && !/^\d+$/.test(w)) out.add(w);
  return out;
}

function contentWords(t, out = new Set()) {
  words(t.genre, out);
  const dirs = t.path.split('/').slice(0, -1);
  const musicIdx = dirs.lastIndexOf('Music');
  return words(dirs.slice(musicIdx >= 0 ? musicIdx + 1 : -2).slice(-2).join(' '), out);
}

export function buildProfiles(eff) {
  const profiles = new Map();
  const df = new Map();
  for (const [id, list] of eff.members) {
    if (!list.length && (eff.children.get(id) || []).length) continue; // pure folder crate
    const live = list.map((a) => eff.base.tracks.get(a)).filter(Boolean);
    const freq = new Map();
    const artists = new Map();
    const bpms = [];
    for (const t of live) {
      for (const w of contentWords(t)) freq.set(w, (freq.get(w) || 0) + 1);
      for (const a of splitArtists(t.artist)) artists.set(a, (artists.get(a) || 0) + 1);
      if (t.bpm) bpms.push(t.bpm);
    }
    for (const [w, n] of freq) freq.set(w, n / live.length);
    const name = words(eff.pathOf(id));
    for (const w of new Set([...name, ...[...freq].filter(([, f]) => f >= 0.2).map(([w]) => w)])) df.set(w, (df.get(w) || 0) + 1);
    bpms.sort((a, b) => a - b);
    const enough = bpms.length >= 3;
    profiles.set(id, {
      name,
      freq,
      artists,
      bpmLo: enough ? bpms[Math.floor(bpms.length * 0.1)] : null,
      bpmHi: enough ? bpms[Math.floor(bpms.length * 0.9)] : null,
    });
  }
  return { profiles, df, n: profiles.size };
}

function splitArtists(s) {
  return norm(s)
    .split(/\b(?:feat|ft|vs|x|and)\b/u)
    .map((a) => a.trim())
    .filter((a) => a.length > 1);
}

const BPM_RANGE = /^(\d{2,3})\s*[-–~]\s*(\d{2,3})$/;
/** { lo, hi } if the crate or one of its parents is named like "120-129". */
function bpmRangeOf(eff, id) {
  for (let cur = id; cur != null && eff.crates.has(cur); cur = eff.crates.get(cur).parent) {
    const m = BPM_RANGE.exec(eff.crates.get(cur).name.trim());
    if (m && Number(m[1]) < Number(m[2])) return { lo: Number(m[1]), hi: Number(m[2]) };
  }
  return null;
}

export function suggestCrates(eff, model, track, { limit = 5, exclude } = {}) {
  const have = new Set(eff.cratesOf.get(track.id) || []);
  const toks = contentWords(track);
  for (const c of have) words(eff.pathOf(c), toks);
  const artists = splitArtists(track.artist);
  const scored = [];
  for (const [id, p] of model.profiles) {
    if (have.has(id) || exclude?.has(id) || !eff.crates.has(id)) continue;
    let score = 0;
    let best = null;
    for (const w of toks) {
      const inName = p.name.has(w);
      const m = (inName ? 1 : 0) + (p.freq.get(w) || 0);
      if (!m) continue;
      const s = m * Math.log(1 + model.n / (model.df.get(w) || 1));
      score += s;
      if (!best || s > best.s) best = { s, text: inName ? `名稱符合「${w}」` : `曲風／資料夾「${w}」` };
    }
    const reasons = best ? [best.text] : [];
    const artistHits = artists.reduce((n, a) => n + (p.artists.get(a) || 0), 0);
    if (artistHits) {
      score += Math.min(3, artistHits) * 0.6;
      reasons.push(`同歌手 ${artistHits} 首`);
    }
    // Crates named by a BPM range ("Open Format / 120-129 / All"): the song's BPM decides.
    const range = bpmRangeOf(eff, id);
    if (range) {
      if (!track.bpm || track.bpm < range.lo || track.bpm >= range.hi + 1) continue; // never suggest the wrong range
      score += norm(eff.crates.get(id).name) === 'all' ? 1.6 : 0.9;
      reasons.unshift(`BPM ${Math.round(track.bpm * 10) / 10} 在 ${range.lo}–${range.hi}`);
    }
    if (!score) continue;
    if (track.bpm && p.bpmLo && p.bpmHi - p.bpmLo <= 35) {
      const b = track.bpm;
      const within = (x) => x >= p.bpmLo - 2 && x <= p.bpmHi + 2;
      if (within(b)) {
        score += 0.5;
        if (!range) reasons.push(`BPM ${Math.round(p.bpmLo)}–${Math.round(p.bpmHi)}`);
      } else if (within(b * 2) || within(b / 2)) score += 0.1;
      else score -= 0.8;
    }
    if (score > 0.5) scored.push({ id, score, reasons });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ---------- Cleanup analysis ----------
export function findDuplicates(eff, quality) {
  const groups = new Map();
  for (const t of liveTracks(eff)) {
    const title = norm(t.title || t.fileName);
    if (!title) continue;
    const key = `${norm(t.artist)}|${title}`;
    push(groups, key, t);
  }
  const out = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    const lengths = list.map((t) => t.lengthMs || 0).filter(Boolean);
    const spread = lengths.length ? Math.max(...lengths) - Math.min(...lengths) : 0;
    out.push({ key, tracks: list, spreadMs: spread, keeper: pickKeeper(eff, list, quality) });
  }
  out.sort((a, b) => a.spreadMs - b.spreadMs || b.tracks.length - a.tracks.length);
  return out;
}

const LOSSLESS = new Set(['wav', 'aiff', 'aif', 'flac']);
// `quality(track)` (optional) returns a score from the real codec, so AAC 256 ranks with MP3 320.
export function pickKeeper(eff, list, quality) {
  const fileScore = (t) => quality?.(t) ?? (LOSSLESS.has((t.format || '').toLowerCase()) ? 2000 : 0) + (t.bitRate || 0) / 1000;
  const score = (t) =>
    (t.exists || eff.relocated.has(t.id) ? 10000 : 0) +
    fileScore(t) +
    (eff.cratesOf.get(t.id)?.length || 0) * 20 +
    (t.plays || 0) * 10;
  return list.reduce((best, t) => (score(t) > score(best) ? t : best)).id;
}

export function findMissing(eff) {
  return liveTracks(eff).filter((t) => !t.exists);
}

export function findEmptyCrates(eff) {
  return [...eff.crates.keys()].filter(
    (id) => !(eff.members.get(id) || []).length && !(eff.children.get(id) || []).length,
  );
}

export function findUncategorized(eff) {
  return liveTracks(eff).filter((t) => !(eff.cratesOf.get(t.id) || []).length);
}

// ---------- Classification rules (shared by the Folders and Sort views) ----------
// A track counts as "classified" when it sits in at least one crate that is not skipped.
// Skipped by default: inbox crates (TBD / Temp / … and everything under them) and crates that are
// just a whole disk folder dragged into Serato (crate name = folder name, holding most of that
// folder's tracks). Per-crate overrides ('count' | 'skip') are inherited by sub-crates.
export const INBOX_NAMES = /^(tbd|temp|inbox|new|待整理|未分類)$/i;
const FOLDER_CRATE_COVERAGE = 0.6;

export const pathKey = (p) => (p || '').normalize('NFC').toLowerCase();
export const dirOf = (p) => p.slice(0, p.lastIndexOf('/'));
export const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);

export function effectivePath(eff, t) {
  return eff.relocated.get(t.id) ?? t.path;
}

export function classificationRules(eff, overrides = {}) {
  const auto = new Map(); // crateId -> { kind: 'inbox' } | { kind: 'folder', dir, n, total }
  for (const id of eff.children.get(eff.rootId) || []) {
    if (INBOX_NAMES.test(eff.crates.get(id).name)) auto.set(id, { kind: 'inbox' });
  }
  const inInbox = (id) => {
    for (let cur = id; cur != null && eff.crates.has(cur); cur = eff.crates.get(cur).parent) if (auto.get(cur)?.kind === 'inbox') return true;
    return false;
  };

  const tracksPerDir = new Map();
  const dirKeyOf = new Map();
  for (const t of liveTracks(eff)) {
    const p = effectivePath(eff, t);
    const k = pathKey(dirOf(p));
    dirKeyOf.set(t.id, [k, dirOf(p)]);
    tracksPerDir.set(k, (tracksPerDir.get(k) || 0) + 1);
  }
  for (const [id, list] of eff.members) {
    if (!list.length || inInbox(id)) continue;
    const counts = new Map();
    for (const a of list) {
      const d = dirKeyOf.get(a);
      if (!d) continue;
      const c = counts.get(d[0]) || { n: 0, dir: d[1] };
      c.n++;
      counts.set(d[0], c);
    }
    let best = null;
    for (const [k, c] of counts) if (!best || c.n > best.n) best = { k, ...c };
    if (!best) continue;
    const total = tracksPerDir.get(best.k) || 0;
    if (norm(eff.crates.get(id).name) === norm(baseName(best.dir)) && best.n / total >= FOLDER_CRATE_COVERAGE) {
      auto.set(id, { kind: 'folder', dir: best.dir, n: best.n, total });
    }
  }

  const skip = new Set();
  const decide = (id) => {
    for (let cur = id; cur != null && eff.crates.has(cur); cur = eff.crates.get(cur).parent) {
      const o = overrides[String(cur)];
      if (o) return o === 'skip';
      if (auto.has(cur)) return true;
    }
    return false;
  };
  for (const id of eff.crates.keys()) if (decide(id)) skip.add(id);
  return { auto, skip, overrides };
}

export function isClassified(eff, rules, assetId) {
  return (eff.cratesOf.get(assetId) || []).some((c) => !rules.skip.has(c));
}
