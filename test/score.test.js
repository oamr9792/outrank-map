import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreDomains, domainDetail, contests } from '../src/score.js';
import { negativeTitle, pageType, accessTag } from '../src/classify.js';

const r = (position, url, title = '') => ({ position, url, domain: new URL(url).hostname.replace(/^www\./, ''), title });
const kw = (keyword, volume, results) => ({ keyword, people: [keyword], orgs: [], volume, results });

const data = [
  kw('ann smith', 1000, [
    r(1, 'https://www.linkedin.com/in/annsmith'),
    r(2, 'https://forbes.com/sites/x/2024/01/02/ann-smith-builds-towers/'),
    r(3, 'https://therealdeal.com/new-york/2025/03/01/ann-smith-sued-by-lenders/', 'Ann Smith sued by lenders'),
    r(4, 'https://nypost.com/2025/03/02/ann-smith/'),
  ]),
  kw('bob jones', 500, [
    r(1, 'https://events.therealdeal.com/ny-speakers/bob-jones', 'Bob Jones'),
    r(2, 'https://www.linkedin.com/in/bobjones'),
    r(3, 'https://linkedin.com/in/bobjones-2'),
  ]),
  // Target absent from the live SERP: not a contest.
  kw('cat lee', 300, [r(1, 'https://linkedin.com/in/catlee')]),
];

test('wins, reach and head-to-head', () => {
  const { summary, domains } = scoreDomains(data, 'therealdeal.com');
  assert.equal(summary.keywords, 3);
  assert.equal(summary.contests, 2);
  assert.equal(summary.targetAbsent, 1);
  const li = domains.find((d) => d.domain === 'linkedin.com');
  // Two linkedin URLs on "bob jones" count once, at the better position.
  assert.equal(li.appearances, 2);
  assert.equal(li.wins, 1);
  assert.equal(li.reach, 0.5);
  assert.equal(li.rawWinRate, 0.5);
  assert.equal(li.access, 'self-publish');
  const fb = domains.find((d) => d.domain === 'forbes.com');
  assert.deepEqual([fb.wins, fb.avgGap, fb.top3Wins, fb.volumeWon], [1, 1, 1, 1000]);
  assert.equal(domains.find((d) => d.domain === 'nypost.com').wins, 0);
  assert.equal(domains[0].domain, 'forbes.com'); // ties on wins broken by smoothed win rate (1/1 beats 1/2)
});

test('subdomains of the target count as the target', () => {
  const c = contests(data, 'therealdeal.com');
  assert.equal(c.find((k) => k.keyword === 'bob jones').target.position, 1);
});

test('negative scope keeps only contests where the target headline reads negative', () => {
  const { summary } = scoreDomains(data, 'therealdeal.com', { scope: 'negative' });
  assert.equal(summary.contests, 1);
});

test('drill-down lists wins first', () => {
  const rows = domainDetail(data, 'therealdeal.com', 'linkedin.com');
  assert.deepEqual(rows.map((x) => x.outcome), ['win', 'loss']);
  assert.equal(rows[0].them.type, 'profile');
});

test('classifiers', () => {
  assert.equal(negativeTitle('Fort Worth couple sentenced to jail for $5M home-building scam'), 'sentenced');
  assert.equal(negativeTitle('How Shanna Khan became queen of Fulton Market'), null);
  assert.equal(pageType('https://therealdeal.com/people/jon-gray/'), 'profile');
  assert.equal(pageType('https://therealdeal.com/miami/2026/10/13/jeff-bezos-linked-to-buyer/'), 'article');
  assert.equal(pageType('https://events.therealdeal.com/ny-speakers/peter-zaitzeff'), 'profile');
  assert.equal(accessTag('en.wikipedia.org'), 'reference');
  assert.equal(accessTag('nytimes.com'), null);
});
