// Minimal i18n, gettext style: _('English text') and _n(count, 'one', 'other'). The English text is the key; locales/zh-Hant.js maps it to Traditional
// Chinese. The language is read once when the page loads and switching reloads the page, so calling
// _() at module level (for constant labels) is fine.
import { NATIVE, zh } from './locales/zh-Hant.js';

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

/** What the language button switches to (labelled in that language). */
export const switchTo = lang === 'zh' ? { lang: 'en', label: 'EN', title: 'Switch to English' } : { lang: 'zh', label: NATIVE.label, title: NATIVE.switchTitle };

function fill(text, params) {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

/** Translate `text` and fill {placeholders} from `params`. */
export function _(text, params) {
  return fill(lang === 'zh' ? (zh[text] ?? text) : text, params);
}

/**
 * Count-aware text: _n(n, '{n} song', '{n} songs'). {n} is filled with the formatted number.
 * Chinese has a single form; its entry is keyed by the plural English text.
 */
export function _n(n, one, other, params) {
  const p = { ...params, n: Number(n).toLocaleString() };
  if (lang === 'zh') return fill(zh[other] ?? other, p);
  return fill(n === 1 ? one : other, p);
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
