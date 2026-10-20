import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { mergeHosts } = await import('../src/score.js');
const db = await import('../src/db.js');
const { planHosts, annotateSerp } = await import('../src/client.js');

const row = (domain, wins, n, extra = {}) => ({ domain, wins, appearances: wins + 1, reach: wins / n, access: null, types: { article: wins }, ...extra });

test('merged score is the reach against the hardest host, with a column per host', () => {
  const hosts = [
    { domain: 'therealdeal.com', studyId: 1, contests: 100, domains: [row('forbes.com', 60, 100), row('linkedin.com', 30, 100)] },
    { domain: 'nypost.com', studyId: 2, contests: 50, domains: [row('forbes.com', 10, 50), row('linkedin.com', 25, 50)] },
  ];
  const { domains, hosts: cols } = mergeHosts(hosts);
  const by = Object.fromEntries(domains.map((d) => [d.domain, d]));
  assert.equal(by['forbes.com'].merged, 0.2); // 60% vs TRD, 20% vs NY Post
  assert.equal(by['forbes.com'].hardestHost, 'nypost.com');
  assert.equal(by['linkedin.com'].merged, 0.3);
  assert.deepEqual(domains.map((d) => d.domain), ['linkedin.com', 'forbes.com']);
  assert.deepEqual(Object.keys(by['forbes.com'].perHost), ['therealdeal.com', 'nypost.com']);
  assert.ok(cols.every((c) => c.counted));
});

test('a candidate that never met a host scores 0 there', () => {
  const hosts = [
    { domain: 'a.com', studyId: 1, contests: 20, domains: [row('x.com', 10, 20)] },
    { domain: 'b.com', studyId: 2, contests: 20, domains: [] },
  ];
  const [x] = mergeHosts(hosts).domains;
  assert.equal(x.merged, 0);
  assert.equal(x.perHost['b.com'].reach, 0);
});

test('hosts under the contest threshold get a column but do not count', () => {
  const hosts = [
    { domain: 'big.com', studyId: 1, contests: 40, domains: [row('x.com', 20, 40)] },
    { domain: 'thin.com', studyId: 2, contests: 3, domains: [] },
  ];
  const { domains, hosts: cols } = mergeHosts(hosts, { minContests: 10 });
  assert.equal(domains[0].merged, 0.5);
  assert.deepEqual(cols.map((c) => [c.domain, c.counted]), [['big.com', true], ['thin.com', false]]);
  // With no host over the threshold, all hosts with any contests count.
  const allThin = mergeHosts([{ ...hosts[0], contests: 4 }, hosts[1]], { minContests: 10 });
  assert.deepEqual(allThin.hosts.map((c) => c.counted), [true, true]);
});

test('candidates in the client name SERP sort first at equal score; hosts are never candidates', () => {
  const hosts = [
    { domain: 'neg.com', studyId: 1, contests: 10, domains: [row('new.com', 5, 10), row('owned.com', 5, 10), row('news.neg.com', 9, 10)] },
  ];
  const nameSerp = [
    { position: 2, url: 'https://neg.com/story', domain: 'neg.com' },
    { position: 6, url: 'https://www.owned.com/about', domain: 'owned.com' },
  ];
  const { domains } = mergeHosts(hosts, { nameSerp });
  assert.deepEqual(domains.map((d) => d.domain), ['owned.com', 'new.com']);
  assert.equal(domains[0].inNameSerp, 6);
  assert.equal(domains[1].inNameSerp, null);
});

test('planHosts groups URLs by host, reuses finished studies, honours rerun', () => {
  const d = db.openDb();
  const study = (target, fetched) => {
    const { lastInsertRowid: sid } = d.prepare("INSERT INTO studies (target, country, params, created_at) VALUES (?, 'us', '{}', 'x')").run(target);
    d.prepare('INSERT INTO keywords (study_id, keyword, people, orgs, serp_at) VALUES (?, ?, ?, ?, ?)').run(sid, 'k', '[]', '[]', fetched ? 'x' : null);
    return Number(sid);
  };
  const done = study('therealdeal.com', true);
  study('nypost.com', false); // unfinished: not reusable
  const cid = db.createClient({ name: 'Jane Doe', country: 'us' });
  db.setTargets(cid, [
    { url: 'https://therealdeal.com/a', position: 3 },
    { url: 'https://www.therealdeal.com/b', position: 7 },
    { url: 'https://nypost.com/c' },
  ]);
  const plan = planHosts(cid);
  assert.deepEqual(plan.map((h) => [h.domain, h.action, h.urls.length]), [['therealdeal.com', 'reuse', 2], ['nypost.com', 'new', 1]]);
  assert.equal(plan[0].studyId, done);
  assert.equal(planHosts(cid, { rerun: ['therealdeal.com'] })[0].action, 'new');
  // Once linked, the study is kept.
  db.linkTargetStudy(cid, 'therealdeal.com', done);
  assert.equal(planHosts(cid)[0].action, 'linked');
});

test('setTargets keeps a study link unless the host changes, and rejects non-URLs', () => {
  const cid = db.createClient({ name: 'John Roe', country: 'us' });
  db.setTargets(cid, [{ url: 'https://events.example.com/x', position: 4 }]);
  assert.equal(db.listTargets(cid)[0].domain, 'events.example.com');
  db.linkTargetStudy(cid, 'events.example.com', 1);
  db.setTargets(cid, [{ url: 'https://events.example.com/x', position: 4 }]);
  assert.equal(db.listTargets(cid)[0].study_id, 1);
  db.setTargets(cid, [{ url: 'https://events.example.com/x', domain: 'example.com', position: 4 }]);
  assert.deepEqual([db.listTargets(cid)[0].domain, db.listTargets(cid)[0].study_id], ['example.com', null]);
  assert.throws(() => db.setTargets(cid, [{ url: 'javascript:alert(1)' }]), /Not a URL/);
});

test('name SERP rows are flagged with negativeTitle', () => {
  const [a, b] = annotateSerp([
    { position: 1, url: 'https://x.com/p/jane-doe-sued-by-investors', domain: 'x.com', title: 'Jane Doe sued by investors' },
    { position: 2, url: 'https://linkedin.com/in/janedoe', domain: 'linkedin.com', title: 'Jane Doe - CEO' },
  ]);
  assert.equal(a.negative, 'sued');
  assert.equal(b.negative, null);
  assert.equal(b.type, 'profile');
});
