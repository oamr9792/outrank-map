import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const db = await import('../src/db.js');
const { normUrl, positionOf, outcome, checkRows, clientPlacements, calibration, addClientPlacement } = await import('../src/placements.js');

test('URLs match without scheme, www, query or trailing slash', () => {
  assert.equal(normUrl('https://www.Forbes.com/sites/x/jane/?utm=1#top'), 'forbes.com/sites/x/jane');
  const results = [{ position: 3, url: 'http://forbes.com/sites/x/jane' }, { position: 9, url: 'https://www.forbes.com/sites/x/jane/' }];
  assert.equal(positionOf('https://www.forbes.com/sites/x/jane', results), 3);
  assert.equal(positionOf('https://other.com/', results), null);
});

test('outcome against the negative URLs at the same check', () => {
  assert.deepEqual(outcome(2, [5, 9]), { outcome: 'beats-all', beaten: 2, of: 2 });
  assert.deepEqual(outcome(6, [5, 9]), { outcome: 'beats-some', beaten: 1, of: 2 });
  assert.deepEqual(outcome(12, [5, 9]), { outcome: 'below-all', beaten: 0, of: 2 });
  // A negative URL that dropped out of the results sits below a ranking placement.
  assert.deepEqual(outcome(12, [5, null]), { outcome: 'beats-some', beaten: 1, of: 2 });
  assert.deepEqual(outcome(null, [5]), { outcome: 'not-ranking', beaten: 0, of: 1 });
});

test('a check logs every placement and every negative URL', () => {
  const rows = checkRows([{ id: 7, url: 'https://a.com/p' }], [{ url: 'https://neg.com/x' }], [{ position: 4, url: 'https://neg.com/x' }, { position: 2, url: 'https://a.com/p/' }]);
  assert.deepEqual(rows, [
    { kind: 'placement', url: 'https://a.com/p', placementId: 7, position: 2 },
    { kind: 'negative', url: 'https://neg.com/x', position: 4 },
  ]);
});

test('placements keep their history, and checked ones feed calibration', () => {
  const cid = db.createClient({ name: 'Jane Doe', country: 'us' });
  db.setTargets(cid, [{ url: 'https://neg.com/x', position: 3 }]);
  addClientPlacement(cid, { url: 'https://www.a.com/jane-doe', publishedAt: '2026-06-01' }, 0.42);
  addClientPlacement(cid, { url: 'https://b.com/jane', publishedAt: 'not a date' }, null);
  const [pa, pb] = db.listPlacements(cid);
  assert.deepEqual([pa.domain, pa.keyword, pa.published_at, pa.predicted_reach], ['a.com', 'Jane Doe', '2026-06-01', 0.42]);
  assert.equal(pb.published_at, null);

  // Two checks: a.com climbs above the negative URL; b.com never ranks.
  db.saveCheck(cid, 'Jane Doe', [{ kind: 'placement', url: pa.url, placementId: pa.id, position: 8 }, { kind: 'placement', url: pb.url, placementId: pb.id, position: null }, { kind: 'negative', url: 'https://neg.com/x', position: 3 }], 0.005);
  db.saveCheck(cid, 'Jane Doe', [{ kind: 'placement', url: pa.url, placementId: pa.id, position: 2 }, { kind: 'placement', url: pb.url, placementId: pb.id, position: null }, { kind: 'negative', url: 'https://neg.com/x', position: 4 }], 0.005);

  const { placements, checks } = clientPlacements(cid);
  const a = placements.find((p) => p.domain === 'a.com');
  assert.deepEqual(a.history.map((h) => [h.position, h.outcome]), [[8, 'below-all'], [2, 'beats-all']]);
  assert.equal(a.latest.outcome, 'beats-all');
  assert.equal(checks.length, 2);

  const cal = calibration();
  assert.deepEqual(cal.map((r) => [r.domain, r.predictedReach, r.outcome, r.checks]), [['a.com', 0.42, 'beats-all', 2], ['b.com', null, 'not-ranking', 2]]);
  assert.ok(cal[0].daysLive > 100);
  assert.throws(() => addClientPlacement(cid, { url: 'ftp://x' }, null), /Not a URL/);
});
