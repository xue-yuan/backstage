// Spectrum picture of one file (drawn by ffmpeg on the server), with how to read it.
// Used to check a "Suspect" mark by eye before deleting or replacing a file.
import { qualityBadge, suspectText } from './quality.js';
import { store } from './store.js';
import { h, modal } from './ui.js';
import { _ } from './i18n.js';

/** False only once the server said ffmpeg is missing (the feature is then hidden). */
export const spectrumAvailable = () => store.spectrumProgress?.available !== false;

export function showSpectrum({ path, title, quality }) {
  const status = h('div', { class: 'muted small spectrum-status' }, _('spectrum.drawing'));
  const img = h('img', { class: 'spectrum-img', alt: '', src: `/api/spectrogram?path=${encodeURIComponent(path)}` });
  img.addEventListener('load', () => status.remove());
  img.addEventListener('error', () => {
    status.textContent = _('spectrum.failed');
    img.remove();
  });
  const q = quality || store.qualityOf(path);
  return modal({
    title: _('spectrum.title', { title }),
    className: 'modal-spectrum',
    body: (close) => [
      h(
        'div',
        { class: 'spectrum-verdict' },
        qualityBadge(q),
        h('span', { class: q.suspect ? '' : 'muted' }, q.suspect ? suspectText(q) : _('spectrum.noCutOff')),
      ),
      status,
      img,
      h(
        'ul',
        { class: 'spectrum-help' },
        h('li', {}, _('spectrum.tipEdge')),
        h('li', {}, _('spectrum.tipGenuine')),
        h('li', {}, _('spectrum.tipCeiling')),
        h('li', {}, _('spectrum.tipMastering')),
      ),
      h('p', { class: 'muted small' }, h('a', { href: '#guide', onclick: () => close(null) }, _('spectrum.guideLink'))),
    ],
    actions: (close) => [h('button', { class: 'btn btn-primary', onclick: () => close(null) }, _('spectrum.close'))],
  });
}
