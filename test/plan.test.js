import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const db = await import('../src/db.js');
const { clientReport, estimateClientExplain } = await import('../src/plan.js');

/** A finished study of neg.com where a.com and b.com beat it, c.com does not. */
function seedStudy() {
  const d = db.openDb();
  const { lastInsertRowid } = d.prepare("INSERT INTO studies (target, country, params, created_at) VALUES ('neg.com', 'us', '{\"depth\":30}', 'x')").run();
  const sid = Number(lastInsertRowid);
  for (let i = 0; i < 12; i++) {
    const { lastInsertRowid: kid } = d.prepare('INSERT INTO keywords (study_id, keyword, people, orgs, volume, serp_at) VALUES (?, ?, ?, ?, ?, ?)').run(sid, `person ${i}`, '[]', '[]', 100, '2026-10-01T00:00:00Z');
    const add = d.prepare('INSERT INTO results (keyword_id, position, url, domain, title) VALUES (?, ?, ?, ?, ?)');
    add.run(kid, 5, `https://neg.com/2025/01/02/person-${i}-sued-story/`, 'neg.com', `Person ${i} sued`);
    add.run(kid, 1, `https://a.com/people/person-${i}`, 'a.com', `Person ${i}`);
    if (i % 2) add.run(kid, 2, `https://b.com/features/person-${i}-interview-feature/`, 'b.com', `Person ${i} interview`);
    add.run(kid, 9, `https://c.com/p${i}`, 'c.com', '');
  }
  return sid;
}

test('the plan: name SERP with problems marked, then strengthen vs new placements', () => {
  const sid = seedStudy();
  const cid = db.createClient({ name: 'Jane Doe', country: 'us' });
  db.saveClientSerp(cid, [
    { position: 1, url: 'https://www.a.com/people/jane-doe', domain: 'a.com', title: 'Jane Doe' },
    { position: 2, url: 'https://neg.com/2026/02/03/jane-doe-sued/', domain: 'neg.com', title: 'Jane Doe sued by investors' },
    { position: 3, url: 'https://x.com/jane', domain: 'x.com', title: 'Jane on X' },
  ], 0.005);
  db.setTargets(cid, [
    { url: 'https://neg.com/2026/02/03/jane-doe-sued/', position: 2 },
    { url: 'https://neg.com/older-piece', position: 41 }, // flagged by hand, outside the SERP shown
  ]);
  db.linkTargetStudy(cid, 'neg.com', sid);
  db.saveClientPick(cid, 'b.com', 'pitch a profile');
  db.saveClientPick(cid, 'a.com', '');
  db.saveClientPick(cid, 'zzz.com', ''); // never met the host

  const r = clientReport(cid, db.loadStudyData);
  assert.deepEqual(r.serp.map((x) => [x.position, x.problem, x.shortlisted]), [[1, false, true], [2, true, false], [3, false, false]]);
  assert.deepEqual(r.offSerp.map((t) => t.url), ['https://neg.com/older-piece']);
  assert.deepEqual(r.hosts.map((h) => [h.domain, h.studyId, h.decay]), [['neg.com', sid, null]]);
  // a.com is already at #1 for the name: a property to strengthen.
  assert.deepEqual(r.strengthen.map((s) => [s.domain, s.inNameSerp]), [['a.com', 1]]);
  // New placements, best merged reach first; a domain never seen sorts last.
  assert.deepEqual(r.newPlacements.map((s) => [s.domain, s.found]), [['b.com', true], ['zzz.com', false]]);
  const b = r.newPlacements[0];
  assert.equal(b.note, 'pitch a profile');
  assert.ok(b.merged > 0 && b.merged < r.strengthen[0].merged);
  assert.deepEqual(b.sections.map(([s]) => s), ['/features/']);
  // Explain sentences exist per host (name-only until links are fetched).
  assert.match(b.why['neg.com'], /name in the title/i);

  // Everything useful is starred, so nothing is suggested (c.com never wins).
  assert.deepEqual([r.suggestions.strengthen, r.suggestions.newPlacements], [[], []]);
  // Unstar both: a.com comes back as a site to strengthen, b.com as a new placement.
  db.removeClientPick(cid, 'a.com');
  db.removeClientPick(cid, 'b.com');
  const s = clientReport(cid, db.loadStudyData).suggestions;
  assert.deepEqual(s.strengthen.map((x) => [x.domain, x.inNameSerp]), [['a.com', 1]]);
  assert.deepEqual(s.newPlacements.map((x) => x.domain), ['b.com']);
  db.saveClientPick(cid, 'a.com', '');
  db.saveClientPick(cid, 'b.com', 'pitch a profile');

  const e = estimateClientExplain(cid, db.loadStudyData);
  assert.equal(e.domains, 3);
  assert.equal(e.hosts, 1);
  assert.ok(e.ahrefsUnits > 0);
});
