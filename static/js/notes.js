// Notes about songs: shared pieces for the Notes tab and the "Note…" items in other views.
// A note is free text (#tags allowed), optionally linked to a song. Notes live in notes.json on the
// server, never in Serato.
import { trackMatches } from './model.js';
import { player } from './player.js';
import { store } from './store.js';
import { fmt, h, modal, toast } from './ui.js';
import { _, _n } from './i18n.js';

// #tag: letters, digits, _ and - in any script (#開場, #warm-up). Stops at spaces and punctuation.
const TAG_RE = /#([\p{L}\p{N}_-]+)/gu;

/** Lower-cased #tags in a note's text, without the #. */
export function tagsOf(text) {
  return [...new Set([...text.matchAll(TAG_RE)].map((m) => m[1].toLowerCase()))];
}

/** Note text with line breaks kept and #tags as buttons (onTag(tag) when clicked). */
export function noteText(text, { onTag } = {}) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(TAG_RE)) {
    parts.push(text.slice(last, m.index));
    const tag = m[1].toLowerCase();
    parts.push(onTag ? h('button', { class: 'note-tag', onclick: (e) => (e.stopPropagation(), onTag(tag)) }, m[0]) : h('span', { class: 'note-tag' }, m[0]));
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return h('div', { class: 'note-text' }, parts);
}

/** "2026/11/27 20:41" for a note timestamp (ms). */
export const when = (ms) => `${fmt.date(ms / 1000)} ${fmt.time(ms)}`;

/** The song in the player, as { track } or { path } (a file not in Serato), or null. */
export function playingSong() {
  const key = player.current?.key;
  if (!key) return null;
  if (key.startsWith('t')) {
    const t = store.base.tracks.get(Number(key.slice(1)));
    return t ? { track: t } : null;
  }
  return key.startsWith('f') ? { path: key.slice(1) } : null;
}

/** Something the player can play for a note's song, or null. */
export function playableSong(song) {
  const t = store.noteTrack(song);
  if (t) return t.exists ? t : null;
  if (!song?.path) return null;
  return { playKey: `f${song.path}`, src: `/api/audio-file?path=${encodeURIComponent(song.path)}`, title: song.title, artist: song.artist || _('File not in Serato') };
}

/**
 * Pick a library song. Typing searches title / artist / genre / file name; empty shows the song that is
 * playing and the newest songs. Resolves to the track or null.
 */
export function pickSong({ title = _('Link a song'), query = '' } = {}) {
  const input = h('input', { class: 'input', value: query, placeholder: _('Search the library: title, artist…') });
  const list = h('div', { class: 'song-pick' });
  let results = [];
  let at = 0;
  let closeFn = null;

  const live = () => [...store.base.tracks.values()].filter((t) => !store.eff.removedTracks.has(t.id));
  function render() {
    const q = input.value.trim();
    if (q) {
      results = live().filter((t) => trackMatches(t, q)).slice(0, 60);
    } else {
      const playing = playingSong()?.track;
      const newest = live().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 30);
      results = playing ? [playing, ...newest.filter((t) => t.id !== playing.id)] : newest;
    }
    at = Math.min(at, Math.max(0, results.length - 1));
    const playingId = playingSong()?.track?.id;
    list.replaceChildren(
      ...(results.length
        ? results.map((t, i) =>
            h(
              'button',
              { class: 'song-pick-row', onclick: () => closeFn?.(t), onmousemove: () => i !== at && mark(i) },
              h('span', { class: 'song-pick-main' }, h('span', { class: 'ellipsis' }, t.title || t.fileName), h('span', { class: 'muted small ellipsis' }, t.artist || '')),
              h('span', { class: 'muted small' }, t.id === playingId ? _('Playing') : [fmt.bpm(t.bpm), t.key].filter((x) => x && x !== '–').join(' · ')),
            ),
          )
        : [h('div', { class: 'empty small' }, _('No matching songs'))]),
    );
    mark(at);
  }
  // Highlight without rebuilding the rows (a rebuild under the mouse would swallow the click).
  function mark(i, { scroll = false } = {}) {
    at = i;
    [...list.children].forEach((row, j) => row.classList.toggle('is-selected', j === at));
    if (scroll) list.children[at]?.scrollIntoView({ block: 'nearest' });
  }
  input.addEventListener('input', () => {
    at = 0;
    render();
  });
  render();
  const done = modal({
    title,
    wide: true,
    body: (close) => {
      closeFn = close;
      return [input, list, h('div', { class: 'muted small song-pick-hint' }, _('↑ ↓ to choose, Enter to link'))];
    },
    actions: (close) => [h('button', { class: 'btn', onclick: () => close(null) }, _('Cancel'))],
    onKey: (e, close) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        mark(Math.max(0, Math.min(results.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1))), { scroll: true });
      } else if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        if (results[at]) close(results[at]);
      }
    },
  });
  requestAnimationFrame(() => input.select());
  return done;
}

/** Write a note about one song (a library track, or a file by path). Shows the song's earlier notes. */
export function noteDialog({ track = null, path = null } = {}) {
  const song = store.songRef(track, path);
  const earlier = track ? store.notesFor(track) : store.notesForPath(path);
  const input = h('textarea', { class: 'input note-input', rows: 4, placeholder: _('What do you think of this song? #tags work, for example #opener #transition') });
  const save = (close) => {
    const text = input.value.trim();
    if (!text) return close(null);
    store.addNote(text, song);
    toast(_('Note saved'));
    close(true);
  };
  const done = modal({
    title: _('Note: {title}', { title: song.title }),
    className: 'modal-note',
    body: (close) => [
      earlier.length
        ? h(
            'div',
            { class: 'note-history' },
            h('div', { class: 'section-label' }, _n(earlier.length, '{n} earlier note', '{n} earlier notes')),
            earlier.slice(0, 5).map((n) => h('div', { class: 'note-mini' }, noteText(n.text), h('div', { class: 'muted small' }, when(n.updated)))),
          )
        : null,
      input,
      h('p', { class: 'muted small note-dialog-hint' }, _('⌘↵ saves.'), ' ', h('a', { href: '#notes', onclick: () => close(null) }, _('All notes are in the Notes tab →'))),
    ],
    actions: (close) => [h('button', { class: 'btn', onclick: () => close(null) }, _('Cancel')), h('button', { class: 'btn btn-primary', onclick: () => save(close) }, _('Save note'))],
    onKey: (e, close) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        save(close);
      }
    },
  });
  requestAnimationFrame(() => input.focus());
  return done;
}

/**
 * 📝 in front of a song title when the song has notes (before it, so a long title cannot cut it off).
 * Hover shows the newest notes; a click opens them with a box for a new one.
 */
export function noteMark({ track = null, path = null } = {}) {
  const notes = track ? store.notesFor(track) : path ? store.notesForPath(path) : [];
  if (!notes.length) return null;
  const clip = (s) => (s.length > 160 ? `${s.slice(0, 160)}…` : s);
  const tip = notes.slice(0, 3).map((n) => `${when(n.created)}\n${clip(n.text)}`);
  if (notes.length > 3) tip.push(_n(notes.length - 3, '{n} more in Notes →', '{n} more in Notes →'));
  const stop = (e) => e.stopPropagation(); // the row's own click / double-click (select, play) stays out of it
  return h(
    'button',
    {
      class: 'note-mark',
      title: tip.join('\n\n'),
      'aria-label': _n(notes.length, '{n} note', '{n} notes'),
      onclick: (e) => (stop(e), noteDialog({ track, path })),
      ondblclick: stop,
      onmousedown: stop,
    },
    '📝',
  );
}

/** Context-menu item for a song: "Add a note…" or "Notes (2)…". */
export function noteMenuItem({ track = null, path = null, hint } = {}) {
  const n = (track ? store.notesFor(track) : store.notesForPath(path)).length;
  return { label: n ? _('Add a note ({n} so far)…', { n }) : _('Add a note…'), hint, action: () => noteDialog({ track, path }) };
}
