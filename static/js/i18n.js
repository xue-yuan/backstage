// Minimal i18n, gettext style: _('English text') and _n(count, 'one', 'other'). The English text is the key; locales/zh-Hant.js maps it to Traditional
// Chinese. The language is read once when the page loads and switching reloads the page, so calling
// _() at module level (for constant labels) is fine.
import { NATIVE, zh } from './locales/zh-Hant.js';

// Same "crate-desk:" prefix as prefs in ui.js (kept on purpose so saved settings survive renames).
const STORAGE_KEY = 'crate-desk:lang';

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
