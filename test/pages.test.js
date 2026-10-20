import test from 'node:test';
import assert from 'node:assert/strict';
import { urlDate, htmlDate, nameIn, explainDomain } from '../src/pages.js';
import { pageMetrics, pageUnitsFor } from '../src/ahrefs.js';

test('dates written into URLs', () => {
  assert.equal(urlDate('https://x.com/2024/03/15/jane-doe-story/'), '2024-03-15');
  assert.equal(urlDate('https://x.com/news/2023/7/some-story'), '2023-07-01');
  assert.equal(urlDate('https://x.com/blog/2022-11-02-jane-doe'), '2022-11-02');
  assert.equal(urlDate('https://x.com/people/jane-doe'), null);
  assert.equal(urlDate('https://x.com/product/2099/01/'), null); // the future is not a publish date
  assert.equal(urlDate('https://x.com/id/123456/2024'), null); // a year alone is not enough
});

test('dates a page states about itself, structured data first', () => {
  assert.deepEqual(htmlDate('<script type="application/ld+json">{"datePublished":"2021-05-04T10:00:00Z"}</script><meta property="article:published_time" content="2020-01-01">'), { date: '2021-05-04', source: 'jsonld' });
  assert.deepEqual(htmlDate('<meta content="2020-02-03T08:00:00-05:00" property="article:published_time">'), { date: '2020-02-03', source: 'meta' });
  assert.deepEqual(htmlDate('<p>Posted <time datetime="2019-12-31">yesterday</time></p>'), { date: '2019-12-31', source: 'time' });
  assert.equal(htmlDate('<meta name="description" content="2020-01-01 was a year">'), null);
  assert.equal(htmlDate(''), null);
});

test('name in title and in URL slug', () => {
  assert.deepEqual(nameIn('Jane Doe', { title: 'Jane Doe - CEO at Acme', url: 'https://linkedin.com/in/janedoe' }), { title: true, slug: true });
  assert.deepEqual(nameIn('Jane Doe', { title: 'Acme names new CEO', url: 'https://x.com/2024/01/02/acme-ceo' }), { title: false, slug: false });
  assert.deepEqual(nameIn('José Núñez', { title: 'Jose Nunez profile', url: 'https://x.com/people/jose-nunez' }), { title: true, slug: true });
  assert.equal(nameIn('Jane Doe', { title: 'Jane Smith and John Doe', url: '' }).title, true); // token match, not phrase: noted limitation
});

test('the explanation sentence rests on what is known', () => {
  const row = (url, title, target, serpAt = '2026-10-01T00:00:00Z') => ({ keyword: 'jane doe', people: ['Jane Doe'], serpAt, them: { url, title }, target: { url: target } });
  const wins = [
    row('https://d.com/a', 'Jane Doe profile', 'https://t.com/1'),
    row('https://d.com/b', 'Jane Doe interview', 'https://t.com/2'),
    row('https://d.com/jane-doe', 'Acme news', 'https://t.com/3'),
    row('https://d.com/d', 'Jane Doe', 'https://t.com/4'),
  ];
  const metrics = new Map([
    ['https://d.com/a', { refdomains: 0, published_at: '2025-10-01' }],
    ['https://d.com/b', { refdomains: 0, published_at: '2024-10-01' }],
    ['https://d.com/jane-doe', { refdomains: 4 }],
    // d.com/d: nothing known
    ['https://t.com/1', { refdomains: 10 }],
    ['https://t.com/2', { refdomains: 20 }],
  ]);
  const e = explainDomain(wins, metrics);
  assert.equal(e.linksKnown, 3);
  assert.ok(Math.abs(e.noLinkShare - 2 / 3) < 1e-9);
  assert.equal(e.agesKnown, 2);
  assert.ok(Math.abs(e.medianAgeMonths - 18) < 0.5); // 12 and 24 months
  assert.equal(e.nameInTitleShare, 0.75);
  assert.equal(e.nameInSlugShare, 0.25);
  assert.equal(e.medianRefdomains, 0);
  assert.equal(e.targetMedianRefdomains, 15);
  assert.equal(
    e.sentence,
    'Wins 67% of the time with pages that have no external links, median page age 18 months, name in the title 75% of the time, in the URL 25%. Its winning pages have a median of 0 referring domains; the target pages they beat have 15. (links known for 3 of 4 wins; age known for 2.)',
  );
  assert.equal(explainDomain([], metrics).sentence, 'No wins to explain.');
});

test('Ahrefs batch-analysis: 100 URLs per request, results mapped by index', async () => {
  process.env.AHREFS_API_KEY = 'test';
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url: String(url), n: body.targets.length, mode: body.targets[0].mode });
    // As the live API answers: the URL without its scheme, and `index` only
    // when it was selected. The first batch omits it to exercise the fallback.
    const withIndex = calls.length > 1 && body.select.includes('index');
    return { ok: true, json: async () => ({ targets: body.targets.map((t, index) => ({ ...(withIndex ? { index } : {}), url: t.url.replace(/^https:\/\//, ''), url_rating: index, refdomains: index % 2 ? 0 : 3 })).reverse() }) };
  };
  try {
    const urls = Array.from({ length: 150 }, (_, i) => `https://x.com/p${i}`);
    const got = await pageMetrics(urls);
    assert.deepEqual(calls.map((c) => c.n), [100, 50]);
    assert.ok(calls.every((c) => c.url.endsWith('/v3/batch-analysis/batch-analysis') && c.mode === 'exact'));
    assert.deepEqual(got.get('https://x.com/p101'), { urlRating: 1, refdomains: 0 }); // by index
    assert.deepEqual(got.get('https://x.com/p2'), { urlRating: 2, refdomains: 3 }); // by URL echo
    assert.equal(got.size, 150);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(pageUnitsFor(0), 0);
  assert.equal(pageUnitsFor(75), 600); // measured
  assert.equal(pageUnitsFor(2), 50); // measured: the per-request minimum
  assert.equal(pageUnitsFor(150), 800 + 400);
});
