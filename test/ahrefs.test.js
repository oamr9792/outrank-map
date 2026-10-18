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
