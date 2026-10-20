import { getStudy, loadStudyData, loadHistory, saveHistory, saveDecay } from './db.js';
import { contests } from './score.js';
import * as dfs from './dataforseo.js';

/**
 * How the target fades on its own (brief item 5). For a sample of the
 * study's contests, highest volume first, pull the last 12 months of monthly
 * Google snapshots and follow the target's position.
 *
 * A snapshot where the target is missing counts as one place below the last
 * result in that snapshot: dropping out is the strongest form of decay, and
 * leaving it out would make a fading page look stable.
 */

export const DEFAULT_SAMPLE = 30;

const isTarget = (domain, target) => domain === target || domain.endsWith(`.${target}`);

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** The target's best position in one snapshot, or null. */
export function targetPosition(results, target) {
  let best = null;
  for (const r of results) if (isTarget(r.domain, target) && (best === null || r.position < best)) best = r.position;
  return best;
}

/** Contests in scope (weight > 0 under the profile), highest volume first. */
export function sampleKeywords(keywords, target, profile = {}, n = DEFAULT_SAMPLE) {
  return contests(keywords, target, { profile })
    .filter((k) => k.weight > 0)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, n);
}

const monthOf = (date) => date.slice(0, 7);
const monthsBack = (month, n) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return d.toISOString().slice(0, 7);
};

/**
 * Pure: per month, the median of each keyword's position (its latest
 * snapshot that month; missing = results + 1), and the median over keywords
 * of the change between the latest month and six months before it.
 * Positive change = the target moved down.
 */
export function summarizeDecay(history) {
  const perKw = new Map(); // keyword -> Map(month -> position)
  for (const [kw, snaps] of history) {
    const byMonth = new Map();
    for (const s of [...snaps].sort((a, b) => a.date.localeCompare(b.date))) {
      byMonth.set(monthOf(s.date), { position: s.position ?? s.resultsCount + 1, missing: s.position == null });
    }
    if (byMonth.size) perKw.set(kw, byMonth);
  }
  const months = [...new Set([...perKw.values()].flatMap((m) => [...m.keys()]))].sort();
  const series = months.map((month) => {
    const here = [...perKw.values()].map((m) => m.get(month)).filter(Boolean);
    return { month, median: median(here.map((h) => h.position)), keywords: here.length, missing: here.filter((h) => h.missing).length };
  });
  const latest = months.at(-1) ?? null;
  const base = latest ? monthsBack(latest, 6) : null;
  const deltas = [];
  for (const m of perKw.values()) if (latest && m.has(latest) && m.has(base)) deltas.push(m.get(latest).position - m.get(base).position);
  return { series, latest, baseMonth: base, change6: median(deltas), change6Keywords: deltas.length, keywords: perKw.size };
}

export function estimateDecay(studyId, profile, n = DEFAULT_SAMPLE) {
  const study = getStudy(studyId);
  const sample = sampleKeywords(loadStudyData(studyId), study.target, profile ?? study.profile, n);
  return { keywords: sample.length, dataforseoUsd: +(sample.length * dfs.USD_PER_HISTORY_KEYWORD).toFixed(3) };
}

export async function runDecay(studyId, log, { profile, n = DEFAULT_SAMPLE } = {}) {
  const study = getStudy(studyId);
  if (!study) throw new Error('No such study');
  const sample = sampleKeywords(loadStudyData(studyId), study.target, profile ?? study.profile, n);
  if (!sample.length) throw new Error('No contests in scope to follow');
  dfs.resetSpend();
  const locationCode = dfs.LOCATION_CODES[study.country];
  log(`Pulling 12 months of history for ${sample.length} searches (~$${(sample.length * dfs.USD_PER_HISTORY_KEYWORD).toFixed(3)}, cap $${dfs.budget()})…`);
  let i = 0, ok = 0, bad = 0, stop = null;
  async function worker() {
    while (!stop && i < sample.length) {
      const k = sample[i++];
      try {
        const { cost, snapshots } = await dfs.historicalSerps(k.keyword, { locationCode });
        saveHistory(k.id, snapshots.map((s) => ({ date: s.date, position: targetPosition(s.results, study.target), resultsCount: s.results.length })), cost, studyId);
        ok++;
      } catch (err) {
        if (err instanceof dfs.BudgetError || err.fatal) {
          stop = err;
          break;
        }
        bad++;
        log(`  skipped "${k.keyword}": ${err.message}`);
      }
    }
  }
  // Labs allows 30 simultaneous requests; stay well under.
  await Promise.all(Array.from({ length: Math.min(8, Number(process.env.SERP_CONCURRENCY || 8)) }, worker));
  const ids = new Set(sample.map((k) => k.id));
  const history = new Map([...loadHistory(studyId)].filter(([id]) => ids.has(id)));
  const decay = { ...summarizeDecay(history), sampled: sample.length, fetchedAt: new Date().toISOString(), cost: dfs.spentUsd() };
  saveDecay(studyId, decay);
  log(`History: ${ok} fetched, ${bad} failed, $${dfs.spentUsd().toFixed(3)} spent`);
  if (stop) throw stop;
  return decay;
}
