import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, latestStudies } from '../src/allstudies.js';
import { scoreDomains } from '../src/score.js';

const kw = (keyword, target, others) => ({
  keyword, people: [keyword], orgs: [], volume: 100,
  results: [{ position: 5, url: `https://${target}/p/${keyword}`, domain: target, title: '' }, ...others.map(([d, pos]) => ({ position: pos, url: `https://${d}/${keyword}`, domain: d, title: '' }))],
});

// Two targets. x.com beats t1 twice of 2 and t2 once of 4; y.com meets only t1.
const t1 = [kw('a', 't1.com', [['x.com', 1], ['y.com', 9]]), kw('b', 't1.com', [['x.com', 2], ['y.com', 3]])];
const t2 = [kw('c', 't2.com', [['x.com', 1]]), kw('d', 't2.com', [['x.com', 8]]), kw('e', 't2.com', []), kw('f', 't2.com', [['t1.com', 2]])];
const scored = [
  { study: { id: 1, target: 't1.com', country: 'us' }, ...scoreDomains(t1, 't1.com') },
  { study: { id: 2, target: 't2.com', country: 'us' }, ...scoreDomains(t2, 't2.com') },
];

test('sums wins and contests over the studies a domain appeared in', () => {
  const by = Object.fromEntries(aggregate(scored).map((d) => [d.domain, d]));
  assert.deepEqual([by['x.com'].wins, by['x.com'].contests, by['x.com'].targetsMet, by['x.com'].targetsBeaten], [3, 6, 2, 2]);
  assert.equal(by['x.com'].reach, 0.5);
  assert.deepEqual([by['y.com'].wins, by['y.com'].contests, by['y.com'].targetsMet, by['y.com'].targetsBeaten], [1, 2, 1, 1]);
  // Per-target rows reconcile with each study's own table.
  assert.deepEqual(by['x.com'].targets.map((t) => [t.target, t.wins, t.contests]), [['t1.com', 2, 2], ['t2.com', 1, 4]]);
  // A studied target competing in another study is flagged.
  assert.equal(by['t1.com'].isTarget, true);
  assert.equal(by['t1.com'].targetsBeaten, 1);
});

test('weighted reach sums weights, not percentages', () => {
  const x = aggregate(scored).find((d) => d.domain === 'x.com');
  // No profile: every contest weighs 1, so weighted reach equals reach.
  assert.equal(x.weightedReach, x.reach);
});

test('filters and default order', () => {
  const all = aggregate(scored);
  assert.equal(all[0].domain, 'x.com'); // most targets beaten
  assert.deepEqual(aggregate(scored, { minTargets: 2 }).map((d) => d.domain), ['x.com']);
  assert.ok(aggregate(scored, { minAppearances: 3 }).every((d) => d.appearances >= 3));
});

test('only the newest finished study per target and country counts', () => {
  const s = (id, target, country, fetched = 10) => ({ id, target, country, fetched });
  const kept = latestStudies([s(1, 'a.com', 'us'), s(2, 'a.com', 'us'), s(3, 'a.com', 'gb'), s(4, 'b.com', 'us', 0), s(5, 'b.com', 'us')]);
  assert.deepEqual(kept.map((x) => x.id).sort(), [2, 3, 5]);
  assert.deepEqual(latestStudies([s(6, 'c.com', 'us', 0)]), []);
});
