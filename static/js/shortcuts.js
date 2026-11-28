// Keyboard shortcuts, shown in the "?" dialog and in the Guide.
import { h } from './ui.js';
import { _ } from './i18n.js';

function rows() {
  return [
    [
      _('Sort'),
      [
        ['↑ ↓ / J K', _('Previous / next song')],
        [_('Space'), _('Play / pause (new songs start at 30%; change it in the player bar)')],
        ['← →', _('Back / forward 10 s (⇧ 30 s)')],
        ['Q W E R', _('Play from 0% / 25% / 50% / 75%')],
        ['1–9', _('Add to / remove from a pinned crate')],
        ['⇧ 1–5', _('Add to a suggested crate')],
        ['/', _('Search other crates (or create a new one)')],
        ['X', _('Reject this song')],
        ['⇧X', _('Remove from the library, keep the file')],
        ['N', _('Next crate with songs left')],
        ['M', _('Write a note about this song')],
      ],
    ],
    [
      _('Folders'),
      [
        ['↑ ↓', _('Select a folder (once a song is selected: change song)')],
        ['← →', _('Collapse / expand')],
        [_('Space'), _('Play / pause')],
        ['Q W E R', _('Play from 0% / 25% / 50% / 75%')],
        ['X', _('Reject')],
        ['V', _('Keep')],
        ['Esc', _('Back to the folder tree')],
      ],
    ],
    [
      _('Crates'),
      [
        ['↑ ↓', _('Select a crate')],
        ['← →', _('Collapse / expand')],
        ['Enter / F2', _('Rename')],
        ['N', _('New child crate')],
        ['⌥↑ ⌥↓', _('Move the crate up / down within its level')],
        ['Delete', _('Delete crate (added to the plan)')],
        ['⌘A', _('Select all songs (when the song list has focus)')],
      ],
    ],
    [
      _('Quality'),
      [
        ['↑ ↓ / J K', _('Previous / next file')],
        [_('Space'), _('Play / pause')],
        ['Enter', _('Show the spectrum')],
        ['F', _('Mark as genuine (moves to the next file)')],
        ['X', _('Reject')],
      ],
    ],
    [
      _('Notes'),
      [
        ['N', _('Write a new note')],
        ['/', _('Search notes')],
        ['⌘↵', _('Save the note')],
        ['Esc', _('Cancel editing')],
      ],
    ],
    [
      _('Everywhere'),
      [
        ['⌘Z', _('Undo the last change')],
        ['⌘R', _('Reload the Serato snapshot')],
        ['⌘1–9', _('Switch tabs')],
        ['?', _('Show this help')],
      ],
    ],
  ];
}

export function shortcutTable() {
  return h(
    'div',
    { class: 'help' },
    rows().map(([title, keys]) =>
      h('div', {}, h('div', { class: 'section-label' }, title), h('dl', { class: 'keys' }, keys.map(([k, d]) => [h('dt', {}, h('kbd', {}, k)), h('dd', {}, d)]))),
    ),
  );
}
