// The shared plan cases (tests/cases/plan_cases.json) run through the page's model, which previews
// what Apply to Serato will write. tests/test_plan_cases.py runs the same cases through Apply.
import './setup.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const { applyPlan, buildBase } = await import('../../static/js/model.js');
const CASES = JSON.parse(readFileSync(new URL('../cases/plan_cases.json', import.meta.url), 'utf8'));
const ROOT = 0;

/** The setup as a Serato snapshot: crates 101…, songs 1… */
function setupLibrary() {
  const { crates, songs, members } = CASES.setup;
  const crateIds = new Map(crates.map((path, i) => [path, 101 + i]));
  const songIds = new Map(songs.map((s, i) => [s, i + 1]));
  const lib = {
    rootId: ROOT,
    tracks: songs.map((s) => ({ id: songIds.get(s), title: s, artist: '', fileName: `${s}.wav`, path: `/music/${s}.wav` })),
    crates: crates.map((path, i) => {
      const cut = path.lastIndexOf('/');
      return { id: crateIds.get(path), name: path.slice(cut + 1), parent: cut < 0 ? ROOT : crateIds.get(path.slice(0, cut)), order: i + 1 };
    }),
    memberships: Object.entries(members).flatMap(([c, list]) => list.map((s) => [crateIds.get(c), songIds.get(s)])),
    snapshot: {},
  };
  return { base: buildBase(lib), crateIds, songIds };
}

function translate(op, { crateIds, songIds }) {
  const crate = (ref) => (ref == null || String(ref).startsWith('new-') ? ref : ref === '' ? ROOT : crateIds.get(ref));
  const out = { ...op };
  for (const field of ['crate', 'parent', 'from', 'into', 'before']) if (field in out) out[field] = crate(out[field]);
  if ('asset' in out) out.asset = songIds.get(out.asset);
  return out;
}

/** { tree: path -> song names, order: path -> child names }, paths joined with "/". */
function result(eff, songIds) {
  const names = new Map([...songIds].map(([s, id]) => [id, s]));
  const path = (id) => {
    const parts = [];
    for (let c = eff.crates.get(id); c; c = eff.crates.get(c.parent)) parts.unshift(c.name);
    return parts.join('/');
  };
  const tree = {};
  for (const id of eff.crates.keys()) tree[path(id)] = (eff.members.get(id) || []).map((a) => names.get(a)).sort();
  const order = { '': (eff.children.get(ROOT) || []).map((id) => eff.crates.get(id).name) };
  for (const id of eff.crates.keys()) order[path(id)] = (eff.children.get(id) || []).map((c) => eff.crates.get(c).name);
  return { tree, order };
}

for (const c of CASES.cases) {
  test(c.name, () => {
    const lib = setupLibrary();
    const eff = applyPlan(lib.base, [{ id: 'case', ops: c.ops.map((op) => translate(op, lib)) }]);
    if (c.error) {
      assert.ok(eff.issues.length > 0, 'the plan should be refused');
      return;
    }
    assert.deepEqual(eff.issues.map((i) => i.message), []);
    const { tree, order } = result(eff, lib.songIds);
    if (c.tree) assert.deepEqual(tree, Object.fromEntries(Object.entries(c.tree).map(([k, v]) => [k, [...v].sort()])));
    for (const [level, children] of Object.entries(c.order || {})) assert.deepEqual(order[level], children, `order of ${level || 'the top level'}`);
  });
}
