import { listStudies, loadStudyData } from './db.js';
import { scoreDomains, PRESETS } from './score.js';
import { accessTag } from './classify.js';

/**
 * Every domain across every study (brief item 6): over time, the user's own
 * ranking of placement domains by their power to beat the targets studied.
 * No API calls; it reads stored SERPs only.
 *
 * Each study is scored exactly as its own page scores it, then summed, so a
 * domain's numbers here always reconcile with the per-study tables. Where a
 * target was studied more than once in a country, only the newest study
 * counts, so the same searches are never counted twice.
 */

/** The newest study per target and country, ignoring studies with no SERPs yet. */
export function latestStudies(studies) {
  const keep = new Map();
  for (const s of studies) {
    if (!s.fetched) continue;
    const key = `${s.target}|${s.country}`;
    if (!keep.has(key) || s.id > keep.get(key).id) keep.set(key, s);
  }
  return [...keep.values()];
}

/**
 * Pure: sums per-study leaderboards. `scored` is
 * [{ study: { id, target, country }, summary, domains }] from scoreDomains.
 * A domain's contests are the contests of the studies it appeared in.
 */
export function aggregate(scored, { minAppearances = 1, minTargets = 1 } = {}) {
  const agg = new Map();
  for (const { study, summary, domains } of scored) {
    for (const d of domains) {
      let a = agg.get(d.domain);
      if (!a) agg.set(d.domain, (a = { domain: d.domain, wins: 0, contests: 0, weightWon: 0, weightTotal: 0, appearances: 0, gap: 0, top3Wins: 0, volumeWon: 0, people: 0, types: {}, targets: [] }));
      a.wins += d.wins;
      a.contests += summary.contests;
      a.weightWon += d.weightedReach * summary.effectiveContests;
      a.weightTotal += summary.effectiveContests;
      a.appearances += d.appearances;
      a.gap += d.avgGap * d.wins;
      a.top3Wins += d.top3Wins;
      a.volumeWon += d.volumeWon;
      // People are distinct within a study; different targets' searches are
      // different people in practice, so the sum is a fair count.
      a.people += d.people;
      for (const [t, n] of Object.entries(d.types)) a.types[t] = (a.types[t] ?? 0) + n;
      a.targets.push({ target: study.target, country: study.country, studyId: study.id, wins: d.wins, contests: summary.contests, reach: d.reach });
    }
  }
  const targetSet = new Set(scored.map((s) => s.study.target));
  return [...agg.values()]
    .map((a) => ({
      domain: a.domain,
      wins: a.wins,
      contests: a.contests,
      reach: a.contests ? a.wins / a.contests : 0,
      weightedReach: a.weightTotal ? a.weightWon / a.weightTotal : 0,
      appearances: a.appearances,
      rawWinRate: a.appearances ? a.wins / a.appearances : 0,
      people: a.people,
      avgGap: a.wins ? a.gap / a.wins : 0,
      top3Wins: a.top3Wins,
      volumeWon: a.volumeWon,
      types: a.types,
      access: accessTag(a.domain, a.types),
      targetsMet: a.targets.length,
      targetsBeaten: a.targets.filter((t) => t.wins > 0).length,
      targets: a.targets.sort((x, y) => y.reach - x.reach),
      // A studied target can also compete against the other targets.
      isTarget: targetSet.has(a.domain),
    }))
    .filter((d) => d.appearances >= minAppearances && d.targetsMet >= minTargets)
    .sort((x, y) => y.targetsBeaten - x.targetsBeaten || y.weightedReach - x.weightedReach || y.wins - x.wins);
}

/** Scores every included study under one preset and sums them. */
export function allStudies({ scope = 'all', minAppearances = 1, minTargets = 1, load = loadStudyData } = {}) {
  const profile = PRESETS[scope] ?? PRESETS.all;
  const studies = latestStudies(listStudies());
  const scored = studies.map((s) => ({ study: s, ...scoreDomains(load(s.id), s.target, { profile }) }));
  return {
    studies: studies.map((s) => ({ id: s.id, target: s.target, country: s.country, name: s.name, contests: scored.find((x) => x.study.id === s.id).summary.contests })),
    domains: aggregate(scored, { minAppearances, minTargets }),
  };
}
