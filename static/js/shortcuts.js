// Keyboard shortcuts, shown in the "?" dialog and in the Guide.
import { h } from './ui.js';
import { _ } from './i18n.js';

function rows() {
  return [
    [
      _('tab.sort'),
      [
        ['↑ ↓ / J K', _('shortcuts.previousNextSong')],
        [_('common.space'), _('shortcuts.playPauseFrom30')],
        ['← →', _('shortcuts.seek')],
        ['Q W E R', _('shortcuts.jump')],
        ['1–9', _('shortcuts.pinnedCrate')],
        ['⇧ 1–5', _('shortcuts.suggestedCrate')],
        ['/', _('shortcuts.searchCrates')],
        ['X', _('shortcuts.rejectSong')],
        ['⇧X', _('common.removeKeepFile')],
        ['N', _('shortcuts.nextCrate')],
        ['M', _('shortcuts.writeNote')],
      ],
    ],
    [
      _('tab.folders'),
      [
        ['↑ ↓', _('shortcuts.selectFolder')],
        ['← →', _('shortcuts.collapseExpand')],
        [_('common.space'), _('shortcuts.playPause')],
        ['Q W E R', _('shortcuts.jump')],
        ['X', _('common.reject')],
        ['V', _('common.keep')],
        ['Esc', _('shortcuts.backToTree')],
      ],
    ],
    [
      _('tab.crates'),
      [
        ['↑ ↓', _('shortcuts.selectCrate')],
        ['← →', _('shortcuts.collapseExpand')],
        ['Enter / F2', _('common.rename')],
        ['N', _('common.newChildCrate')],
        ['⌥↑ ⌥↓', _('shortcuts.reorderCrate')],
        ['Delete', _('shortcuts.deleteCrate')],
        ['⌘A', _('shortcuts.selectAllSongs')],
      ],
    ],
    [
      _('tab.quality'),
      [
        ['↑ ↓ / J K', _('shortcuts.previousNextFile')],
        [_('common.space'), _('shortcuts.playPause')],
        ['Enter', _('shortcuts.showSpectrum')],
        ['F', _('shortcuts.markGenuine')],
        ['X', _('common.reject')],
      ],
    ],
    [
      _('tab.notes'),
      [
        ['N', _('shortcuts.newNote')],
        ['/', _('shortcuts.searchNotes')],
        ['⌘↵', _('shortcuts.saveNote')],
        ['Esc', _('shortcuts.cancelEditing')],
      ],
    ],
    [
      _('shortcuts.everywhere'),
      [
        ['⌘Z', _('shortcuts.undoLastChange')],
        ['⌘R', _('shortcuts.reload')],
        ['⌘1–9', _('shortcuts.switchTabs')],
        ['?', _('shortcuts.showHelp')],
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
