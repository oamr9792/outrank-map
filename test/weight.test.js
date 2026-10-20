import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreDomains, domainDetail, contestWeight, cleanProfile, PRESETS, bandOf } from '../src/score.js';

/**
 * Five contests against t.com, each built to hit a known set of profile
 * components. Profile: article page, target at #5, volume 100–1k, negative.
 *
 *   #  page     pos  volume  headline   matches                       weight
 *   1  article   5     500   negative   type+pos+vol+cat              1.0
 *   2  article  12     500   neutral    type+vol                      0.6
 *   3  profile   6    5000   negative   pos+cat                       0.4
 *   4  profile  20      50   neutral    none                          0.0
 *   5  article   3    2000   negative   type+pos+cat                  0.8
 *
 * a.com wins 1 and 4; b.com wins 3 and 5. Same plain reach, different
 * weighted reach.
 */
const PROFILE = { pageType: 'article', position: 5, volumeBand: 1, category: '*' };
const ARTICLE = (i, neg) => ({ url: `https://t.com/2025/01/02/person-${i}-story-headline/`, title: neg ? `Person ${i} sued by lenders` : `Person ${i} opens a new office` });
const PROFILE_PAGE = (i, neg) => ({ url: `https://t.com/people/person-${i}`, title: neg ? `Person ${i} indicted` : `Person ${i}` });
const SPEC = [
  [ARTICLE(1, true), 5, 500, ['a.com']],
  [ARTICLE(2, false), 12, 500, []],
  [PROFILE_PAGE(3, true), 6, 5000, ['b.com']],
  [PROFILE_PAGE(4, false), 20, 50, ['a.com']],
  [ARTICLE(5, true), 3, 2000, ['b.com']],
];
const fixture = SPEC.map(([page, tpos, volume, winners], i) => {
  const results = [{ position: tpos, url: page.url, domain: 't.com', title: page.title }];
  // Winners sit above the target, everyone else below it.
  let above = 1;
  let below = tpos + 1;
  for (const d of ['a.com', 'b.com']) {
    const position = winners.includes(d) ? above++ : below++;
    results.push({ position, url: `https://${d}/p${i}`, domain: d, title: '' });
  }
  return { keyword: `person ${i + 1}`, people: [`person ${i + 1}`], orgs: [], volume, results };
});

test('each contest is weighted by the components it matches', () => {
  const rows = domainDetail(fixture, 't.com', 'a.com', { profile: PROFILE });
  const byKw = Object.fromEntries(rows.map((r) => [r.keyword, r.weight]));
  const expected = { 'person 1': 1, 'person 2': 0.6, 'person 3': 0.4, 'person 4': 0, 'person 5': 0.8 };
  for (const [k, w] of Object.entries(expected)) assert.ok(Math.abs(byKw[k] - w) < 1e-9, `${k}: ${byKw[k]} ≠ ${w}`);
  // The drill-down says why: contest 4 matched nothing.
  assert.deepEqual(rows.find((r) => r.keyword === 'person 4').parts, { pageType: false, position: false, volumeBand: false, category: false });
});

test('weighted reach differs from reach and sets the default order', () => {
  const { summary, domains } = scoreDomains(fixture, 't.com', { profile: PROFILE });
  assert.equal(summary.contests, 5);
  assert.ok(Math.abs(summary.effectiveContests - 2.8) < 1e-9);
  const a = domains.find((d) => d.domain === 'a.com');
  const b = domains.find((d) => d.domain === 'b.com');
  assert.equal(a.reach, 0.4);
  assert.equal(b.reach, 0.4);
  assert.ok(Math.abs(a.weightedReach - 1.0 / 2.8) < 1e-9);
  assert.ok(Math.abs(b.weightedReach - 1.2 / 2.8) < 1e-9);
  assert.deepEqual(domains.map((d) => d.domain), ['b.com', 'a.com']);
});

test('presets reproduce the old scope filters', () => {
  // article preset: weight 1 on articles (1, 2, 5), 0 elsewhere.
  const art = scoreDomains(fixture, 't.com', { profile: PRESETS.article });
  assert.equal(art.summary.effectiveContests, 3);
  assert.ok(Math.abs(art.domains.find((d) => d.domain === 'b.com').weightedReach - 1 / 3) < 1e-9);
  // negative preset: contests 1, 3, 5.
  const neg = scoreDomains(fixture, 't.com', { profile: PRESETS.negative });
  assert.equal(neg.summary.effectiveContests, 3);
  assert.ok(Math.abs(neg.domains.find((d) => d.domain === 'b.com').weightedReach - 2 / 3) < 1e-9);
  // all: no components, every contest weighs 1, so weighted reach = reach.
  const all = scoreDomains(fixture, 't.com', { profile: PRESETS.all });
  assert.ok(all.domains.every((d) => d.weightedReach === d.reach));
});

test('partial profiles normalise over the components that are set', () => {
  const k = { volume: 500, target: { type: 'profile', position: 8, negative: null } };
  assert.equal(contestWeight(k, { position: 5 }).weight, 1); // |8-5| = 3 is inside the window
  assert.equal(contestWeight(k, { position: 4 }).weight, 0);
  assert.ok(Math.abs(contestWeight(k, { pageType: 'article', volumeBand: 1 }).weight - 1 / 3) < 1e-9); // 0.2 of 0.6
  assert.equal(contestWeight(k, {}).weight, 1);
});

test('profiles from requests are cleaned, and volume bands are as labelled', () => {
  assert.deepEqual(cleanProfile({ pageType: 'article', position: '7', volumeBand: '2', category: '', junk: 1 }), { pageType: 'article', position: 7, volumeBand: 2 });
  assert.deepEqual(cleanProfile({ position: -1, volumeBand: 9 }), {});
  assert.deepEqual([bandOf(0), bandOf(99), bandOf(100), bandOf(9999), bandOf(10000)], [0, 0, 1, 2, 3]);
});
