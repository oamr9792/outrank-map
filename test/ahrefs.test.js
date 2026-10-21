import test from 'node:test';
import assert from 'node:assert/strict';
import { personKeywords } from '../src/ahrefs.js';

// Captures the request instead of calling Ahrefs.
async function whereFor(opts) {
  process.env.AHREFS_API_KEY = 'test';
  let url;
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => {
    url = new URL(u);
    return { ok: true, json: async () => ({ keywords: [] }) };
  };
  try {
    await personKeywords('example.com', opts);
  } finally {
    globalThis.fetch = real;
  }
  return JSON.parse(url.searchParams.get('where')).and.filter((c) => c.field === 'words').map((c) => c.is);
}

test('word-count range becomes gte/lte filters', async () => {
  assert.deepEqual(await whereFor({ minWords: 2, maxWords: 4 }), [['gte', 2], ['lte', 4]]);
  assert.deepEqual(await whereFor({ minWords: 2, maxWords: 2 }), [['gte', 2], ['lte', 2]]);
  assert.deepEqual(await whereFor({ minWords: 3, maxWords: 0 }), [['gte', 3]]);
  assert.deepEqual(await whereFor({ minWords: 0, maxWords: 0 }), []);
});

test('pages past the 100-row cap with a (volume, keyword) cursor', async () => {
  process.env.AHREFS_API_KEY = 'test';
  // 250 rows ranked by volume desc, keyword asc; the API never returns more than 100.
  const all = Array.from({ length: 250 }, (_, i) => ({ keyword: `name ${String(i).padStart(3, '0')}`, volume: 1000 - Math.floor(i / 3), entities: [], best_position: 3 }));
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const url = new URL(u);
    const where = JSON.parse(url.searchParams.get('where'));
    calls.push({ limit: Number(url.searchParams.get('limit')), order: url.searchParams.get('order_by'), cursor: where.and.find((c) => c.or) });
    const cur = calls.at(-1).cursor;
    const after = cur ? all.filter((r) => r.volume < cur.or[0].is[1] || (r.volume === cur.or[1].and[0].is[1] && r.keyword > cur.or[1].and[1].is[1])) : all;
    return { ok: true, json: async () => ({ keywords: after.slice(0, Math.min(100, calls.at(-1).limit)) }) };
  };
  try {
    const got = await personKeywords('example.com', { limit: 230 });
    assert.equal(got.length, 230);
    assert.deepEqual(calls.map((c) => c.limit), [100, 100, 30]);
    assert.equal(calls[0].order, 'volume:desc,keyword:asc');
    assert.equal(new Set(got.map((g) => g.keyword)).size, 230); // no repeats across pages, ties included
    const fewer = await personKeywords('example.com', { limit: 1000 });
    assert.equal(fewer.length, 250); // stops at a short page
  } finally {
    globalThis.fetch = real;
  }
});
