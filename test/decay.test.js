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
  assert.equal(d.latest, '2026-10');
  assert.equal(d.baseMonth, '2026-04');
  // deltas: +6, +46, 0 -> median +6 (moving down)
  assert.equal(d.change6, 6);
  assert.equal(d.change6Keywords, 3);
});

test('six-month change needs both months; empty history is null', () => {
  const d = summarizeDecay(new Map([['a', [snap('2026-08-01', 3), snap('2026-10-01', 2)]]]));
  assert.equal(d.change6, null);
  assert.equal(d.change6Keywords, 0);
  assert.equal(summarizeDecay(new Map()).latest, null);
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
