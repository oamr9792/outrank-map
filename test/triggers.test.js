import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { nameSets, liftTable, timingTable, readAggregatorPage, citationTable, recommend, cleanTriggerInput, estimateTrigger } = await import('../src/triggers.js');

const person = (keyword, domains) => ({ keyword, people: [keyword], orgs: [], volume: 10, results: domains.map((d, i) => ({ position: i + 1, url: `https://${d}/${keyword.replace(' ', '-')}`, domain: d, title: '' })) });

// 40 people. Everyone on crunchbase.com has ZoomInfo (10 of 10); of the 30
// not on it, 3 do. facebook.com is everywhere and says nothing.
const people = [
  ...Array.from({ length: 10 }, (_, i) => person(`cb ${i}`, ['linkedin.com', 'crunchbase.com', 'www.zoominfo.com', 'facebook.com'])),
  ...Array.from({ length: 3 }, (_, i) => person(`zi ${i}`, ['linkedin.com', 'zoominfo.com', 'facebook.com'])),
  ...Array.from({ length: 27 }, (_, i) => person(`plain ${i}`, ['linkedin.com', 'facebook.com', i < 6 ? 'crunchbase.org' : 'x.com'])),
];

test('lift: sites that make the aggregator likelier', () => {
  const names = nameSets(people);
  const t = liftTable(names, 'zoominfo.com');
  assert.equal(t.people, 40);
  assert.equal(t.withAggregator, 13); // subdomain www.zoominfo.com counts
  const cb = t.rows.find((r) => r.domain === 'crunchbase.com');
  assert.equal(cb.both, 10);
  assert.equal(cb.pWith, 1);
  assert.equal(cb.pWithout, 0.1); // 3 of 30
  assert.ok(cb.lift > 5);
  assert.equal(t.rows[0].domain, 'crunchbase.com');
  const fb = t.rows.find((r) => r.domain === 'facebook.com');
  assert.ok(fb.lift < 1.2);
  // Seen together fewer than 3 times: not a candidate.
  assert.equal(t.rows.find((r) => r.domain === 'x.com'), undefined);
});

test('nameSets counts each person once', () => {
  assert.equal(nameSets([person('Jane Doe', ['a.com']), person('jane doe', ['b.com'])]).length, 1);
});

test('timing: before, after, same, and already-both histories', () => {
  const snap = (date, ...domains) => ({ date, domains: new Map(domains.map((d, i) => [d, i + 1])) });
  const history = new Map([
    ['a', [snap('2026-01-01', 'crunchbase.com'), snap('2026-04-01', 'crunchbase.com', 'zoominfo.com')]], // before, 3 months
    ['b', [snap('2026-01-01', 'zoominfo.com'), snap('2026-05-01', 'zoominfo.com', 'crunchbase.com')]], // after
    ['c', [snap('2026-01-01', 'crunchbase.com', 'zoominfo.com')]], // already both: no order
    ['d', [snap('2026-01-01', 'x.com'), snap('2026-03-01', 'crunchbase.com', 'zoominfo.com')]], // same snapshot
    ['e', [snap('2026-01-01', 'crunchbase.com')]], // no aggregator: skipped
  ]);
  const t = timingTable(history, 'zoominfo.com', ['crunchbase.com'])['crunchbase.com'];
  assert.deepEqual([t.before, t.after, t.same, t.alreadyBoth], [1, 1, 1, 1]);
  assert.ok(Math.abs(t.medianLagMonths - 3) < 0.1);
});

test('reading an aggregator page: outbound sites and source phrases', () => {
  const html = `<a href="https://www.zoominfo.com/c/acme">Acme</a><a href="https://acme.com/team">Company website</a>
    <a href="https://www.prnewswire.com/news/acme-hires">news</a><script src="https://www.googletagmanager.com/gtm.js"></script>
    <a href="https://fonts.googleapis.com/css">f</a><p>Sources: SEC filings and press releases.</p>`;
  const p = readAggregatorPage(html, 'zoominfo.com');
  assert.deepEqual(p.linkDomains.sort(), ['acme.com', 'prnewswire.com']);
  assert.deepEqual(p.cues.sort(), ['company website', 'press release', 'regulatory filing', 'source line'].sort());
  const c = citationTable(new Map([['u1', p], ['u2', { linkDomains: ['acme.com'], cues: [] }], ['u3', { error: 'HTTP 403', linkDomains: [], cues: [] }]]));
  assert.deepEqual([c.read, c.failed, c.links.get('acme.com')], [2, 1, 2]);
});

test('recommendations: lift, timing and citation combine; weak sites are not picked', () => {
  const names = nameSets(people);
  const lift = liftTable(names, 'zoominfo.com');
  const timing = { 'crunchbase.com': { before: 4, after: 1, same: 0, alreadyBoth: 2, medianLagMonths: 2 } };
  const cites = { read: 10, failed: 0, links: new Map([['crunchbase.com', 3]]), cues: [] };
  const { picks, rows } = recommend(lift, timing, cites, 'zoominfo.com');
  assert.equal(picks[0].domain, 'crunchbase.com');
  assert.ok(!picks.some((p) => p.domain === 'facebook.com'));
  assert.match(rows[0].sentence, /showed up first in 4 of 5/);
  assert.match(rows[0].sentence, /linked to it 3 times/);
});

test('fellow aggregators are labelled, never picked; one readable page is not citation evidence', () => {
  const rows = [
    { domain: 'rocketreach.co', lift: 4, both: 12, names: 20, pWith: 0.6, pWithout: 0.1 },
    { domain: 'facebook.com', lift: 1.1, both: 30, names: 150, pWith: 0.2, pWithout: 0.18 },
    { domain: 'crunchbase.com', lift: 2.5, both: 8, names: 15, pWith: 0.5, pWithout: 0.2 },
  ];
  const lift = { people: 200, withAggregator: 40, rows };
  const onePage = { read: 1, failed: 39, links: new Map([['facebook.com', 1]]), cues: [] };
  const { picks, rows: out } = recommend(lift, {}, onePage, 'zoominfo.com');
  assert.deepEqual(picks.map((p) => p.domain), ['crunchbase.com']);
  assert.equal(out.find((r) => r.domain === 'rocketreach.co').fellow, true);
  assert.equal(out.find((r) => r.domain === 'facebook.com').citedShare, 0);
  assert.match(out.find((r) => r.domain === 'rocketreach.co').sentence, /another people-data aggregator/);
});

test('input checks and the estimate', () => {
  assert.throws(() => cleanTriggerInput({ aggregator: 'zoominfo.com', control: 'zoominfo.com' }), /must differ/);
  assert.deepEqual(cleanTriggerInput({ aggregator: 'https://www.ZoomInfo.com/p/x', limit: 5 }).params.limit, 20);
  const e = estimateTrigger({ aggregator: 'zoominfo.com', control: 'linkedin.com', limit: 150 });
  assert.equal(e.newStudies, 2);
  assert.equal(e.ahrefsUnits, 2 * 150 * 17);
  assert.ok(e.dataforseoUsd > 1 && e.dataforseoUsd < 3);
});

test('kinds of page: listed sites, own-name sites, company team pages, speaker bios, news', async () => {
  const { pageKind, kindLiftTable } = await import('../src/triggers.js');
  const k = (url, name = 'Jane Doe') => pageKind({ domain: new URL(url).hostname.replace(/^www\./, ''), url }, name);
  assert.equal(k('https://www.linkedin.com/in/janedoe'), 'linkedin');
  assert.equal(k('https://adviserinfo.sec.gov/individual/summary/123'), 'regulatory');
  assert.equal(k('https://www.prnewswire.com/news-releases/acme-names-jane-doe-cfo-301.html'), 'press');
  assert.equal(k('https://www.crunchbase.com/person/jane-doe'), 'business-profile');
  assert.equal(k('https://rocketreach.co/jane-doe-email_1'), 'fellow');
  assert.equal(k('https://janedoe.com/'), 'personal-site');
  assert.equal(k('https://www.jane-doe.net/about'), 'personal-site');
  assert.equal(k('https://acmecapital.com/team/jane-doe'), 'company-page');
  assert.equal(k('https://acme.com/about-us'), 'company-page');
  assert.equal(k('https://summit.example.org/speakers/jane-doe'), 'speaker');
  assert.equal(k('https://localpaper.com/2025/03/04/jane-doe-opens-office/'), 'news');
  assert.equal(k('https://example.com/'), null);

  // 20 people: all 8 with a company team page have ZoomInfo; 2 of 12 others do.
  const p = (keyword, urls) => ({ keyword, people: [keyword], orgs: [], volume: 1, results: urls.map((u, i) => ({ position: i + 1, url: u, domain: new URL(u).hostname.replace(/^www\./, ''), title: '' })) });
  const people = [
    ...Array.from({ length: 8 }, (_, i) => p(`team ${i}`, [`https://firm${i}.com/team/person-${i}`, 'https://zoominfo.com/p/x'])),
    ...Array.from({ length: 2 }, (_, i) => p(`zi ${i}`, ['https://zoominfo.com/p/y'])),
    ...Array.from({ length: 10 }, (_, i) => p(`none ${i}`, ['https://facebook.com/x'])),
  ];
  const { nameSets } = await import('../src/triggers.js');
  const t = kindLiftTable(nameSets(people), 'zoominfo.com');
  const team = t.rows.find((r) => r.kind === 'company-page');
  assert.deepEqual([team.names, team.both, team.pWith], [8, 8, 1]);
  assert.ok(team.lift > 4);
  assert.match(team.sentence, /team or bio page on a company website/);
});

test('fresh runs ignore finished studies; timing size scales the estimate', async () => {
  const db = await import('../src/db.js');
  const d = db.openDb();
  const { lastInsertRowid } = d.prepare("INSERT INTO studies (target, country, params, created_at) VALUES ('rocketreach.co', 'us', '{}', 'x')").run();
  d.prepare("INSERT INTO keywords (study_id, keyword, people, orgs, serp_at) VALUES (?, 'k', '[]', '[]', 'x')").run(lastInsertRowid);
  const reuse = estimateTrigger({ aggregator: 'rocketreach.co', limit: 100 });
  assert.equal(reuse.newStudies, 1); // rocketreach reused, linkedin new
  const fresh = estimateTrigger({ aggregator: 'rocketreach.co', limit: 100, fresh: true, timingNames: 150 });
  assert.equal(fresh.newStudies, 2);
  assert.ok(fresh.historyUsd > reuse.historyUsd);
});
