// Lets the page's modules load under Node: i18n.js fetches static/locales/*.json by file URL, which
// Node's fetch does not do. Import this before any module from static/js.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const nodeFetch = globalThis.fetch;
globalThis.fetch = async (url, ...rest) => {
  const href = String(url);
  if (!href.startsWith('file:')) return nodeFetch(url, ...rest);
  const text = await readFile(fileURLToPath(href), 'utf8');
  return { ok: true, status: 200, json: async () => JSON.parse(text) };
};
