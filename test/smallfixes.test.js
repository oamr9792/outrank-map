import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = ':memory:';
const db = await import('../src/db.js');
const dfs = await import('../src/dataforseo.js');
const { pageType, accessTag } = await import('../src/classify.js');
const { scoreDomains } = await import('../src/score.js');
const { createStudy } = await import('../src/run.js');

test('locations: country entries only, cached file wins, any ISO code resolves', async () => {
  const parsed = dfs.parseLocations([
    { location_code: 2840, location_type: 'Country', country_iso_code: 'US' },
    { location_code: 21137, location_type: 'State', country_iso_code: 'US' },
    { location_code: 2484, location_type: 'Country', country_iso_code: 'MX' },
  ]);
  assert.deepEqual(parsed, { us: 2840, mx: 2484 });
  assert.equal(dfs.locationCode('mx'), null); // not in the built-in eight
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'om-')), 'locations.json');
  fs.writeFileSync(file, JSON.stringify(parsed));
  const r = await dfs.loadLocations(file);
  assert.equal(r.source, 'cache');
  assert.equal(dfs.locationCode('MX'), 2484);
  assert.equal(dfs.locationCode('gb'), 2826); // built-ins stay
});

test('pageType: court records and homepages', () => {
  assert.equal(pageType('https://www.courtlistener.com/docket/123/smith-v-jones/'), 'court');
  assert.equal(pageType('https://dockets.justia.com/docket/new-york/x'), 'court');
  assert.equal(pageType('https://www.law360.com/articles/1/jane-doe-sued-over-fund-collapse'), 'court');
  assert.equal(pageType('https://county.gov/case/2024-cv-0012'), 'court');
  assert.equal(pageType('https://www.acme.com/'), 'homepage');
  assert.equal(pageType('https://acme.com'), 'homepage');
  assert.equal(pageType('https://acme.com/about/team'), 'profile');
});

test('accessTag: court / public record, and news computed from winning pages', () => {
  assert.equal(accessTag('trellis.law'), 'court / public record');
  assert.equal(accessTag('www.unicourt.com'), 'court / public record');
  assert.equal(accessTag('nytimes.com', { article: 6, profile: 3 }), 'news');
  assert.equal(accessTag('nytimes.com', { article: 3, profile: 3 }), null); // not mostly articles
  assert.equal(accessTag('linkedin.com', { article: 9 }), 'self-publish'); // a listed tag wins
});

test('summary: median drift between Ahrefs and the live position', () => {
  const kw = (keyword, ahrefsPosition, live) => ({ keyword, people: [], orgs: [], volume: 0, ahrefsPosition, results: [{ position: live, url: `https://t.com/${keyword}`, domain: 't.com', title: '' }] });
  const { summary } = scoreDomains([kw('a', 3, 3), kw('b', 4, 9), kw('c', 10, 6), kw('d', null, 2)], 't.com');
  assert.equal(summary.medianDrift, 0); // drifts 0, +5, -4
  assert.equal(summary.driftKeywords, 3);
  assert.equal(summary.driftOver3, 2);
});

test('device: sent to DataForSEO, validated, and part of study reuse', async () => {
  process.env.DATAFORSEO_LOGIN = 'x';
  process.env.DATAFORSEO_PASSWORD = 'y';
  const real = globalThis.fetch;
  let body;
  globalThis.fetch = async (_u, opts) => {
    body = JSON.parse(opts.body)[0];
    return { ok: true, status: 200, json: async () => ({ status_code: 20000, cost: 0, tasks: [{ status_code: 20000, result: [{ items: [] }] }] }) };
  };
  try {
    await dfs.serp('jane doe', { device: 'mobile' });
    assert.equal(body.device, 'mobile');
    await dfs.serp('jane doe', { device: 'tablet' });
    assert.equal(body.device, 'desktop');
  } finally {
    globalThis.fetch = real;
  }
  await assert.rejects(createStudy({ target: 'x.com', device: 'tablet' }, () => {}), /Device must be one of/);

  const d = db.openDb();
  const study = (device) => {
    const { lastInsertRowid } = d.prepare("INSERT INTO studies (target, country, params, created_at) VALUES ('t.com', 'us', ?, 'x')").run(JSON.stringify(device ? { device } : {}));
    d.prepare('INSERT INTO keywords (study_id, keyword, people, orgs, serp_at) VALUES (?, ?, ?, ?, ?)').run(lastInsertRowid, 'k', '[]', '[]', 'x');
    return Number(lastInsertRowid);
  };
  const legacy = study(null); // before devices: desktop
  const mobile = study('mobile');
  assert.equal(db.findReusableStudy('t.com', 'us', 'desktop'), legacy);
  assert.equal(db.findReusableStudy('t.com', 'us', 'mobile'), mobile);
});
