import { openDb, tx, normalizeDomain, getStudy } from './db.js';
import * as ahrefs from './ahrefs.js';
import * as dfs from './dataforseo.js';

export const DEFAULTS = { country: 'us', limit: 300, minWords: 2, maxWords: 2, maxPosition: 20, minVolume: 0, maxVolume: 0, depth: 30 };

export function wordsLabel(p) {
  // Studies saved before the range existed carry a single `words`.
  const lo = p.minWords ?? p.words ?? 0;
  const hi = p.maxWords ?? p.words ?? 0;
  if (!lo && !hi) return 'any number of words';
  if (lo === hi) return `${lo} words`;
  if (!hi) return `${lo}+ words`;
  if (!lo) return `up to ${hi} words`;
  return `${lo}–${hi} words`;
}

const depthFor = (maxPosition) => Math.min(100, Math.ceil((maxPosition + 10) / 10) * 10);

export function estimate(p) {
  const limit = Number(p.limit) || DEFAULTS.limit;
  const depth = depthFor(Number(p.maxPosition) || DEFAULTS.maxPosition);
  return {
    ahrefsUnits: limit * ahrefs.UNITS_PER_KEYWORD,
    dataforseoUsd: +(limit * dfs.usdPerSerp(depth)).toFixed(2),
    serpMinutes: Math.ceil((limit * 25) / Number(process.env.SERP_CONCURRENCY || 8) / 60),
  };
}

function cleanParams(input) {
  const p = { ...DEFAULTS };
  for (const k of ['limit', 'minWords', 'maxWords', 'maxPosition', 'minVolume', 'maxVolume']) if (input[k] !== undefined && input[k] !== '') p[k] = Math.max(0, Math.floor(Number(input[k]) || 0));
  if (input.country) p.country = String(input.country).toLowerCase().slice(0, 2);
  p.limit = Math.min(Math.max(p.limit, 1), 10000);
  // 0 means no bound on that side; a reversed range is read the right way round.
  if (p.minWords && p.maxWords && p.minWords > p.maxWords) [p.minWords, p.maxWords] = [p.maxWords, p.minWords];
  p.maxPosition = Math.min(Math.max(p.maxPosition || 20, 1), 100);
  // Fetch deep enough to see the target wherever Ahrefs last saw it, plus slack.
  p.depth = depthFor(p.maxPosition);
  if (!dfs.LOCATION_CODES[p.country]) throw new Error(`No location code for country "${p.country}"`);
  return p;
}

/** Step 1: create the study and pull its keyword list from Ahrefs. */
export async function createStudy(input, log) {
  const target = normalizeDomain(input.target);
  const p = cleanParams(input);
  const need = p.limit * ahrefs.UNITS_PER_KEYWORD;
  const units = await ahrefs.unitsLeft();
  log(`Ahrefs units: ${units.used.toLocaleString()} used of ${units.limit?.toLocaleString() ?? 'unlimited'}; this pull needs up to ${need.toLocaleString()}`);
  if (need > units.remaining) throw new Error(`Not enough Ahrefs units: need up to ${need.toLocaleString()}, ${units.remaining.toLocaleString()} left until ${units.resetDate}. Lower the keyword limit.`);

  log(`Pulling up to ${p.limit} person-name keywords (${wordsLabel(p)}, position ≤ ${p.maxPosition}) for ${target}…`);
  const kws = await ahrefs.personKeywords(target, p);
  log(`Ahrefs returned ${kws.length} keywords`);

  const studyId = tx((d) => {
    const { lastInsertRowid } = d
      .prepare('INSERT INTO studies (target, country, params, created_at, ahrefs_units) VALUES (?, ?, ?, ?, ?)')
      .run(target, p.country, JSON.stringify(p), new Date().toISOString(), kws.length * ahrefs.UNITS_PER_KEYWORD);
    const ins = d.prepare('INSERT OR IGNORE INTO keywords (study_id, keyword, people, orgs, volume, ahrefs_position, ahrefs_url) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const k of kws) ins.run(lastInsertRowid, k.keyword, JSON.stringify(k.people), JSON.stringify(k.orgs), k.volume, k.position, k.url);
    return Number(lastInsertRowid);
  });
  return studyId;
}

/**
 * Step 2: live SERPs for every keyword not yet fetched. Resumable — stop it,
 * raise the budget, start it again, and it picks up where it left off.
 */
export async function fetchSerps(studyId, log, { retryFailed = false } = {}) {
  const study = getStudy(studyId);
  if (!study) throw new Error('No such study');
  const d = openDb();
  const pending = d
    .prepare(`SELECT id, keyword FROM keywords WHERE study_id = ? AND serp_at IS NULL ${retryFailed ? '' : 'AND serp_error IS NULL'} ORDER BY volume DESC`)
    .all(studyId);
  if (!pending.length) return log('Nothing to fetch: every keyword has its SERP.');
  dfs.resetSpend();
  const concurrency = Math.max(1, Number(process.env.SERP_CONCURRENCY || 8));
  log(`Fetching ${pending.length} live SERPs (depth ${study.params.depth}, ${concurrency} at a time, ~$${(pending.length * dfs.usdPerSerp(study.params.depth)).toFixed(2)}, cap $${dfs.budget()})…`);

  const save = d.prepare('INSERT OR REPLACE INTO results (keyword_id, position, url, domain, title) VALUES (?, ?, ?, ?, ?)');
  const done = d.prepare('UPDATE keywords SET serp_at = ?, serp_error = NULL WHERE id = ?');
  const fail = d.prepare('UPDATE keywords SET serp_error = ? WHERE id = ?');
  const addCost = d.prepare('UPDATE studies SET dfs_cost = dfs_cost + ? WHERE id = ?');

  let i = 0, ok = 0, bad = 0, stop = null;
  async function worker() {
    while (!stop && i < pending.length) {
      const k = pending[i++];
      try {
        const { cost, results } = await dfs.serp(k.keyword, { depth: study.params.depth, locationCode: dfs.LOCATION_CODES[study.country] });
        tx(() => {
          d.prepare('DELETE FROM results WHERE keyword_id = ?').run(k.id);
          for (const r of results) save.run(k.id, r.position, r.url, r.domain, r.title);
          done.run(new Date().toISOString(), k.id);
          addCost.run(cost, studyId);
        });
        ok++;
      } catch (err) {
        if (err instanceof dfs.BudgetError || err.fatal) {
          stop = err;
          break;
        }
        fail.run(err.message, k.id);
        bad++;
        log(`  skipped "${k.keyword}": ${err.message}`);
      }
      if ((ok + bad) % 25 === 0) log(`  ${ok + bad}/${pending.length} done ($${dfs.spentUsd().toFixed(2)})`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  log(`SERPs: ${ok} fetched, ${bad} failed, $${dfs.spentUsd().toFixed(3)} spent`);
  if (stop) throw stop;
}
