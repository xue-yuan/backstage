// Audio quality labels from the real codec (read by afinfo), not just the file extension.
// AAC 256 sounds about as good as MP3 320, so each codec gets its own "low quality" threshold.
import { h } from './ui.js';
import { _, _n } from './i18n.js';

export const LOW_QUALITY = { mp3: 256, aac: 192, sampleRate: 44100 };
export const LOW_QUALITY_TEXT = _('MP3 below {mp3}k, AAC below {aac}k, or a sample rate below 44.1 kHz', { mp3: LOW_QUALITY.mp3, aac: LOW_QUALITY.aac });

const NOMINAL = [64, 96, 112, 128, 160, 192, 224, 256, 320];
const LOSSLESS_CODECS = new Set(['lpcm', 'alac', 'flac']);
const CODEC_NAME = { aac: 'AAC', aach: 'HE-AAC', aacp: 'HE-AAC', mp3: 'MP3', alac: 'ALAC', flac: 'FLAC' };

// Container overhead makes AAC 256 read as ~262 kbps; show the nominal rate when it is close.
function nominalKbps(bps) {
  const k = bps / 1000;
  const near = NOMINAL.find((n) => Math.abs(k - n) / n <= 0.04);
  return near ?? Math.round(k);
}

const extOf = (path) => (path.split('.').pop() || '').toLowerCase();

/**
 * info: [codec, bitsPerSecond, sampleRate, bitDepth] from /api/audio-info, or undefined.
 * track: Serato track, used as a fallback when the file could not be read.
 */
export function describeQuality(info, path, track) {
  if (!info) {
    const fmt = (track?.format || extOf(path || '')).toUpperCase();
    const kbps = track?.bitRate ? Math.round(track.bitRate / 1000) : null;
    const lossless = ['WAV', 'AIF', 'AIFF', 'FLAC'].includes(fmt);
    return { label: lossless || !kbps ? fmt : `${fmt} ${kbps}`, codec: fmt, kbps, lossless, low: false, known: false, detail: _('Format as recorded by Serato (the file itself has not been read yet)') };
  }
  const [codec, bps, sampleRate, bitDepth] = info;
  if (!codec) {
    return { label: _('Unreadable'), codec: '', kbps: null, lossless: false, low: false, unreadable: true, known: true, detail: _('macOS cannot open this file. It may be damaged, or its extension may not match its real format. Preview it to check.') };
  }
  const lossless = LOSSLESS_CODECS.has(codec);
  const ext = extOf(path || '');
  const name = codec === 'lpcm' ? (ext.startsWith('aif') ? 'AIFF' : 'WAV') : CODEC_NAME[codec] || codec.toUpperCase();
  const kbps = bps ? nominalKbps(bps) : null;
  const reasons = [];
  if (!lossless && kbps) {
    if (codec === 'mp3' && kbps < LOW_QUALITY.mp3) reasons.push(_('MP3 {kbps}k, below {min}k', { kbps, min: LOW_QUALITY.mp3 }));
    if (codec.startsWith('aac') && kbps < LOW_QUALITY.aac) reasons.push(_('AAC {kbps}k, below {min}k', { kbps, min: LOW_QUALITY.aac }));
  }
  if (sampleRate && sampleRate < LOW_QUALITY.sampleRate) reasons.push(_('Sample rate {khz} kHz', { khz: sampleRate / 1000 }));
  const detail = [
    lossless ? `${_('{name} lossless', { name })}${bitDepth ? ` ${bitDepth}-bit` : ''}` : `${name}${bps ? ` ${_('actual {kbps} kbps', { kbps: Math.round(bps / 1000) })}` : ''}`,
    sampleRate ? `${sampleRate / 1000} kHz` : null,
    ext === 'm4a' && codec === 'alac' ? _('(lossless ALAC inside the m4a)') : null,
    ext === 'm4a' && codec.startsWith('aac') ? _('(AAC inside the m4a)') : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    label: lossless ? (bitDepth && bitDepth !== 16 ? `${name} ${bitDepth}-bit` : name) : kbps ? `${name} ${kbps}` : name,
    codec: name,
    kbps,
    lossless,
    low: reasons.length > 0,
    reasons,
    known: true,
    detail: reasons.length ? `${_('Low quality: {reasons}', { reasons: reasons.join(_(', ')) })}\n${detail}` : detail,
  };
}

/** Comparable score for picking which copy of a duplicate to keep (higher is better). */
export function qualityScore(q) {
  if (q.unreadable) return -1;
  if (q.lossless) return 2000;
  if (!q.kbps) return 0;
  return q.codec.includes('AAC') ? q.kbps * 1.25 : q.kbps;
}

export function qualityBadge(q, { compact = false } = {}) {
  return h(
    'span',
    { class: `qbadge ${q.low || q.unreadable ? 'is-low' : ''} ${q.lossless ? 'is-lossless' : ''} ${q.known ? '' : 'is-unknown'}`, title: q.detail },
    q.label || '–',
    q.low && !compact ? h('span', { class: 'qbadge-low' }, _('Low quality')) : null,
  );
}
