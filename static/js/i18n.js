// Minimal i18n with semantic keys: _('area.name', params) and _n(count, 'area.name', params).
// The text for each key is in static/locales/en.json and zh-Hant.json, shared with the server and
// the Mac app; counted English texts are { one, other }. Both files load before any module that
// imports this one runs, and the language is read once (switching reloads the page), so calling
// _() at module level (for constant labels) is fine.
const loadTable = (name) => fetch(new URL(`../locales/${name}.json`, import.meta.url)).then((r) => r.json());
const [en, zh] = await Promise.all([loadTable('en'), loadTable('zh-Hant')]);

/** Prefix of every saved setting in localStorage (prefs in ui.js too). */
export const STORAGE_PREFIX = 'cratify:';
const STORAGE_KEY = `${STORAGE_PREFIX}lang`;

// Until 2026-11-28 (when the app was Backstage) the prefix was "crate-desk:". Move those settings once.
// Every module that reads settings imports this one, so this runs before any of them reads.
try {
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith('crate-desk:')) continue;
    const renamed = STORAGE_PREFIX + key.slice('crate-desk:'.length);
    if (localStorage.getItem(renamed) == null) localStorage.setItem(renamed, localStorage.getItem(key));
    localStorage.removeItem(key);
  }
} catch {
  // storage unavailable: nothing to move
}

function saved() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

/** 'en' (default) or 'zh' (Traditional Chinese). */
export const lang = saved() === 'zh' ? 'zh' : 'en';

/** What the language button switches to, labelled in that language. */
const other = lang === 'zh' ? en : zh;
export const switchTo = { lang: lang === 'zh' ? 'en' : 'zh', label: other['language.name'], title: other['language.switchTo'] };

function fill(text, params) {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

const table = lang === 'zh' ? zh : en;
const plural = new Intl.PluralRules(lang === 'zh' ? 'zh-Hant' : 'en');

/** The entry for `key`: this language, else English, else the key itself (so a gap is visible). */
function entry(key) {
  const value = table[key] ?? en[key];
  if (value === undefined) console.warn(`[i18n] missing key: ${key}`);
  return value ?? key;
}

/** Whether `key` is a known text (data saved by older versions may hold text instead of a key). */
export function has(key) {
  return typeof key === 'string' && key in en;
}

/** Text for `key` with {placeholders} filled from `params`. A counted entry gives its "other" form. */
export function _(key, params) {
  const value = entry(key);
  return fill(typeof value === 'string' ? value : value.other, params);
}

/** Count-aware text for `key`; {n} is filled with the formatted number. */
export function _n(n, key, params) {
  const value = entry(key);
  const text = typeof value === 'string' ? value : (value[plural.select(n)] ?? value.other);
  return fill(text, { ...params, n: Number(n).toLocaleString() });
}

/**
 * First start only (no language saved in the page yet): use the server's, which follows the Mac's
 * preferred language until one is chosen. True when the page reloads to switch.
 */
export async function adoptServerLanguage() {
  if (saved() != null) return false;
  try {
    const server = await (await fetch('/api/settings')).json();
    if ((server.lang === 'en' || server.lang === 'zh') && server.lang !== lang) {
      // Reload only if the choice can be remembered; otherwise every load would reload again.
      localStorage.setItem(STORAGE_KEY, JSON.stringify(server.lang));
      location.reload();
      return true;
    }
  } catch {
    return false; // server or storage unavailable: keep the default
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(lang));
  } catch {
    // storage unavailable: asked again next time
  }
  return false;
}

/** Tell the server (its messages, the Mac app's startup dialogs) which language to use. */
export function syncServerLang(value = lang) {
  return fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lang: value }),
  }).catch(() => {});
}

export async function setLang(value) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // private mode: the switch still applies to this page load via the server setting
  }
  await syncServerLang(value);
  location.reload();
}
