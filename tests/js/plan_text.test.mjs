// planText.js: the plan stores data only; its text is made when shown, in the current language and
// with current crate names. Plans saved by older versions (with ready-made text) still read.
import './setup.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { applyPlan, buildBase } = await import('../../static/js/model.js');
const { changeTitle, crateName, opText, reasonText, trackName } = await import('../../static/js/planText.js');

const base = buildBase({
  rootId: 0,
  tracks: [
    { id: 1, title: 'Night Shift', artist: 'Maren Vos', fileName: 'night.wav', path: '/m/night.wav' },
    { id: 2, title: '', artist: '', fileName: 'loop.wav', path: '/m/loop.wav' },
  ],
  crates: [
    { id: 10, name: 'House', parent: 0, order: 1 },
    { id: 11, name: 'Opening', parent: 10, order: 2 },
    { id: 12, name: 'Techno', parent: 0, order: 3 },
  ],
  memberships: [[11, 1]],
  snapshot: {},
});

function context(changes) {
  return { eff: applyPlan(base, changes), changes, quality: (id) => (id === 1 ? 'WAV 24-bit' : '?') };
}

test('songs and crates are named from the library', () => {
  const ctx = context([]);
  assert.equal(trackName(ctx, 1), 'Maren Vos – Night Shift');
  assert.equal(trackName(ctx, 2), 'loop.wav');
  assert.equal(crateName(ctx, 11), 'House / Opening');
});

test('op text uses the names as they are now', () => {
  const changes = [{ id: 'a', ops: [{ type: 'add', crate: 11, asset: 1 }, { type: 'renameCrate', crate: 10, name: 'Deep House', from: 'House' }] }];
  const ctx = context(changes);
  assert.equal(opText(ctx, changes[0].ops[0]), 'Add to "Deep House / Opening": Maren Vos – Night Shift');
  assert.equal(opText(ctx, changes[0].ops[1]), 'Rename "House" → "Deep House"');
});

test('a crate the plan deletes or merges away keeps its last known path', () => {
  const changes = [{ id: 'a', ops: [{ type: 'mergeCrate', from: 11, into: 12 }] }];
  const ctx = context(changes);
  assert.equal(opText(ctx, changes[0].ops[0]), 'Merge "House / Opening" into "Techno"');
});

test('a crate created and deleted in the plan is named from its creation', () => {
  const changes = [{ id: 'a', ops: [{ type: 'createCrate', id: 'new-x', name: 'Closing', parent: 10 }, { type: 'deleteCrate', crate: 'new-x' }] }];
  const ctx = context(changes);
  assert.equal(opText(ctx, changes[0].ops[1]), 'Delete crate "Closing"');
});

test('removal reasons are keys; older plans stored the text', () => {
  const ctx = context([]);
  assert.equal(reasonText('cleanup.duplicate'), 'Duplicate');
  assert.equal(reasonText('重複'), '重複');
  assert.equal(opText(ctx, { type: 'removeTrack', asset: 1, reason: 'common.missingFile' }), 'Remove from the Serato library (file kept): Maren Vos – Night Shift (Missing file)');
  assert.equal(opText(ctx, { type: 'removeTrack', asset: 1, reason: 'common.reject', deleteFile: true }), 'Reject (remove from Serato, move the file to the Trash): Maren Vos – Night Shift');
});

test('change titles are made from their key and parameters', () => {
  const ctx = context([]);
  assert.equal(changeTitle(ctx, { title: { key: 'cleanup.removeMissing', n: 1 }, ops: [] }), 'Remove 1 missing song');
  assert.equal(changeTitle(ctx, { title: { key: 'cleanup.removeMissing', n: 3 }, ops: [] }), 'Remove 3 missing songs');
  assert.equal(
    changeTitle(ctx, { title: { key: 'sort.addedTo', params: { name: 'Night Shift', crate: 'House' }, extra: [{ key: 'sort.removedFromSource' }] }, ops: [] }),
    '"Night Shift" → House (removed from the source)',
  );
  assert.equal(
    changeTitle(ctx, { title: { key: 'cleanup.mergeDuplicatesChange', params: { title: 'Night Shift', quality: { quality: 1 } } }, ops: [] }),
    'Merge duplicates: Night Shift (keep WAV 24-bit)',
  );
  const reorder = { type: 'moveCrate', crate: 12, parent: 0, before: 10, reorder: true };
  assert.equal(changeTitle(ctx, { title: { fromOp: true }, ops: [reorder] }), 'Reorder: "Techno" before "House"');
});

test('plans saved by older versions show their stored text', () => {
  const ctx = context([]);
  assert.equal(changeTitle(ctx, { label: '「Night Shift」→ House', ops: [] }), '「Night Shift」→ House');
  // A rename from before "from" was recorded: only the stored text has the old name.
  assert.equal(opText(ctx, { type: 'renameCrate', crate: 10, name: 'House', text: 'Rename "Hous" → "House"' }), 'Rename "Hous" → "House"');
  // Other ops are rebuilt from their data, whatever their old text said.
  assert.equal(opText(ctx, { type: 'deleteCrate', crate: 12, text: '刪除 crate「Techno」' }), 'Delete crate "Techno"');
});
