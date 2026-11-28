// Notes: a place to jot down thoughts about songs ("great opener", "mix out at the second drop") and
// songs to remember (heard in a set, to buy). A note can be linked to a library song; a note about a
// file that is not in Serato yet links itself once the file is imported (matched by path).
import { effectivePath, norm } from '../model.js';
import { noteText, pickSong, playableSong, playingSong, tagsOf, when } from '../notes.js';
import { player } from '../player.js';
import { qualityBadge } from '../quality.js';
import { store } from '../store.js';
import { clear, contextMenu, download, h, prefs, revealInFinder, toast } from '../ui.js';
import { _, _n } from '../i18n.js';

const SCOPES = [
  ['all', () => _('All')],
  ['song', () => _('About a song')],
  ['free', () => _('No song linked')],
];

export function createNotesView() {
  let search = '';
  let scope = prefs.get('notes.scope', 'all');
  let tag = null;
  let editing = null; // { id, input } while a note is being edited
  let draftSong = prefs.get('notes.draftSong', null); // song the next note will be linked to

  // ---------- composer ----------
  const composer = h('textarea', {
    class: 'input note-input',
    rows: 3,
    placeholder: _('A thought about a song, or a song you want to remember… #tags work, for example #opener #to-buy'),
    oninput: (e) => prefs.set('notes.draft', e.target.value),
    onkeydown: (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        saveDraft();
      } else if (e.key === 'Escape') e.target.blur();
    },
  });
  composer.value = prefs.get('notes.draft', '');
  const composeBar = h('div', { class: 'note-compose-bar' });
  const composePanel = h('section', { class: 'panel note-compose' }, composer, composeBar);

  function setDraftSong(song) {
    draftSong = song;
    prefs.set('notes.draftSong', song);
    renderComposeBar();
  }

  function renderComposeBar() {
    const playing = playingSong();
    const playingRef = playing ? store.songRef(playing.track, playing.path) : null;
    const sameAsDraft = playingRef && draftSong && (playingRef.id != null ? playingRef.id === draftSong.id : playingRef.path === draftSong.path);
    clear(
      composeBar,
      draftSong
        ? h(
            'span',
            { class: 'chip note-song-chip', title: draftSong.path || '' },
            '♪ ',
            h('span', { class: 'ellipsis' }, songLabel(draftSong)),
            h('button', { class: 'chip-x', title: _('Unlink'), onclick: () => setDraftSong(null) }, '×'),
          )
        : h(
            'button',
            {
              class: 'btn btn-sm',
              onclick: async () => {
                const t = await pickSong();
                if (t) setDraftSong(store.songRef(t));
                composer.focus();
              },
            },
            _('Link a song…'),
          ),
      playingRef && !sameAsDraft
        ? h('button', { class: 'btn btn-ghost btn-sm note-playing', title: _('Link the song that is playing'), onclick: () => (setDraftSong(playingRef), composer.focus()) }, _('♪ Playing: {title}', { title: playingRef.title }))
        : null,
      h('span', { class: 'muted small push-right' }, '⌘↵'),
      h('button', { class: 'btn btn-primary btn-sm', onclick: saveDraft }, _('Save note')),
    );
  }

  function saveDraft() {
    const text = composer.value.trim();
    if (!text) {
      composer.focus();
      return;
    }
    store.addNote(text, draftSong);
    composer.value = '';
    prefs.set('notes.draft', '');
    setDraftSong(null);
    toast(_('Note saved'));
  }

  // ---------- list ----------
  const searchInput = h('input', {
    class: 'input input-sm',
    placeholder: _('Search notes and songs… (/)'),
    oninput: (e) => {
      search = e.target.value;
      renderList();
    },
    onkeydown: (e) => {
      if (e.key === 'Escape') e.target.blur();
      e.stopPropagation();
    },
  });
  const scopeEl = h('div', { class: 'segmented' });
  const tagsEl = h('div', { class: 'chips note-tags' });
  const scrollEl = h('div', { class: 'note-scroll' });
  const listPanel = h(
    'section',
    { class: 'panel note-list-panel' },
    h('div', { class: 'toolbar note-toolbar' }, searchInput, scopeEl, h('button', { class: 'btn btn-ghost btn-sm', title: _('Download all notes as a Markdown file'), onclick: exportNotes }, _('Export'))),
    tagsEl,
    scrollEl,
  );
  const el = h('div', { class: 'view notes' }, composePanel, listPanel);
  const offPlayer = player.onChange(() => {
    renderComposeBar();
    for (const b of scrollEl.querySelectorAll('[data-play-key]')) b.textContent = player.isCurrent(b.dataset.playKey) && player.playing ? '❚❚' : '▶';
  });

  const songLabel = (song) => {
    const t = store.noteTrack(song);
    const title = t ? t.title || t.fileName : song.title;
    const artist = t ? t.artist : song.artist;
    return artist ? `${title} — ${artist}` : title;
  };

  function matches(n) {
    if (scope === 'song' && !n.song) return false;
    if (scope === 'free' && n.song) return false;
    if (tag && !tagsOf(n.text).includes(tag)) return false;
    if (!search) return true;
    const hay = norm(`${n.text} ${n.song ? songLabel(n.song) : ''}`);
    return norm(search).split(' ').every((w) => hay.includes(w));
  }

  function renderList() {
    const all = store.notes;
    const counts = { all: all.length, song: all.filter((n) => n.song).length, free: all.filter((n) => !n.song).length };
    clear(
      scopeEl,
      SCOPES.map(([key, label]) =>
        h(
          'button',
          {
            class: `seg ${scope === key ? 'is-active' : ''}`,
            onclick: () => {
              scope = key;
              prefs.set('notes.scope', key);
              renderList();
            },
          },
          label(),
          h('span', { class: 'count' }, counts[key]),
        ),
      ),
    );

    // Tags, most used first.
    const tagCount = new Map();
    for (const n of all) for (const t of tagsOf(n.text)) tagCount.set(t, (tagCount.get(t) || 0) + 1);
    if (tag && !tagCount.has(tag)) tag = null;
    const tags = [...tagCount].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    tagsEl.hidden = !tags.length;
    clear(
      tagsEl,
      tags.map(([t, n]) => h('button', { class: `chip ${t === tag ? 'is-active' : ''}`, onclick: () => setTag(t === tag ? null : t) }, `#${t}`, h('span', { class: 'muted' }, n))),
    );

    const shown = all.filter(matches).sort((a, b) => b.created - a.created);
    if (!all.length) {
      clear(scrollEl, emptyIntro());
      return;
    }
    clear(scrollEl, shown.length ? shown.map(card) : h('div', { class: 'empty' }, _('No notes match')));
  }

  function setTag(t) {
    tag = t;
    renderList();
  }

  function emptyIntro() {
    return h(
      'div',
      { class: 'empty note-empty' },
      h('p', {}, _('No notes yet.')),
      h('p', { class: 'small' }, _('Write anything: what a song is good for, where to mix in or out, or a song you heard and want to find. Add #tags to group them.')),
      h('p', { class: 'small' }, _('You can also right-click a song in Sort, Crates or Folders → "Add a note…" (in Sort press M).')),
    );
  }

  function card(n) {
    if (editing?.id === n.id) return editCard(n);
    return h(
      'article',
      { class: 'note-card', oncontextmenu: (e) => noteMenu(e, n), ondblclick: () => startEdit(n) },
      n.song ? songLine(n.song) : null,
      noteText(n.text, { onTag: setTag }),
      h(
        'div',
        { class: 'note-foot' },
        h('span', { class: 'muted small', title: n.updated !== n.created ? _('Edited {time}', { time: when(n.updated) }) : '' }, when(n.created), n.updated !== n.created ? ` · ${_('edited')}` : ''),
        n.song ? null : h('button', { class: 'btn btn-ghost btn-xs', onclick: () => linkSong(n) }, _('Link a song…')),
        h('button', { class: 'btn btn-ghost btn-xs', onclick: () => startEdit(n) }, _('Edit')),
        h('button', { class: 'btn btn-ghost btn-xs btn-danger-ghost', onclick: () => store.deleteNote(n.id) }, _('Delete')),
      ),
    );
  }

  function songLine(song) {
    const t = store.noteTrack(song);
    const play = playableSong(song);
    const crates = t ? (store.eff.cratesOf.get(t.id) || []).length : 0;
    const rejected = t && store.eff.rejectedTracks.has(t.id);
    const removed = t && store.eff.removedTracks.has(t.id);
    return h(
      'div',
      { class: 'note-song' },
      play
        ? h('button', { class: 'icon-btn', dataset: { playKey: player.playId(play) }, title: _('Preview'), onclick: () => player.toggle(play) }, player.isCurrent(player.playId(play)) && player.playing ? '❚❚' : '▶')
        : null,
      h('span', { class: 'note-song-title ellipsis', title: t ? effectivePath(store.eff, t) : song.path || '' }, songLabel(song)),
      t ? qualityBadge(store.trackQuality(t), { compact: true }) : null,
      t
        ? h('span', { class: 'muted small' }, rejected ? h('span', { class: 'tag tag-danger' }, _('Rejected')) : removed ? h('span', { class: 'tag tag-danger' }, _('Removed (in the plan)')) : crates ? _n(crates, 'In {n} crate', 'In {n} crates') : _('In no crate'))
        : h('span', { class: 'tag tag-warn' }, _('Not in Serato')),
    );
  }

  function editCard(n) {
    return h(
      'article',
      { class: 'note-card is-editing' },
      n.song ? songLine(n.song) : null,
      editing.input,
      h(
        'div',
        { class: 'note-foot' },
        h('span', { class: 'muted small' }, _('⌘↵ saves, Esc cancels')),
        h('button', { class: 'btn btn-sm', onclick: () => endEdit(false) }, _('Cancel')),
        h('button', { class: 'btn btn-primary btn-sm', onclick: () => endEdit(true) }, _('Save')),
      ),
    );
  }

  function startEdit(n) {
    if (editing) endEdit(true);
    const input = h('textarea', {
      class: 'input note-input',
      rows: Math.min(12, Math.max(3, n.text.split('\n').length + 1)),
      onkeydown: (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          endEdit(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          endEdit(false);
        }
      },
    });
    input.value = n.text;
    editing = { id: n.id, input };
    renderList();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function endEdit(save) {
    const ed = editing;
    editing = null;
    if (save && ed) {
      const note = store.notes.find((x) => x.id === ed.id);
      const text = ed.input.value.trim();
      if (note && !text) store.deleteNote(note.id);
      else if (note && text !== note.text) store.updateNote(note.id, { text });
    }
    renderList();
  }

  async function linkSong(n) {
    // Prefill the search with the note's first line, so "Artist - Title" notes link with one Enter.
    // "(Extended Mix)", "[2024]" and #tags are left out: they rarely match how the library spells it.
    const first = n.text.split('\n')[0].replace(/#[\p{L}\p{N}_-]+|\([^)]*\)|\[[^\]]*\]/gu, '').trim();
    const t = await pickSong({ title: n.song ? _('Change the song') : _('Link a song'), query: n.song ? '' : first.slice(0, 80) });
    if (t) store.updateNote(n.id, { song: store.songRef(t) });
  }

  function noteMenu(e, n) {
    const play = n.song ? playableSong(n.song) : null;
    const t = n.song ? store.noteTrack(n.song) : null;
    const path = t ? effectivePath(store.eff, t) : n.song?.path;
    contextMenu(e, [
      play ? { label: player.isCurrent(player.playId(play)) && player.playing ? _('Pause') : _('Play'), action: () => player.toggle(play) } : null,
      { label: _('Edit'), action: () => startEdit(n) },
      { label: n.song ? _('Change the song…') : _('Link a song…'), action: () => linkSong(n) },
      n.song ? { label: _('Unlink the song'), action: () => store.updateNote(n.id, { song: null }) } : null,
      path ? { label: _('Show in Finder'), action: () => revealInFinder(path) } : null,
      'sep',
      { label: _('Delete'), danger: true, action: () => store.deleteNote(n.id) },
    ]);
  }

  function exportNotes() {
    const lines = [`# ${_('Notes')}`, ''];
    for (const n of [...store.notes].sort((a, b) => b.created - a.created)) {
      lines.push(`## ${when(n.created)}${n.song ? ` · ${songLabel(n.song)}` : ''}`, '', n.text, '');
    }
    const d = new Date();
    download(`cratify-notes-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.md`, lines.join('\n'), 'text/markdown');
  }

  // ---------- updates ----------
  function update() {
    renderComposeBar();
    // Re-rendering while typing in a note would move the cursor: the edit's end renders anyway.
    if (editing && document.activeElement === editing.input) return;
    renderList();
  }

  renderComposeBar();
  renderList();
  if (store.notesError) toast(_('Notes could not be read ({error}), so they are not saved. Reload the page to try again.', { error: store.notesError }), { tone: 'danger', timeout: 8000 });

  return {
    el,
    title: _('Notes'),
    update,
    onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return false;
      if (e.key === 'n') {
        composer.focus();
        return true;
      }
      if (e.key === '/') {
        searchInput.focus();
        return true;
      }
      return false;
    },
    destroy() {
      if (editing) endEdit(true); // leaving the tab keeps an edit instead of dropping it
      offPlayer();
    },
  };
}
