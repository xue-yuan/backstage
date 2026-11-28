// The music folders: what the Folders view scans and where missing files are looked for (with ~/Music).
// Saved by the server in settings.json. Until the user confirms them, the server suggests folders from
// where the songs in the Serato library are, and the page asks once (askMusicFoldersOnce).
import { _ } from './i18n.js';
import { store } from './store.js';
import { fmt, h, modal, toast } from './ui.js';

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

export const getMusicFolders = () => request('GET', '/api/music-folders');

/** Edit the music folders. `firstRun`: the folders were never confirmed (the suggestion is shown). Resolves true when saved. */
export async function editMusicFolders({ firstRun = false } = {}) {
  let settings;
  try {
    settings = await getMusicFolders();
  } catch (e) {
    toast(_('folderSettings.readFailed', { error: e.message }), { tone: 'danger' });
    return false;
  }
  const missing = new Set(settings.missing);
  let folders = [...settings.folders];

  const listEl = h('div', { class: 'mf-list' });
  const err = h('div', { class: 'field-error' });
  const input = h('input', { class: 'input input-sm', id: 'music-folder-path', placeholder: _('folderSettings.pathPlaceholder') });
  const chooseBtn = h('button', { class: 'btn btn-sm', onclick: choose }, _('folderSettings.chooseFolder'));

  function render() {
    listEl.replaceChildren(
      ...(folders.length
        ? folders.map((f) =>
            h(
              'div',
              { class: 'mf-row' },
              h('span', { class: 'mf-path', title: f }, fmt.shortPath(f)),
              missing.has(f) ? h('span', { class: 'mf-missing' }, _('folderSettings.notFound')) : null,
              h('button', { class: 'btn btn-sm btn-ghost', title: _('common.remove'), 'aria-label': _('folderSettings.remove', { path: f }), onclick: () => ((folders = folders.filter((x) => x !== f)), render()) }, '✕'),
            ),
          )
        : [h('div', { class: 'mf-empty muted small' }, _('folderSettings.empty'))]),
    );
  }

  function add(path) {
    const p = path.trim();
    if (!p) return;
    if (!folders.includes(p)) folders.push(p);
    err.textContent = '';
    render();
  }

  function addTyped() {
    add(input.value);
    input.value = '';
  }

  async function choose() {
    chooseBtn.disabled = true;
    try {
      const { path } = await request('POST', '/api/music-folders/choose', {});
      if (path) add(path);
    } catch (e) {
      err.textContent = e.message;
    } finally {
      chooseBtn.disabled = false;
    }
  }

  async function save(close) {
    addTyped();
    try {
      await request('PUT', '/api/music-folders', { folders });
    } catch (e) {
      err.textContent = e.message;
      return;
    }
    close(true);
  }

  render();
  const saved = await modal({
    title: firstRun ? _('folderSettings.firstRunTitle') : _('folderSettings.title'),
    wide: true,
    body: [
      h('p', {}, _('folderSettings.explanation')),
      firstRun ? h('p', { class: 'mf-hint' }, _('folderSettings.suggestedNote')) : null,
      listEl,
      h('div', { class: 'mf-add' }, chooseBtn, input, h('button', { class: 'btn btn-sm', onclick: addTyped }, _('folderSettings.add'))),
      err,
    ],
    actions: (close) => [
      firstRun ? null : h('button', { class: 'btn', onclick: () => close(null) }, _('common.cancel')),
      h('button', { class: 'btn btn-primary', onclick: () => save(close) }, firstRun ? _('folderSettings.scanButton') : _('common.save')),
    ],
    onKey: (e) => {
      if (e.key === 'Enter' && e.target === input) {
        e.preventDefault();
        addTyped();
      }
    },
  });
  if (!saved) return false;
  toast(_('folderSettings.saved'));
  await store.loadFolders(true);
  return true;
}

/** On the first start (folders never confirmed), show the suggestion once so the user sees what is scanned. */
export async function askMusicFoldersOnce() {
  try {
    const settings = await getMusicFolders();
    if (!settings.saved) await editMusicFolders({ firstRun: true });
  } catch {
    // the snapshot could not be read: the page shows that error already
  }
}
