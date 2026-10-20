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

const monthsApart = (a, b) => (Date.parse(b) - Date.parse(a)) / (30.44 * 864e5);

/** A month needs this many keywords to be drawn: fewer is a different mix of searches, not a trend. */
export const minKeywordsPerMonth = (total) => Math.max(5, Math.ceil(total * 0.25));

/**
 * Pure. Google's monthly snapshots are irregular: each keyword has some
 * months and not others. So:
 *
 *  - series: per month, the median position over the keywords with a
 *    snapshot that month (latest one wins; missing = results + 1). Months
 *    with too few keywords are marked `thin` and left off the chart.
 *  - change6: per keyword, its latest snapshot against its own snapshot
 *    nearest to six months earlier (4–8 months back); the median of those
 *    differences. Positive = the target moved down.
 */
export function summarizeDecay(history) {
  const perKw = new Map(); // keyword -> [{ date, position, missing }] by date
  for (const [kw, snaps] of history) {
    const s = [...snaps].sort((a, b) => a.date.localeCompare(b.date)).map((x) => ({ date: x.date, position: x.position ?? x.resultsCount + 1, missing: x.position == null }));
    if (s.length) perKw.set(kw, s);
  }
  const months = [...new Set([...perKw.values()].flatMap((s) => s.map((x) => monthOf(x.date))))].sort();
  const floor = minKeywordsPerMonth(perKw.size);
  const series = months.map((month) => {
    const here = [...perKw.values()].map((s) => s.filter((x) => monthOf(x.date) === month).at(-1)).filter(Boolean);
    return { month, median: median(here.map((h) => h.position)), keywords: here.length, missing: here.filter((h) => h.missing).length, thin: here.length < floor };
  });

  const deltas = [];
  const spans = [];
  for (const s of perKw.values()) {
    const last = s.at(-1);
    let base = null;
    for (const x of s) {
      const gap = monthsApart(x.date, last.date);
      if (gap >= 4 && gap <= 8 && (!base || Math.abs(gap - 6) < Math.abs(monthsApart(base.date, last.date) - 6))) base = x;
    }
    if (!base) continue;
    deltas.push(last.position - base.position);
    spans.push(monthsApart(base.date, last.date));
  }
  return {
    series,
    minKeywordsPerMonth: floor,
    change6: median(deltas),
    change6Keywords: deltas.length,
    spanMonths: median(spans),
    keywords: perKw.size,
  };
}

/**
 * The study's decay, recomputed from its stored history (free), with the
 * fetch's date and cost. Null if history was never fetched.
 */
export function currentDecay(studyId) {
  const study = getStudy(studyId);
  if (!study?.decay) return null;
  return { ...study.decay, ...summarizeDecay(loadHistory(studyId)) };
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
  const locationCode = dfs.locationCode(study.country);
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
