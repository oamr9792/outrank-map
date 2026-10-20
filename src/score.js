import { negativeTitle, pageType, accessTag, section } from './classify.js';

/**
 * Head-to-head scoring of every domain against the target, over the live
 * SERPs of the target's person-name keywords.
 *
 * Only keywords where the target is still in the live results count: those
 * are the contests. A domain "wins" a keyword when its best organic position
 * is above the target's best.
 *
 * Each contest also gets a weight, 0 to 1, for how closely it resembles the
 * client's situation (the profile). Weighted reach is the weighted share of
 * contests won: Σ weight of contests won ÷ Σ weight of all contests.
 */

const isTarget = (domain, target) => domain === target || domain.endsWith(`.${target}`);

// --- the situation profile ---------------------------------------------------------

/** Monthly search-volume bands, as [low, high). */
export const VOLUME_BANDS = [
  [0, 100, '<100'],
  [100, 1000, '100–1k'],
  [1000, 10000, '1k–10k'],
  [10000, Infinity, '10k+'],
];
export const bandOf = (volume) => VOLUME_BANDS.findIndex(([lo, hi]) => (volume ?? 0) >= lo && (volume ?? 0) < hi);

/**
 * Component weights from the brief; tune here. A component only counts when
 * the profile sets it, and the weight is normalised over the components that
 * are set — so a profile of page type alone weights each contest 1 or 0.
 */
export const WEIGHTS = { pageType: 0.4, position: 0.3, volumeBand: 0.2, category: 0.1 };
export const POSITION_WINDOW = 3;

/**
 * The old scopes, kept as presets. Each sets one component, so its weighted
 * reach equals the reach the scope used to give by filtering.
 * category '*' matches any negative headline.
 */
export const PRESETS = {
  all: {},
  negative: { category: '*' },
  article: { pageType: 'article' },
};

/** Drops unknown or empty fields so a profile can come straight from a request. */
export function cleanProfile(p = {}) {
  const out = {};
  if (typeof p.pageType === 'string' && p.pageType) out.pageType = p.pageType.slice(0, 20);
  if (Number(p.position) > 0) out.position = Math.floor(Number(p.position));
  const band = p.volumeBand === '' || p.volumeBand == null ? NaN : Number(p.volumeBand);
  if (Number.isInteger(band) && band >= 0 && band < VOLUME_BANDS.length) out.volumeBand = band;
  if (typeof p.category === 'string' && p.category) out.category = p.category.slice(0, 40);
  return out;
}

/** A contest's category: the category of its headline's negative word. */
const categoryOf = (negative) => negative?.category ?? null;

/**
 * How closely one contest matches the profile. Returns the weight and, per
 * component that the profile sets, whether it matched — for the drill-down.
 */
export function contestWeight(k, profile = {}) {
  const parts = {};
  if (profile.pageType) parts.pageType = k.target.type === profile.pageType;
  if (profile.position) parts.position = Math.abs(k.target.position - profile.position) <= POSITION_WINDOW;
  if (profile.volumeBand != null) parts.volumeBand = bandOf(k.volume) === profile.volumeBand;
  if (profile.category) {
    const c = categoryOf(k.target.negative);
    parts.category = profile.category === '*' ? c !== null : c === profile.category;
  }
  const set = Object.keys(parts);
  if (!set.length) return { weight: 1, parts };
  const max = set.reduce((a, key) => a + WEIGHTS[key], 0);
  const got = set.reduce((a, key) => a + (parts[key] ? WEIGHTS[key] : 0), 0);
  return { weight: got / max, parts };
}

// --- contests and scores -------------------------------------------------------------

/** Attaches the target's own result and the contest's weight to each keyword. */
export function contests(keywords, target, { profile = {} } = {}) {
  const out = [];
  for (const k of keywords) {
    const mine = k.results.filter((r) => isTarget(r.domain, target));
    if (!mine.length) continue;
    const best = mine.reduce((a, b) => (b.position < a.position ? b : a));
    const c = { ...k, target: { position: best.position, url: best.url, title: best.title, negative: negativeTitle(best.title), type: pageType(best.url) } };
    const { weight, parts } = contestWeight(c, profile);
    out.push({ ...c, weight, parts });
  }
  return out;
}

/** Best (lowest) position per domain in one SERP, excluding the target. */
function bestByDomain(results, target) {
  const best = new Map();
  for (const r of results) {
    if (isTarget(r.domain, target)) continue;
    const cur = best.get(r.domain);
    if (!cur || r.position < cur.position) best.set(r.domain, r);
  }
  return best;
}

export function scoreDomains(keywords, target, { profile = {}, minAppearances = 1 } = {}) {
  const set = contests(keywords, target, { profile });
  const totalWeight = set.reduce((a, k) => a + k.weight, 0);
  const agg = new Map();
  for (const k of set) {
    const tpos = k.target.position;
    for (const [domain, r] of bestByDomain(k.results, target)) {
      let a = agg.get(domain);
      if (!a) agg.set(domain, (a = { domain, appearances: 0, wins: 0, weightWon: 0, gap: 0, volumeWon: 0, top3Wins: 0, people: new Set(), types: {}, sections: {} }));
      a.appearances++;
      if (r.position < tpos) {
        a.wins++;
        a.weightWon += k.weight;
        a.gap += tpos - r.position;
        a.volumeWon += k.volume;
        if (r.position <= 3) a.top3Wins++;
        for (const p of k.people.length ? k.people : [k.keyword]) a.people.add(p.toLowerCase());
        const t = pageType(r.url);
        a.types[t] = (a.types[t] ?? 0) + 1;
        const s = section(r.url);
        a.sections[s] = (a.sections[s] ?? 0) + 1;
      }
    }
  }
  const n = set.length;
  const domains = [...agg.values()]
    .filter((a) => a.appearances >= minAppearances)
    .map((a) => ({
      domain: a.domain,
      wins: a.wins,
      appearances: a.appearances,
      // Share of every contest that this domain won: "how regularly it
      // outranks the target", including contests it was absent from.
      reach: n ? a.wins / n : 0,
      // The same, with each contest counted by its similarity to the profile.
      weightedReach: totalWeight ? a.weightWon / totalWeight : 0,
      // Head-to-head: when both appear, how often it is above. Smoothed
      // (Laplace) so 1-for-1 does not read as 100%.
      winRate: (a.wins + 1) / (a.appearances + 2),
      rawWinRate: a.appearances ? a.wins / a.appearances : 0,
      people: a.people.size,
      avgGap: a.wins ? a.gap / a.wins : 0,
      top3Wins: a.top3Wins,
      volumeWon: a.volumeWon,
      types: a.types,
      sections: Object.entries(a.sections).sort((x, y) => y[1] - x[1]).slice(0, 4),
      access: accessTag(a.domain),
    }))
    .sort((x, y) => y.weightedReach - x.weightedReach || y.wins - x.wins || y.winRate - x.winRate || y.volumeWon - x.volumeWon);

  const positions = set.map((k) => k.target.position);
  return {
    summary: {
      keywords: keywords.length,
      contests: n,
      // Σ weights: how many full matches the weighted figures rest on.
      effectiveContests: totalWeight,
      targetAbsent: keywords.length - n,
      targetAvgPosition: n ? positions.reduce((a, b) => a + b, 0) / n : null,
      targetTop3: positions.filter((p) => p <= 3).length,
      negativeContests: set.filter((k) => k.target.negative).length,
      // Contests per negative category of the target's headline.
      categories: set.reduce((acc, k) => {
        const c = categoryOf(k.target.negative);
        if (c) acc[c] = (acc[c] ?? 0) + 1;
        return acc;
      }, {}),
    },
    profile,
    domains,
  };
}

/** Every contest a domain took part in, wins first, with each contest's weight. */
export function domainDetail(keywords, target, domain, { profile = {} } = {}) {
  const rows = [];
  for (const k of contests(keywords, target, { profile })) {
    const r = bestByDomain(k.results, target).get(domain);
    if (!r) continue;
    rows.push({
      keyword: k.keyword,
      people: k.people,
      volume: k.volume,
      outcome: r.position < k.target.position ? 'win' : 'loss',
      weight: k.weight,
      parts: k.parts,
      target: k.target,
      them: { position: r.position, url: r.url, title: r.title, type: pageType(r.url) },
    });
  }
  return rows.sort((a, b) => (a.outcome === b.outcome ? b.weight - a.weight || b.volume - a.volume : a.outcome === 'win' ? -1 : 1));
}

/**
 * Merges per-host leaderboards for one client. A client's name SERP usually
 * has several negative hosts and a placement has to beat all of them, so a
 * candidate's merged score is its reach against the host it does worst
 * against (0 where it never beat or never met that host).
 *
 * Hosts with fewer than `minContests` contests still get a column but are
 * left out of the minimum: a few searches say too little, and one thin host
 * would otherwise pin every candidate to 0. If no host has enough, all count.
 *
 * Candidates already in the client's own name SERP are properties to
 * strengthen rather than new placements; at equal score they sort first.
 *
 * @param hosts   [{ domain, studyId, contests, domains }] — `domains` as
 *                returned by scoreDomains for that host's study
 * @param o.nameSerp the client's name SERP rows [{ position, url, domain }]
 */
export function mergeHosts(hosts, { nameSerp = [], minContests = 10 } = {}) {
  const hostNames = hosts.map((h) => h.domain);
  const isHost = (d) => hostNames.some((h) => isTarget(d, h));
  let counted = hosts.filter((h) => h.contests >= minContests);
  if (!counted.length) counted = hosts.filter((h) => h.contests > 0);
  const countedSet = new Set(counted.map((h) => h.domain));

  const inSerp = new Map();
  for (const r of nameSerp) {
    if (!r.domain || isHost(r.domain)) continue;
    const cur = inSerp.get(r.domain);
    if (!cur || r.position < cur.position) inSerp.set(r.domain, { position: r.position, url: r.url });
  }
  const serpFor = (d) => {
    let best = null;
    for (const [dom, hit] of inSerp) if ((dom === d || dom.endsWith(`.${d}`)) && (!best || hit.position < best.position)) best = hit;
    return best;
  };

  const candidates = new Map();
  for (const h of hosts) {
    for (const d of h.domains) {
      if (isHost(d.domain)) continue;
      if (!candidates.has(d.domain)) candidates.set(d.domain, { domain: d.domain, access: d.access, perHost: {}, types: {} });
      const c = candidates.get(d.domain);
      // Weighted when the host was scored against a profile; plain reach otherwise.
      c.perHost[h.domain] = { reach: d.weightedReach ?? d.reach, rawReach: d.reach, wins: d.wins, appearances: d.appearances, contests: h.contests };
      for (const [t, n] of Object.entries(d.types)) c.types[t] = (c.types[t] ?? 0) + n;
    }
  }

  const domains = [...candidates.values()].map((c) => {
    for (const h of hosts) c.perHost[h.domain] ??= { reach: 0, rawReach: 0, wins: 0, appearances: 0, contests: h.contests };
    let merged = null;
    let hardestHost = null;
    for (const h of counted) {
      const r = c.perHost[h.domain].reach;
      if (merged === null || r < merged) [merged, hardestHost] = [r, h.domain];
    }
    const serp = serpFor(c.domain);
    return {
      ...c,
      merged: merged ?? 0,
      hardestHost,
      totalWins: Object.values(c.perHost).reduce((a, p) => a + p.wins, 0),
      inNameSerp: serp?.position ?? null,
      nameSerpUrl: serp?.url ?? null,
    };
  });

  domains.sort(
    (x, y) =>
      y.merged - x.merged ||
      (x.inNameSerp === null) - (y.inNameSerp === null) ||
      (x.inNameSerp ?? 0) - (y.inNameSerp ?? 0) ||
      y.totalWins - x.totalWins,
  );

  return {
    hosts: hosts.map((h) => ({ domain: h.domain, studyId: h.studyId, contests: h.contests, effectiveContests: h.effectiveContests ?? h.contests, profile: h.profile ?? {}, counted: countedSet.has(h.domain) })),
    domains,
  };
}
