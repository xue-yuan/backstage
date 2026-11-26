import { _, _n } from './i18n.js';
// Small DOM helpers, virtual list, toasts and modal dialogs (no browser alert/confirm).

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export const fmt = {
  duration(ms) {
    if (!ms) return '–';
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  },
  bpm(b) {
    if (!b) return '–';
    return Math.abs(b - Math.round(b)) < 0.05 ? String(Math.round(b)) : b.toFixed(1);
  },
  date(sec) {
    if (!sec) return '–';
    const d = new Date(sec * 1000);
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  },
  time(ms) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  },
  size(bytes) {
    if (!bytes) return '–';
    return bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`;
  },
  bitrate(t) {
    if (['wav', 'aiff', 'aif', 'flac'].includes((t.format || '').toLowerCase())) return t.format.toUpperCase();
    return t.bitRate ? `${Math.round(t.bitRate / 1000)} kbps` : (t.format || '').toUpperCase();
  },
  shortPath(p) {
    return p.replace(/^\/Users\/[^/]+/, '~');
  },
};

export function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`crate-desk:${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`crate-desk:${key}`, JSON.stringify(value));
    } catch {
      /* storage unavailable: preference just isn't remembered */
    }
  },
};

// ---------- Virtual list (fixed row height) ----------
export class VirtualList {
  constructor({ rowHeight, renderRow, className = '' }) {
    this.rowHeight = rowHeight;
    this.renderRow = renderRow;
    this.items = [];
    this.el = h('div', { class: `vlist ${className}` });
    this.spacer = h('div', { class: 'vlist-spacer' });
    this.rows = h('div', { class: 'vlist-rows' });
    this.empty = null;
    this.el.append(this.spacer, this.rows);
    this.el.addEventListener('scroll', () => this.render(), { passive: true });
    this.ro = new ResizeObserver(() => this.render());
    this.ro.observe(this.el);
  }
  setItems(items, emptyNode) {
    this.items = items;
    this.empty = emptyNode || null;
    this.spacer.style.height = `${items.length * this.rowHeight}px`;
    this.render();
  }
  render() {
    const { scrollTop, clientHeight } = this.el;
    if (!this.items.length) {
      clear(this.rows, this.empty);
      return;
    }
    const start = Math.max(0, Math.floor(scrollTop / this.rowHeight) - 6);
    const end = Math.min(this.items.length, Math.ceil((scrollTop + clientHeight) / this.rowHeight) + 6);
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const row = this.renderRow(this.items[i], i);
      row.style.transform = `translateY(${i * this.rowHeight}px)`;
      row.style.height = `${this.rowHeight}px`;
      frag.append(row);
    }
    this.rows.replaceChildren(frag);
  }
  scrollToIndex(i) {
    if (i < 0) return;
    const top = i * this.rowHeight;
    const bottom = top + this.rowHeight;
    if (top < this.el.scrollTop) this.el.scrollTop = top;
    else if (bottom > this.el.scrollTop + this.el.clientHeight) this.el.scrollTop = bottom - this.el.clientHeight;
    this.render();
  }
  destroy() {
    this.ro.disconnect();
  }
}

// ---------- Toasts ----------
let toastHost;
export function toast(message, { action, actionLabel = _('Undo'), tone = 'info', timeout = 4000 } = {}) {
  toastHost ||= document.body.appendChild(h('div', { class: 'toast-host' }));
  const el = h(
    'div',
    { class: `toast toast-${tone}` },
    h('span', {}, message),
    action &&
      h('button', {
        class: 'btn btn-ghost btn-sm',
        onclick: () => {
          action();
          el.remove();
        },
      }, actionLabel),
  );
  toastHost.append(el);
  setTimeout(() => el.remove(), timeout);
}

// ---------- Modals ----------
export function modal({ title, body, actions, onKey, wide = false }) {
  return new Promise((resolve) => {
    const close = (value) => {
      document.removeEventListener('keydown', keyHandler, true);
      backdrop.remove();
      resolve(value);
    };
    const keyHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(null);
      } else if (onKey) {
        onKey(e, close);
      }
    };
    const box = h(
      'div',
      { class: `modal ${wide ? 'modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
      h('h2', { class: 'modal-title' }, title),
      h('div', { class: 'modal-body' }, typeof body === 'function' ? body(close) : body),
      actions && h('div', { class: 'modal-actions' }, actions(close)),
    );
    const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (e) => e.target === backdrop && close(null) }, box);
    document.body.append(backdrop);
    document.addEventListener('keydown', keyHandler, true);
    requestAnimationFrame(() => box.querySelector('input, button.btn-primary, button')?.focus());
  });
}

export function confirmDialog({ title, message, okText = _('OK'), danger = false }) {
  return modal({
    title,
    body: h('p', {}, message),
    actions: (close) => [
      h('button', { class: 'btn', onclick: () => close(false) }, _('Cancel')),
      h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => close(true) }, okText),
    ],
    onKey: (e, close) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        close(true);
      }
    },
  }).then((v) => v === true);
}

export function promptDialog({ title, value = '', placeholder = '', okText = _('OK'), validate }) {
  const input = h('input', { class: 'input', value, placeholder });
  const err = h('div', { class: 'field-error' });
  const submit = (close) => {
    const v = input.value.trim();
    const problem = !v ? _('Please enter a name') : validate?.(v);
    if (problem) {
      err.textContent = problem;
      return;
    }
    close(v);
  };
  return modal({
    title,
    body: [input, err],
    actions: (close) => [
      h('button', { class: 'btn', onclick: () => close(null) }, _('Cancel')),
      h('button', { class: 'btn btn-primary', onclick: () => submit(close) }, okText),
    ],
    onKey: (e, close) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit(close);
      }
    },
  }).then((v) => {
    return v;
  });
}

export function download(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
