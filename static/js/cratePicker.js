// Searchable crate picker: type to filter by path, ↑/↓ + Enter to pick, optional "create".
import { crateSearch, norm } from './model.js';
import { store } from './store.js';
import { h, modal } from './ui.js';
import { _, _n } from './i18n.js';

/**
 * @param {object} o
 * @param {(id) => void} o.onPick
 * @param {boolean} [o.allowCreate]  offer "create crate" when nothing matches exactly
 * @param {() => Set} [o.exclude]
 * @param {() => Set} [o.activeIds]  crates to mark as already containing the track
 */
export function createCratePicker({ onPick, allowCreate = false, exclude, activeIds, placeholder = _('picker.searchCrates'), autofocus = false, inline = false }) {
  let results = [];
  let index = 0;
  const input = h('input', { class: 'input', placeholder, autocomplete: 'off', spellcheck: false });
  const list = h('div', { class: `picker-results ${inline ? 'inline' : ''}`, hidden: !inline });
  const root = h('div', { class: 'picker' }, input, list);

  function createOption(q) {
    if (!allowCreate || !q.trim()) return null;
    const eff = store.eff;
    const parts = q.split('/').map((s) => s.trim()).filter(Boolean);
    const name = parts.pop();
    if (!name) return null;
    let parent = eff.rootId;
    if (parts.length) {
      const parentPath = norm(parts.join(' / '));
      parent = [...eff.crates.keys()].find((id) => norm(eff.pathOf(id)) === parentPath);
      if (parent == null) return null;
    }
    const clash = (eff.children.get(parent) || []).some((id) => norm(eff.crates.get(id).name) === norm(name));
    if (clash) return null;
    return { create: true, name, parent, path: parent === eff.rootId ? name : `${eff.pathOf(parent)} / ${name}` };
  }

  function refresh() {
    const q = input.value;
    const show = inline || document.activeElement === input;
    results = crateSearch(store.eff, q, { exclude: exclude?.(), limit: inline ? 50 : 10 });
    const create = createOption(q);
    if (create) results.push(create);
    index = Math.min(index, Math.max(0, results.length - 1));
    const active = activeIds?.() || new Set();
    list.replaceChildren(
      ...results.map((r, i) =>
        h(
          'div',
          {
            class: `picker-item ${i === index ? 'is-active' : ''} ${r.create ? 'is-create' : ''}`,
            onmousedown: (e) => {
              e.preventDefault();
              choose(i);
            },
            onmousemove: () => {
              if (index !== i) {
                index = i;
                refresh();
              }
            },
          },
          r.create
            ? [h('span', { class: 'picker-plus' }, '+'), _('picker.createNamed', { path: r.path })]
            : [active.has(r.id) ? h('span', { class: 'picker-check' }, '✓') : null, highlight(r.path)],
        ),
      ),
    );
    if (!results.length && q) list.append(h('div', { class: 'picker-empty' }, allowCreate ? _('picker.noMatchHint') : _('common.noMatchingCrate')));
    list.hidden = !show || (!results.length && !q);
    list.children[index]?.scrollIntoView({ block: 'nearest' });
  }

  function highlight(path) {
    const parts = path.split(' / ');
    const leaf = parts.pop();
    return [parts.length ? h('span', { class: 'muted' }, `${parts.join(' / ')} / `) : null, leaf];
  }

  function choose(i) {
    const r = results[i];
    if (!r) return;
    if (r.create) {
      const op = store.opCreate(r.name, r.parent);
      const change = store.commit({ key: 'common.createCrate', params: { path: r.path } }, [op], { silent: true });
      if (!change) return;
      onPick(op.id, { created: true });
    } else {
      onPick(r.id, {});
    }
    input.value = '';
    index = 0;
    if (!inline) input.blur();
    refresh();
  }

  input.addEventListener('input', () => {
    index = 0;
    refresh();
  });
  input.addEventListener('focus', refresh);
  input.addEventListener('blur', () => setTimeout(refresh, 0));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      index = Math.min(results.length - 1, index + 1);
      refresh();
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      index = Math.max(0, index - 1);
      refresh();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      choose(index);
      e.preventDefault();
    } else if (e.key === 'Escape' && !inline) {
      input.value = '';
      input.blur();
      e.preventDefault();
      e.stopPropagation();
    }
    e.stopPropagation(); // keep view shortcuts from firing while typing
  });

  if (autofocus) requestAnimationFrame(() => input.focus());
  if (inline) refresh();
  return { el: root, input, focus: () => input.focus(), refresh };
}

/** Modal that resolves to a crate id (or null). */
export function pickCrateDialog({ title, exclude, allowCreate = true }) {
  return modal({
    title,
    wide: true,
    body: (close) =>
      createCratePicker({
        inline: true,
        autofocus: true,
        allowCreate,
        exclude: () => exclude || new Set(),
        placeholder: _('picker.placeholder'),
        onPick: (id) => close(id),
      }).el,
  });
}
