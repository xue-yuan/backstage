// Spectrum picture of one file (drawn by ffmpeg on the server), with how to read it.
// Used to check a "Suspect" mark by eye before deleting or replacing a file.
import { qualityBadge, suspectText } from './quality.js';
import { store } from './store.js';
import { h, modal } from './ui.js';
import { _ } from './i18n.js';

/** False only once the server said ffmpeg is missing (the feature is then hidden). */
export const spectrumAvailable = () => store.spectrumProgress?.available !== false;

export function showSpectrum({ path, title, quality }) {
  const status = h('div', { class: 'muted small spectrum-status' }, _('Drawing the spectrum…'));
  const img = h('img', { class: 'spectrum-img', alt: '', src: `/api/spectrogram?path=${encodeURIComponent(path)}` });
  img.addEventListener('load', () => status.remove());
  img.addEventListener('error', () => {
    status.textContent = _('Could not draw the spectrum. It needs ffmpeg (brew install ffmpeg), and the file must be readable.');
    img.remove();
  });
  const q = quality || store.qualityOf(path);
  return modal({
    title: _('Spectrum: {title}', { title }),
    className: 'modal-spectrum',
    body: (close) => [
      h(
        'div',
        { class: 'spectrum-verdict' },
        qualityBadge(q),
        h('span', { class: q.suspect ? '' : 'muted' }, q.suspect ? suspectText(q) : _('No wall found: the sound does not stop where a lower bit rate would cut it (or the song is too quiet to tell).')),
      ),
      status,
      img,
      h(
        'ul',
        { class: 'spectrum-help' },
        h('li', {}, _('Look at the top edge of the coloured area: that is where the sound stops.')),
        h('li', {}, _('Real MP3 320 and AAC 256 reach about 20 kHz; real lossless (WAV, AIFF) about 22 kHz.')),
        h('li', {}, _('A flat, sharp ceiling across the whole song at about 16 kHz means a 128k source; about 19 kHz means 192k.')),
        h('li', {}, _('A soft, uneven edge that moves with the music is usually how the song was mastered (old or lo-fi recordings), not a transcode.')),
      ),
      h('p', { class: 'muted small' }, h('a', { href: '#guide', onclick: () => close(null) }, _('More in the Guide: checking suspect files →'))),
    ],
    actions: (close) => [h('button', { class: 'btn btn-primary', onclick: () => close(null) }, _('Close'))],
  });
}
