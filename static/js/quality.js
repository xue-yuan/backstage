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
  if (q.suspect) return q.suspect.source; // a transcode is only as good as its source
  if (q.lossless) return 2000;
  if (!q.kbps) return 0;
  return q.codec.includes('AAC') ? q.kbps * 1.25 : q.kbps;
}

export function qualityBadge(q, { compact = false } = {}) {
  const suspect = q.suspect ? suspectText(q) : null;
  return h(
    'span',
    { class: `qbadge ${q.low || q.unreadable ? 'is-low' : ''} ${q.lossless && !q.suspect ? 'is-lossless' : ''} ${q.known ? '' : 'is-unknown'}`, title: suspect ? `${suspect}\n\n${q.detail}` : q.detail },
    q.label || '–',
    q.low && !compact ? h('span', { class: 'qbadge-low' }, _('Low quality')) : null,
    suspect ? h('span', { class: 'qbadge-suspect' }, _('Suspect')) : null,
  );
}

// ---------- transcodes ("fake 320k", "fake lossless") ----------
// spec: [cutoff kHz, kind] from /api/spectrum (serato_crates/spectrum.py). Only a "wall" (an encoder's
// low-pass) counts; a gentle slope is how the song sounds and gets no verdict.

/** The bit rate whose encoder usually cuts the sound at this frequency. */
export function sourceKbps(khz) {
  return khz < 17.3 ? 128 : khz < 18 ? 160 : khz < 19 ? 192 : khz < 19.6 ? 256 : 320;
}

/** { cutoff, source, lossless } when the sound stops well below what the format can hold; else null. */
export function suspicionOf(q, spec) {
  if (!spec || !q.known || q.unreadable) return null;
  const [cutoff, kind] = spec;
  if (kind !== 'wall' || cutoff == null) return null;
  const source = sourceKbps(cutoff);
  if (q.lossless) return cutoff <= 20.6 ? { cutoff, source, lossless: true } : null;
  const kbps = q.kbps || 0;
  if ((kbps >= 250 && cutoff < 19) || (kbps >= 180 && kbps < 250 && cutoff < 17.3)) return { cutoff, source, lossless: false };
  return null;
}

export function suspectText(q) {
  const s = q.suspect;
  const khz = s.cutoff.toFixed(1);
  const main = s.lossless
    ? _('Suspect: the sound stops at {khz} kHz. Real lossless audio goes up to about 22 kHz, so this {label} was probably made from an MP3 or AAC file.', { khz, label: q.label })
    : _('Suspect: the sound stops at {khz} kHz, where a {source}k encoder cuts it. This {label} was probably converted from a {source}k file.', { khz, source: s.source, label: q.label });
  return `${main} ${_('This is an automatic guess: check the spectrum (right-click → Spectrum) before you delete or replace it.')}`;
}
