// Audio quality labels from the real codec (read by afinfo), not just the file extension.
// AAC 256 sounds about as good as MP3 320, so each codec gets its own "low quality" threshold.
import { h } from './ui.js';

export const LOW_QUALITY = { mp3: 256, aac: 192, sampleRate: 44100 };
export const LOW_QUALITY_TEXT = `MP3 低於 ${LOW_QUALITY.mp3}k、AAC 低於 ${LOW_QUALITY.aac}k，或取樣率低於 44.1 kHz`;

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
    return { label: lossless || !kbps ? fmt : `${fmt} ${kbps}`, codec: fmt, kbps, lossless, low: false, known: false, detail: 'Serato 記錄的格式（還沒讀到檔案本身的資訊）' };
  }
  const [codec, bps, sampleRate, bitDepth] = info;
  if (!codec) {
    return { label: '讀不到', codec: '', kbps: null, lossless: false, low: false, unreadable: true, known: true, detail: 'macOS 打不開這個檔案，可能已經損壞，或副檔名和實際格式不符。建議試聽確認。' };
  }
  const lossless = LOSSLESS_CODECS.has(codec);
  const ext = extOf(path || '');
  const name = codec === 'lpcm' ? (ext.startsWith('aif') ? 'AIFF' : 'WAV') : CODEC_NAME[codec] || codec.toUpperCase();
  const kbps = bps ? nominalKbps(bps) : null;
  const reasons = [];
  if (!lossless && kbps) {
    if (codec === 'mp3' && kbps < LOW_QUALITY.mp3) reasons.push(`MP3 ${kbps}k，低於 ${LOW_QUALITY.mp3}k`);
    if (codec.startsWith('aac') && kbps < LOW_QUALITY.aac) reasons.push(`AAC ${kbps}k，低於 ${LOW_QUALITY.aac}k`);
  }
  if (sampleRate && sampleRate < LOW_QUALITY.sampleRate) reasons.push(`取樣率 ${sampleRate / 1000} kHz`);
  const detail = [
    lossless ? `${name} 無損${bitDepth ? ` ${bitDepth}-bit` : ''}` : `${name}${bps ? ` 實際 ${Math.round(bps / 1000)} kbps` : ''}`,
    sampleRate ? `${sampleRate / 1000} kHz` : null,
    ext === 'm4a' && codec === 'alac' ? '（m4a 裡面是無損 ALAC）' : null,
    ext === 'm4a' && codec.startsWith('aac') ? '（m4a 裡面是 AAC）' : null,
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
    detail: reasons.length ? `低音質：${reasons.join('、')}\n${detail}` : detail,
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
    q.low && !compact ? h('span', { class: 'qbadge-low' }, '低音質') : null,
  );
}
