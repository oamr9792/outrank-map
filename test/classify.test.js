import test from 'node:test';
import assert from 'node:assert/strict';
import { negativeTitle, NEGATIVE_CATEGORIES } from '../src/classify.js';
import { scoreDomains, contestWeight } from '../src/score.js';

const cat = (title) => negativeTitle(title)?.category ?? null;

test('each category is recognised', () => {
  assert.equal(cat('Developer indicted on wire charges'), 'legal-criminal');
  assert.equal(cat('Tenants file lawsuit against landlord'), 'civil-litigation');
  assert.equal(cat('Lender moves to foreclose on tower'), 'financial-distress');
  assert.equal(cat('FINRA fines broker'), 'regulatory'); // "fines" is not a listed word; FINRA is
  assert.equal(cat('Firm fined $2M by state regulator'), 'regulatory');
  assert.equal(cat('CEO fired after harassment claims'), 'conduct');
  assert.equal(cat("The city's worst landlords"), 'reputation-opinion');
  assert.equal(cat('How she became queen of Fulton Market'), null);
});

test('a specific word beats a generic one, wherever it sits', () => {
  assert.deepEqual(negativeTitle('Broker accused of running Ponzi scheme'), { word: 'ponzi', category: 'legal-criminal' });
  assert.deepEqual(negativeTitle('Probe widens; firm sued by investors'), { word: 'sued', category: 'civil-litigation' });
  assert.deepEqual(negativeTitle('Developer under investigation'), { word: 'investigation', category: 'unspecified' });
});

test('multi-word entries and case', () => {
  assert.equal(cat('Owner files for CHAPTER  11'), 'financial-distress');
  assert.deepEqual(negativeTitle('Attorney General targets landlord'), { word: 'attorney general', category: 'regulatory' });
});

test('no word is listed in two categories', () => {
  const seen = new Map();
  for (const [c, words] of Object.entries(NEGATIVE_CATEGORIES)) {
    for (const w of words) {
      assert.ok(!seen.has(w), `"${w}" is in both ${seen.get(w)} and ${c}`);
      seen.set(w, c);
    }
  }
});

test('the profile category matches like for like; * matches any negative headline', () => {
  const k = (neg) => ({ volume: 0, target: { type: 'article', position: 1, negative: neg } });
  const civil = { word: 'sued', category: 'civil-litigation' };
  assert.equal(contestWeight(k(civil), { category: 'civil-litigation' }).weight, 1);
  assert.equal(contestWeight(k(civil), { category: 'regulatory' }).weight, 0);
  assert.equal(contestWeight(k(civil), { category: '*' }).weight, 1);
  assert.equal(contestWeight(k(null), { category: '*' }).weight, 0);
});

test('the summary counts contests per category', () => {
  const kw = (keyword, title) => ({ keyword, people: [], orgs: [], volume: 0, results: [{ position: 1, url: `https://t.com/${keyword}`, domain: 't.com', title }] });
  const { summary } = scoreDomains([kw('a', 'A sued'), kw('b', 'B sues again'), kw('c', 'C fined'), kw('d', 'D opens office')], 't.com');
  assert.deepEqual(summary.categories, { 'civil-litigation': 2, regulatory: 1 });
  assert.equal(summary.negativeContests, 3);
});
