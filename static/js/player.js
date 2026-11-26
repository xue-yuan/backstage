// One shared audio element + the bottom player bar.
import { clear, h } from './ui.js';
import { _, _n } from './i18n.js';

const audio = new Audio();
audio.preload = 'auto';
let current = null; // { key, title, artist }
const listeners = new Set();
let bar;

function notify() {
  for (const fn of listeners) fn();
  renderBar();
}

export const player = {
  get current() {
    return current;
  },
  get playing() {
    return !audio.paused && !!current;
  },
  isCurrent(key) {
    return current?.key === key;
  },
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /** Identity of a playable item. Not `track.key`: library tracks have `key` = musical key (e.g. "8A"). */
  playId(track) {
    return track.playKey ?? `t${track.id}`;
  },
  /** track: a library track; or { playKey, src, title, artist } for arbitrary files */
  play(track, { at } = {}) {
    const key = this.playId(track);
    if (current?.key !== key) {
      current = { key, title: track.title || track.fileName, artist: track.artist || '', error: null };
      audio.src = track.src ?? `/api/audio/${track.id}`;
      if (at != null) {
        audio.addEventListener('loadedmetadata', () => (audio.currentTime = at * audio.duration), { once: true });
      }
    } else if (at != null && audio.duration) {
      audio.currentTime = at * audio.duration;
    }
    audio.play().catch(() => {});
    notify();
  },
  toggle(track) {
    if (track && !this.isCurrent(this.playId(track))) return this.play(track);
    if (!current) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  },
  pause() {
    audio.pause();
  },
  seekBy(sec) {
    if (current && audio.duration) audio.currentTime = Math.min(audio.duration, Math.max(0, audio.currentTime + sec));
  },
  seekTo(fraction) {
    if (current && audio.duration) audio.currentTime = fraction * audio.duration;
  },
};

audio.addEventListener('play', notify);
audio.addEventListener('pause', notify);
audio.addEventListener('ended', notify);
audio.addEventListener('timeupdate', () => updateProgress());
audio.addEventListener('error', () => {
  if (current) current.error = _('Cannot play: the format is not supported or the file is missing');
  notify();
});

let els = {};
export function mountPlayerBar(host) {
  bar = host;
  els.btn = h('button', { class: 'player-btn', title: _('Play / pause (Space)'), onclick: () => player.toggle() });
  els.title = h('div', { class: 'player-title' });
  els.time = h('div', { class: 'player-time' });
  els.fill = h('div', { class: 'player-fill' });
  els.track = h(
    'div',
    {
      class: 'player-progress',
      onclick: (e) => {
        const r = els.track.getBoundingClientRect();
        player.seekTo((e.clientX - r.left) / r.width);
      },
    },
    els.fill,
  );
  const vol = h('input', {
    type: 'range',
    min: 0,
    max: 1,
    step: 0.01,
    class: 'player-volume',
    title: _('Volume'),
    oninput: (e) => (audio.volume = Number(e.target.value)),
  });
  vol.value = String(audio.volume);
  host.append(els.btn, els.title, els.track, els.time, vol);
  renderBar();
}

function renderBar() {
  if (!bar) return;
  els.btn.textContent = player.playing ? '❚❚' : '▶';
  els.btn.disabled = !current;
  if (!current) {
    clear(els.title, h('span', { class: 'muted' }, _('Select a song and press Space to preview')));
  } else {
    // clear() skips null children; the native replaceChildren() would render them as "null".
    clear(
      els.title,
      h('strong', {}, current.title),
      current.artist ? h('span', { class: 'muted' }, ` · ${current.artist}`) : null,
      current.error ? h('span', { class: 'player-error' }, ` ${current.error}`) : null,
    );
  }
  updateProgress();
}

function clock(sec) {
  const s = Math.floor(sec || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function updateProgress() {
  if (!bar) return;
  const d = audio.duration || 0;
  els.fill.style.width = d ? `${(audio.currentTime / d) * 100}%` : '0%';
  els.time.textContent = current ? `${clock(audio.currentTime)} / ${d ? clock(d) : '–'}` : '';
}
