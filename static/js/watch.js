// Watches Serato while the page is open:
// - after Serato changes its library (e.g. songs dragged in), reload the snapshot once the database
//   has been quiet for a moment, and
// - when Serato DJ is closed, offer to apply the staged changes.
// The server answers /api/watch cheaply (ps + stat); nothing here touches Serato's files.
import { openApplyDialog } from './applyDialog.js';
import { _, _n } from './i18n.js';
import { APPLY_SUPPORTED } from './model.js';
import { store } from './store.js';
import { toast } from './ui.js';

const POLL_MS = 4000;
// How long the database must stay unchanged before reloading. Longer while Serato is open, because it
// writes play history during a set and we do not want to reload after every track.
const QUIET_MS = { closed: 2000, open: 15000 };

const listeners = new Set();
export const watch = {
  /** null until the first answer, then true / false. */
  seratoRunning: null,
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

let lastSignature = null;
let unchangedSince = 0;
let reloading = false;

/** Staged plan actions that Apply to Serato can write. */
export function pendingApplyOps() {
  return store.plan.changes.reduce((n, ch) => n + ch.ops.filter((o) => APPLY_SUPPORTED.has(o.type)).length, 0);
}

async function poll() {
  if (document.hidden || reloading) return;
  let s;
  try {
    s = await (await fetch('/api/watch', { cache: 'no-store' })).json();
  } catch {
    return;
  }

  const was = watch.seratoRunning;
  if (s.seratoRunning !== was) {
    watch.seratoRunning = s.seratoRunning;
    for (const fn of listeners) fn();
    const n = pendingApplyOps();
    if (was === true && !s.seratoRunning && n) {
      toast(_n(n, 'watch.seratoClosed'), {
        action: () => openApplyDialog(),
        actionLabel: _('watch.applyButton'),
        timeout: 20000,
      });
    }
  }

  const signature = JSON.stringify(s.signature);
  if (signature !== lastSignature) {
    lastSignature = signature;
    unchangedSince = Date.now();
  }
  if (!s.libraryChanged) return;
  if (Date.now() - unchangedSince < (s.seratoRunning ? QUIET_MS.open : QUIET_MS.closed)) return; // still being written
  if (document.querySelector('.modal-backdrop')) return; // never reload under an open dialog (e.g. while applying)

  reloading = true;
  try {
    await store.refreshSnapshot();
    const issues = store.eff.issues.length;
    toast(
      issues
        ? _n(issues, 'common.snapshotUpdatedIssues')
        : _('watch.libraryReloaded'),
      { tone: issues ? 'danger' : 'info' },
    );
  } catch {
    // try again on the next poll
  } finally {
    reloading = false;
  }
}

export function startWatch() {
  poll();
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) poll();
  });
}
