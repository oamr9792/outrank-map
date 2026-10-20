import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDecay, targetPosition, sampleKeywords } from '../src/decay.js';
import { historicalSerps } from '../src/dataforseo.js';

const snap = (date, position, resultsCount = 100) => ({ date, position, resultsCount });

test('monthly median, missing counted just below the last result', () => {
  const history = new Map([
    ['a', [snap('2026-04-10', 3), snap('2026-10-05', 9)]],
    ['b', [snap('2026-04-12', 5), snap('2026-10-02', null, 50)]], // dropped out: counts as 51
    ['c', [snap('2026-04-03', 2), snap('2026-04-28', 4), snap('2026-10-09', 4)]], // latest in April wins: 4
  ]);
  const d = summarizeDecay(history);
  assert.deepEqual(d.series.map((s) => [s.month, s.median, s.keywords, s.missing]), [['2026-04', 4, 3, 0], ['2026-10', 9, 3, 1]]);
  // Each keyword against its own snapshot ~6 months earlier: +6, +46, 0.
  assert.equal(d.change6, 6);
  assert.equal(d.change6Keywords, 3);
  assert.ok(Math.abs(d.spanMonths - 5.8) < 0.3);
});

test('irregular snapshots: each keyword is compared with its own ~6-month-old snapshot', () => {
  const history = new Map([
    // latest Sept; 4, 6 and 8 months back available: the 6-month one is used
    ['a', [snap('2026-01-05', 30), snap('2026-03-05', 20), snap('2026-05-05', 25), snap('2026-09-05', 10)]],
    // latest Aug; nearest earlier snapshot is 7 months back: used
    ['b', [snap('2026-01-20', 8), snap('2026-08-20', 12)]],
    // only 2 months of history: no comparison
    ['c', [snap('2026-07-01', 5), snap('2026-09-01', 5)]],
  ]);
  const d = summarizeDecay(history);
  assert.equal(d.change6Keywords, 2);
  assert.equal(d.change6, (10 - 20 + (12 - 8)) / 2); // median of -10 and +4
});

test('months with too few keywords are marked thin', () => {
  const kws = Array.from({ length: 28 }, (_, i) => [`k${i}`, [snap('2026-03-01', 10 + i), ...(i < 4 ? [snap('2026-09-01', 2)] : [])]]);
  const d = summarizeDecay(new Map(kws));
  assert.equal(d.minKeywordsPerMonth, 7); // max(5, 25% of 28)
  assert.deepEqual(d.series.map((s) => [s.month, s.keywords, s.thin]), [['2026-03', 28, false], ['2026-09', 4, true]]);
});

test('no comparison possible gives a null change; empty history is empty', () => {
  const d = summarizeDecay(new Map([['a', [snap('2026-08-01', 3), snap('2026-10-01', 2)]]]));
  assert.equal(d.change6, null);
  assert.equal(d.change6Keywords, 0);
  assert.deepEqual(summarizeDecay(new Map()).series, []);
});

test('target position counts subdomains and takes the best', () => {
  const r = (position, domain) => ({ position, domain });
  assert.equal(targetPosition([r(4, 'x.com'), r(7, 'events.t.com'), r(9, 't.com')], 't.com'), 7);
  assert.equal(targetPosition([r(1, 'x.com')], 't.com'), null);
});

test('the sample is contests in scope, highest volume first', () => {
  const kw = (keyword, volume, type) => ({
    id: keyword, keyword, people: [], orgs: [], volume,
    results: [{ position: 3, url: type === 'article' ? `https://t.com/2025/01/02/${keyword}-long-story-slug/` : `https://t.com/people/${keyword}`, domain: 't.com', title: keyword }],
  });
  const data = [kw('a', 10, 'article'), kw('b', 500, 'profile'), kw('c', 300, 'article'), kw('d', 900, 'article')];
  assert.deepEqual(sampleKeywords(data, 't.com', {}, 3).map((k) => k.keyword), ['d', 'b', 'c']);
  assert.deepEqual(sampleKeywords(data, 't.com', { pageType: 'article' }, 30).map((k) => k.keyword), ['d', 'c', 'a']);
});

test('historical SERP response: snapshots by date, organic only', async () => {
  process.env.DATAFORSEO_LOGIN = 'x';
  process.env.DATAFORSEO_PASSWORD = 'y';
  const real = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, opts) => {
    sent = { url: String(url), body: JSON.parse(opts.body)[0] };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status_code: 20000,
        cost: 0.0024,
        tasks: [{
          status_code: 20000,
          result: [{
            items: [
              { datetime: '2026-09-14 06:12:00 +00:00', items: [
                { type: 'paid', url: 'https://ad.com/' },
                { type: 'organic', rank_group: 1, url: 'https://www.linkedin.com/in/x', domain: 'www.linkedin.com' },
                { type: 'organic', rank_group: 2, url: 'https://t.com/story', domain: 't.com' },
              ] },
              { datetime: 'bad date', items: [] },
            ],
          }],
        }],
      }),
    };
  };
  try {
    const { cost, snapshots } = await historicalSerps('jane doe', { locationCode: 2840 });
    assert.ok(sent.url.endsWith('/dataforseo_labs/google/historical_serps/live'));
    assert.deepEqual(sent.body, { keyword: 'jane doe', location_code: 2840, language_code: 'en' });
    assert.equal(cost, 0.0024);
    assert.deepEqual(snapshots, [{ date: '2026-09-14', results: [{ position: 1, url: 'https://www.linkedin.com/in/x', domain: 'linkedin.com' }, { position: 2, url: 'https://t.com/story', domain: 't.com' }] }]);
  } finally {
    globalThis.fetch = real;
  }
});
