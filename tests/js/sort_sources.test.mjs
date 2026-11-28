// sortSources.js (the Sort view's data) and the folder helpers in folderReport.js.
import './setup.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { applyPlan, buildBase, classificationRules } = await import('../../static/js/model.js');
const S = await import('../../static/js/sortSources.js');
const { fileMatches, folderChildren, folderFiles } = await import('../../static/js/folderReport.js');

// Inbox (unsorted) holds two crates; House is a sorting crate. s1 is already sorted (also in House).
const song = (id, title, addedAt, extra = {}) => ({ id, title, artist: '', fileName: `${title}.wav`, path: `/m/${title}.wav`, addedAt, exists: true, ...extra });
const base = buildBase({
  rootId: 0,
  tracks: [song(1, 's1', 300), song(2, 's2', 200, { artist: 'B' }), song(3, 's3', 100, { artist: 'A' }), song(4, 's4', 50)],
  crates: [
    { id: 10, name: 'Inbox', parent: 0, order: 1 },
    { id: 11, name: 'Week 1', parent: 10, order: 2 },
    { id: 12, name: 'Week 2', parent: 10, order: 3 },
    { id: 20, name: 'House', parent: 0, order: 4 },
  ],
  memberships: [[11, 1], [11, 2], [12, 3], [20, 1]],
  snapshot: {},
});
const state = (changes = []) => {
  const eff = applyPlan(base, changes);
  return { eff, rules: classificationRules(eff) };
};

test('a crate source lists its songs; done means sorted into a crate that is not unsorted', () => {
  const { eff, rules } = state();
  const src = { kind: 'crate', id: 11 };
  const songs = S.sourceSongs(base, eff, src);
  assert.deepEqual(songs.map((t) => t.id).sort(), [1, 2]);
  assert.deepEqual(songs.filter((t) => S.isDoneIn(eff, rules, src, t)).map((t) => t.id), [1]);
});

test('songs in no crate and recently added songs', () => {
  const { eff } = state();
  assert.deepEqual(S.sourceSongs(base, eff, { kind: 'uncategorized' }).map((t) => t.id), [4]);
  const now = (250 + 86400) * 1000; // one day back is 250 s: only s1 (added at 300) is recent
  assert.deepEqual(S.sourceSongs(base, eff, { kind: 'recent', days: 1 }, now).map((t) => t.id), [1]);
});

test('a song removed in the plan is no longer listed', () => {
  const { eff } = state([{ id: 'a', ops: [{ type: 'removeTrack', asset: 2, reason: '' }] }]);
  assert.deepEqual(S.sourceSongs(base, eff, { kind: 'crate', id: 11 }).map((t) => t.id), [1]);
});

test('sort orders', () => {
  const { eff } = state();
  const all = S.sourceSongs(base, eff, { kind: 'uncategorized' }).concat(S.sourceSongs(base, eff, { kind: 'crate', id: 11 }), S.sourceSongs(base, eff, { kind: 'crate', id: 12 }));
  assert.deepEqual(S.sortSongs(all, 'added').map((t) => t.title), ['s1', 's2', 's3', 's4']);
  assert.deepEqual(S.sortSongs(all, 'artist').map((t) => t.title), ['s3', 's2', 's1', 's4']);
  assert.equal(S.sortSongs(all, 'order'), all);
});

test('the unsorted crate tree counts songs left and finds the next crate', () => {
  const { eff, rules } = state();
  const rank = { ids: new Map(), next: 0 };
  const tree = S.orderCrateTree(S.unsortedCrateTree(base, eff, rules, 11), eff, rank);
  assert.equal(tree.length, 1); // Inbox
  const [inbox] = tree;
  assert.deepEqual(inbox.children.map((n) => [n.id, n.total, n.left]), [[11, 2, 1], [12, 1, 1]]);
  assert.deepEqual([...inbox.leftIds].sort(), [2, 3]);
  assert.equal(S.nextCrate(tree).id, 12);
  // Positions stay as first seen, so the list does not jump around while sorting.
  const again = S.orderCrateTree(S.unsortedCrateTree(base, eff, rules, 12), eff, rank);
  assert.deepEqual(again[0].children.map((n) => n.id), [11, 12]);
});

test('songs already sorted but still in an unsorted crate', () => {
  const { eff, rules } = state();
  assert.deepEqual(S.staleSongs(eff, rules, 11), [1]);
  assert.deepEqual(S.staleSongs(eff, rules, 20), []); // House is not unsorted
});

test('folder children, files and search', () => {
  const file = (name) => ({ name, path: `/m/${name}` });
  const node = (name, extra = {}) => ({ key: name, name, children: [], files: [], done: false, todo: 0, total: { missing: 0 }, ...extra });
  const b = node('b', { files: [file('b1.wav')], done: true });
  const a = node('a10', { files: [file('a.wav')], todo: 3 });
  const a2 = node('a2', { todo: 5 });
  const root = node('root', { children: [b, a, a2], files: [file('root.wav')] });
  assert.deepEqual(folderChildren(root).map((n) => n.name), ['a2', 'a10', 'b']);
  assert.deepEqual(folderChildren(root, { sortBy: 'todo', hideDone: true }).map((n) => n.name), ['a2', 'a10']);
  assert.deepEqual(folderChildren(root, { hideDone: true, keepKey: 'b' }).map((n) => n.name), ['a2', 'a10', 'b']);
  assert.deepEqual(folderFiles(root, false).map((f) => f.name), ['root.wav']);
  assert.deepEqual(folderFiles(root, true).map((f) => f.name), ['root.wav', 'a.wav', 'b1.wav']);
  assert.ok(fileMatches(file('Night Shift.wav'), { title: 'Night Shift', artist: 'Maren Vos' }, 'maren night'));
  assert.ok(!fileMatches(file('x.wav'), null, 'maren'));
});
