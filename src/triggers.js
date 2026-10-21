import { normalizeDomain, getStudy, loadStudyData, findReusableStudy, createTriggerRun, getTriggerRun, setTriggerStudies, saveTriggerHistory, loadTriggerHistory, saveAggregatorPage, getAggregatorPages, openDb } from './db.js';
import { createStudy, fetchSerps, estimate, DEFAULTS } from './run.js';
import { accessTag } from './classify.js';
import * as ahrefs from './ahrefs.js';
import * as dfs from './dataforseo.js';

/**
 * Aggregator triggers: what gets a person a ZoomInfo / RocketReach /
 * MarketScreener page. Three kinds of evidence, strongest last:
 *
 *  1. Co-occurrence: across people who have the aggregator page and
 *     comparable people who do not, which sites make it likelier.
 *  2. Timing: in 12 months of Google history, which of the two showed up
 *     first for the same person.
 *  3. Citation: which sites the aggregator's own profile pages link to or
 *     name as a source.
 *
 * None of it proves cause on its own. Together they point to the few
 * sources worth getting onto first; placements then test it.
 */

export const TIMING_NAMES = 60;
export const PAGE_NAMES = 150;
export const CANDIDATES_FOR_TIMING = 8;
// Measured on the decay run (30 searches, $0.018): ~$0.0006 a keyword.
const USD_HISTORY_MEASURED = 0.0006;

const isOf = (domain, root) => domain === root || domain.endsWith(`.${root}`);

// Citation evidence only counts once enough of the aggregator's pages were
// read: one readable page linking to facebook.com is not "cited by 100%".
export const MIN_PAGES_FOR_CITATION = 10;

/**
 * Other people-data aggregators and people-search sites. They travel with
 * each other because they draw on the same data, so they are shown as
 * fellow aggregators, never recommended as a source to get onto.
 */
const FELLOW = /(^|\.)(zoominfo\.com|rocketreach\.co|contactout\.com|signalhire\.com|apollo\.io|lusha\.com|seamless\.ai|leadiq\.com|adapt\.io|kaspr\.io|clearbit\.com|uplead\.com|datanyze\.com|whitepages\.com|truepeoplesearch\.com|fastpeoplesearch\.com|spokeo\.com|radaris\.com|411\.com|peoplefinders\.com|beenverified\.com|intelius\.com|clustrmaps\.com|nuwber\.com|marketscreener\.com|wallmine\.com|gurufocus\.com|prabook\.com)$/;
export const isFellowAggregator = (domain) => FELLOW.test(domain);

// --- pure analysis -----------------------------------------------------------------

/** One entry per person: the domains in their live results (best position, URL). */
export function nameSets(keywords) {
  const seen = new Map();
  for (const k of keywords) {
    const key = k.keyword.toLowerCase();
    if (seen.has(key)) continue;
    const domains = new Map();
    for (const r of k.results) {
      const cur = domains.get(r.domain);
      if (!cur || r.position < cur.position) domains.set(r.domain, { position: r.position, url: r.url });
    }
    seen.set(key, { keyword: k.keyword, people: k.people ?? [], domains });
  }
  return [...seen.values()];
}

const aggHit = (n, agg) => {
  for (const [d, v] of n.domains) if (isOf(d, agg)) return { domain: d, ...v };
  return null;
};

/**
 * How much more likely the aggregator is when a site is present.
 * lift = P(agg | site) / P(agg | no site), each with +0.5 / +1 smoothing so
 * small counts do not read as certainty. Only sites seen for at least
 * `minNames` people, and together with the aggregator `minBoth` times.
 */
export function liftTable(names, aggregator, { minNames = 5, minBoth = 3 } = {}) {
  const withAgg = names.filter((n) => aggHit(n, aggregator));
  const nA = withAgg.length;
  const counts = new Map();
  for (const n of names) for (const d of n.domains.keys()) if (!isOf(d, aggregator)) counts.set(d, (counts.get(d) ?? 0) + 1);
  const rows = [];
  for (const [domain, nD] of counts) {
    if (nD < minNames) continue;
    let both = 0;
    for (const n of withAgg) if (n.domains.has(domain)) both++;
    if (both < minBoth) continue;
    const nNot = names.length - nD;
    const aNot = nA - both;
    const pWith = (both + 0.5) / (nD + 1);
    const pWithout = (aNot + 0.5) / (nNot + 1);
    rows.push({ domain, names: nD, both, withAggShare: nA ? both / nA : 0, pWith: both / nD, pWithout: nNot ? aNot / nNot : 0, lift: pWith / pWithout, access: accessTag(domain) });
  }
  return { people: names.length, withAggregator: nA, rows: rows.sort((a, b) => b.lift - a.lift || b.both - a.both) };
}

const monthsApart = (a, b) => (Date.parse(b) - Date.parse(a)) / (30.44 * 864e5);

/**
 * Pure: for each candidate site, in how many people's 12-month history it
 * appeared before the aggregator, after it, or in the same snapshot. Both
 * already present in the first snapshot says nothing about order and is
 * counted apart (left-censored).
 */
export function timingTable(history, aggregator, domains) {
  const out = Object.fromEntries(domains.map((d) => [d, { before: 0, after: 0, same: 0, alreadyBoth: 0, lags: [] }]));
  for (const snaps of history.values()) {
    if (!snaps.length) continue;
    const first = (pred) => snaps.find((s) => [...s.domains.keys()].some(pred))?.date ?? null;
    const aFirst = first((d) => isOf(d, aggregator));
    if (!aFirst) continue;
    const start = snaps[0].date;
    for (const dom of domains) {
      const dFirst = first((d) => d === dom);
      if (!dFirst) continue;
      const t = out[dom];
      if (dFirst === start && aFirst === start) t.alreadyBoth++;
      else if (dFirst < aFirst) {
        t.before++;
        t.lags.push(monthsApart(dFirst, aFirst));
      } else if (dFirst > aFirst) t.after++;
      else t.same++;
    }
  }
  for (const t of Object.values(out)) {
    const s = [...t.lags].sort((a, b) => a - b);
    t.medianLagMonths = s.length ? s[s.length >> 1] : null;
    delete t.lags;
  }
  return out;
}

/** External domains a page links to, and source-like phrases it uses. */
const NOISE = /(^|\.)(google|googleapis|gstatic|googletagmanager|doubleclick|cloudflare|cloudfront|akamaihd|jsdelivr|unpkg|facebook\.net|fbcdn|twimg|w3\.org|schema\.org|adobe|segment|hotjar|onetrust|cookielaw|bootstrapcdn|fontawesome|typekit|sentry|newrelic|optimizely)\./;
const CUES = [
  ['company website', /company(?:'s)? (?:web)?site|official website/i],
  ['press release', /press release|newswire|business ?wire|pr ?newswire|globe ?newswire/i],
  ['regulatory filing', /\bSEC\b|filing|10-K|proxy statement|form 4|companies house/i],
  ['LinkedIn', /linkedin/i],
  ['news', /according to|reported by|news (?:article|coverage)/i],
  ['user / contributor', /community|contributor|submitted by|claim (?:this|your) profile/i],
  ['source line', /\bsources?:/i],
];
export function readAggregatorPage(html, aggregator) {
  const domains = new Set();
  for (const m of String(html).matchAll(/href\s*=\s*["'](https?:\/\/[^"'#\s]+)/gi)) {
    let host;
    try {
      host = new URL(m[1]).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      continue;
    }
    if (isOf(host, aggregator) || NOISE.test(`${host}.`)) continue;
    domains.add(host);
  }
  const text = String(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  return { linkDomains: [...domains], cues: CUES.filter(([, re]) => re.test(text)).map(([c]) => c) };
}

/**
 * Links or phrases on most of an aggregator's pages are its own template
 * (footer social links, "claim your profile"), not a citation of the person.
 * The ZoomInfo run had linkedin.com, facebook.com and gtm.ai on 127 of 127.
 */
export const TEMPLATE_SHARE = 0.6;

/** Pure: per domain, how many read aggregator pages link to it; cue counts. Template items are set apart. */
export function citationTable(pages) {
  const read = [...pages.values()].filter((p) => !p.error);
  const count = (key) => {
    const m = new Map();
    for (const p of read) for (const x of new Set(p[key])) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const allLinks = count('linkDomains');
  const allCues = count('cues');
  const isTemplate = (n) => read.length >= MIN_PAGES_FOR_CITATION && n / read.length > TEMPLATE_SHARE;
  const links = new Map([...allLinks].filter(([, n]) => !isTemplate(n)));
  const template = [...allLinks].filter(([, n]) => isTemplate(n)).map(([d]) => d);
  const cues = [...allCues].filter(([, n]) => !isTemplate(n)).sort((a, b) => b[1] - a[1]);
  const templateCues = [...allCues].filter(([, n]) => isTemplate(n)).map(([c]) => c);
  return { read: read.length, failed: pages.size - read.length, links, cues, template, templateCues };
}

const pctText = (x) => `${Math.round(x * 100)}%`;

/**
 * Pure: the recommended sources. Score = log(lift) x sqrt(people seen
 * together), times how often the site came first when the order is known,
 * plus a bonus for being linked from the aggregator's own pages.
 */
export function recommend(lift, timing, cites, aggregator, { top = 4 } = {}) {
  const rows = lift.rows.map((r) => {
    const t = timing[r.domain] ?? null;
    const decisive = t ? t.before + t.after : 0;
    const firstShare = decisive ? t.before / decisive : null;
    const cited = cites?.links.get(r.domain) ?? 0;
    const citedShare = cites?.read >= MIN_PAGES_FOR_CITATION ? cited / cites.read : 0;
    const fellow = isFellowAggregator(r.domain);
    const timingFactor = firstShare == null ? 1 : 0.5 + firstShare; // 0.5x … 1.5x
    const score = Math.log(Math.max(r.lift, 1)) * Math.sqrt(r.both) * timingFactor + 2 * citedShare;
    return { ...r, timing: t, firstShare, cited, citedShare, fellow, score };
  });
  rows.sort((a, b) => b.score - a.score);
  const picks = rows.filter((r) => !r.fellow && (r.lift >= 1.5 || r.citedShare >= 0.2)).slice(0, top);
  for (const r of rows) r.sentence = sentence(r, aggregator, lift);
  return { rows, picks };
}

function sentence(r, agg, lift) {
  const parts = [`People on ${r.domain} were ${r.lift.toFixed(1)}× as likely to have a ${agg} page (${pctText(r.pWith)} vs ${pctText(r.pWithout)}; seen together for ${r.both} of ${lift.withAggregator} people with one).`];
  if (r.timing) {
    const t = r.timing;
    const decisive = t.before + t.after;
    if (decisive) parts.push(`It showed up first in ${t.before} of ${decisive} histories where the order is clear${t.before && t.medianLagMonths != null ? `, about ${Math.max(1, Math.round(t.medianLagMonths))} month${Math.round(t.medianLagMonths) === 1 ? '' : 's'} earlier` : ''}.`);
    else if (t.alreadyBoth || t.same) parts.push('In the 12-month history both were already there, so the order is unknown.');
  }
  if (r.cited) parts.push(`${agg} pages linked to it ${r.cited} time${r.cited === 1 ? '' : 's'}.`);
  if (r.fellow) parts.push('It is another people-data aggregator: it travels with the same sources, it is not one to publish on.');
  return parts.join(' ');
}

// --- the run -------------------------------------------------------------------------

export function cleanTriggerInput(input) {
  const aggregator = normalizeDomain(input.aggregator);
  const control = normalizeDomain(input.control || 'linkedin.com');
  if (aggregator === control) throw new Error('The control site must differ from the aggregator');
  const country = String(input.country || 'us').toLowerCase();
  if (!dfs.locationCode(country)) throw new Error(`No location code for country "${country}"`);
  const limit = Math.min(Math.max(Math.floor(Number(input.limit) || 150), 20), 2000);
  // Aggregator people are mostly not famous; cap both sides alike.
  const maxVolume = Math.max(0, Math.floor(Number(input.maxVolume ?? 1000) || 0));
  // fresh: new studies even if finished ones exist (a bigger sample needs them).
  const fresh = input.fresh === true || input.fresh === 'on' || input.fresh === 'true';
  const timingNames = Math.min(Math.max(Math.floor(Number(input.timingNames) || TIMING_NAMES), 0), 500);
  return { aggregator, control, country, params: { limit, maxVolume, minWords: 2, maxWords: 2, maxPosition: 20, fresh, timingNames } };
}

/** Cost of a run before anything is created. Reused studies cost nothing. */
export function estimateTrigger(input) {
  const { aggregator, control, country, params } = cleanTriggerInput(input);
  const studyFor = (target) => (params.fresh ? null : findReusableStudy(target, country, 'desktop'));
  const one = estimate(params);
  const fresh = [aggregator, control].filter((t) => !studyFor(t)).length;
  const history = params.timingNames * USD_HISTORY_MEASURED;
  const pagesUsd = PAGE_NAMES * dfs.USD_PER_HTML_PAGE;
  return {
    aggregator,
    control,
    reuse: { exposed: studyFor(aggregator), control: studyFor(control) },
    newStudies: fresh,
    ahrefsUnits: fresh * one.ahrefsUnits,
    serpUsd: +(fresh * one.dataforseoUsd).toFixed(2),
    historyUsd: +history.toFixed(3),
    pagesUsd: +pagesUsd.toFixed(3),
    dataforseoUsd: +(fresh * one.dataforseoUsd + history + pagesUsd).toFixed(2),
    minutes: fresh * one.serpMinutes + 3,
  };
}

export function startTriggerRun(input) {
  const clean = cleanTriggerInput(input);
  return createTriggerRun(clean);
}

/** Load both studies' keyword data as one set of people. */
function pooled(run, load = loadStudyData) {
  const data = [];
  for (const id of [run.exposed_study_id, run.control_study_id]) if (id && getStudy(id)) data.push(...load(id));
  return nameSets(data);
}

export async function runTrigger(runId, log, { load = loadStudyData } = {}) {
  const run = getTriggerRun(runId);
  if (!run) throw new Error('No such run');
  const p = run.params;

  // 1–2: a study of the aggregator and one of the control, reused when finished.
  for (const [role, target] of [['exposed', run.aggregator], ['control', run.control]]) {
    let id = role === 'exposed' ? run.exposed_study_id : run.control_study_id;
    if (!id || !getStudy(id)) {
      id = p.fresh ? null : findReusableStudy(target, run.country, 'desktop');
      if (id) log(`${target}: reusing finished study #${id} (no cost)`);
      else {
        log(`${target}: new study`);
        id = await createStudy({ ...DEFAULTS, ...p, target, country: run.country }, log);
      }
      setTriggerStudies(runId, { [role]: id });
    }
    await fetchSerps(id, log);
  }

  // 3: co-occurrence (free) picks the candidates worth timing.
  const fresh = getTriggerRun(runId);
  const names = pooled(fresh, load);
  const lift = liftTable(names, run.aggregator);
  log(`${names.length} people; ${lift.withAggregator} have a ${run.aggregator} result; ${lift.rows.length} candidate sites`);
  const candidates = lift.rows.slice(0, CANDIDATES_FOR_TIMING).map((r) => r.domain);

  // 4: timing, for people with the aggregator and at least one candidate.
  const done = new Set(openDb().prepare('SELECT DISTINCT keyword FROM trigger_history WHERE run_id = ?').all(runId).map((r) => r.keyword));
  const timingNames = p.timingNames ?? TIMING_NAMES;
  const toTime = names.filter((n) => aggHit(n, run.aggregator) && candidates.some((c) => n.domains.has(c)) && !done.has(n.keyword)).slice(0, Math.max(0, timingNames - done.size));
  dfs.resetSpend();
  if (toTime.length) log(`Timing: 12-month history for ${toTime.length} people (~$${(toTime.length * USD_HISTORY_MEASURED).toFixed(3)})…`);
  const locationCode = dfs.locationCode(run.country);
  for (const n of toTime) {
    try {
      const { cost, snapshots } = await dfs.historicalSerps(n.keyword, { locationCode });
      saveTriggerHistory(runId, n.keyword, snapshots.map((s) => ({ date: s.date, results: s.results.filter((r) => r.position <= 30) })), cost);
    } catch (err) {
      if (err instanceof dfs.BudgetError || err.fatal) throw err;
      log(`  skipped "${n.keyword}": ${err.message}`);
    }
  }

  // 5: read the aggregator's own pages for the sites they cite.
  const urls = names.map((n) => aggHit(n, run.aggregator)?.url).filter(Boolean).slice(0, PAGE_NAMES);
  const cached = getAggregatorPages(urls);
  const toRead = urls.filter((u) => !cached.has(u));
  if (toRead.length) log(`Reading ${toRead.length} ${run.aggregator} pages (~$${(toRead.length * dfs.USD_PER_HTML_PAGE).toFixed(3)})…`);
  let ok = 0, bad = 0;
  for (const u of toRead) {
    try {
      const { html, cost } = await dfs.rawHtml(u);
      saveAggregatorPage(u, readAggregatorPage(html, run.aggregator), cost, runId);
      ok++;
    } catch (err) {
      if (err instanceof dfs.BudgetError || err.fatal) throw err;
      saveAggregatorPage(u, { error: err.message }, 0, runId);
      bad++;
    }
  }
  if (toRead.length) log(`Pages: ${ok} read, ${bad} refused or failed`);
  log(`DataForSEO spent on timing and pages: $${dfs.spentUsd().toFixed(3)}`);
}

// --- kinds of page ----------------------------------------------------------------------
// Each person's employer site is a different domain, so domain counts cannot
// see "a team page on their company's website". Grouping every result into a
// kind of page makes that pattern countable.

const KIND_RULES = [
  ['linkedin', 'LinkedIn profile', 'Create or complete the LinkedIn profile.', (d) => /(^|\.)linkedin\.com$/.test(d)],
  ['regulatory', 'Regulatory or official filing', 'Usually follows from a role (officer, director, registered adviser); not something to publish, but worth knowing it feeds the aggregator.', (d) => /(^|\.)(sec\.gov|finra\.org|nasaa\.org|nmlsconsumeraccess\.org|find-and-update\.company-information\.service\.gov\.uk|opencorporates\.com|bizapedia\.com|opengovus\.com|congress\.gov)$/.test(d)],
  ['press', 'Press-release wire', 'Issue a press release naming them (appointment, award, launch) on a wire.', (d) => /(^|\.)(prnewswire\.com|businesswire\.com|globenewswire\.com|accesswire\.com|einpresswire\.com|newswire\.com|prweb\.com|prlog\.org)$/.test(d)],
  ['business-profile', 'Business profile site', 'Create or claim a profile there (Crunchbase, TheOrg and similar).', (d) => /(^|\.)(crunchbase\.com|theorg\.com|pitchbook\.com|craft\.co|owler\.com|f6s\.com|wellfound\.com|angel\.co|dnb\.com|cbinsights\.com|tracxn\.com|bizjournals\.com)$/.test(d)],
  ['fellow', 'Another people-data aggregator', 'A symptom, not a source: it draws on the same data.', (d) => isFellowAggregator(d)],
  ['wiki', 'Wikipedia or similar', 'Hard to place; usually follows from press coverage.', (d) => /(^|\.)(wikipedia\.org|wikidata\.org|everybodywiki\.com|alchetron\.com)$/.test(d)],
  ['social', 'Social profile', 'Open or complete the social profile.', (d) => /(^|\.)(x\.com|twitter\.com|facebook\.com|instagram\.com|tiktok\.com|threads\.net|threads\.com|youtube\.com|medium\.com|substack\.com)$/.test(d)],
];

const fold = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const nameTokens = (name) => fold(name).split(/[^a-z0-9]+/).filter((t) => t.length > 1);

/**
 * The kind of one result for one person. Rule order matters: listed sites
 * first, then a site in the person's own name, then by the page's path.
 */
export function pageKind({ domain, url }, personName) {
  for (const [id, , , test] of KIND_RULES) if (test(domain)) return id;
  const label = domain.split('.').slice(0, -1).join('').replace(/[^a-z0-9]/g, '');
  const toks = nameTokens(personName);
  if (toks.length >= 2 && label.includes(toks.join(''))) return 'personal-site';
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    /* no path */
  }
  if (/\/(speakers?|events?|conference|summit|webinars?)(\/|$)/.test(path)) return 'speaker';
  if (/\/(team|our-team|leadership|management|people|person|bio|bios|about|about-us|staff|board|partners?|executives?|directors?|professionals?|attorneys?|lawyers?|advisors?)(\/|$)/.test(path)) return 'company-page';
  if (/\/(19|20)\d\d\/\d{1,2}\//.test(path) || /\/(news|article|articles|story|stories|press|blog)\//.test(path) || (path.split('/').pop() ?? '').split('-').length >= 4) return 'news';
  return null;
}

export const KINDS = Object.fromEntries([
  ...KIND_RULES.map(([id, label, action]) => [id, { label, action }]),
  ['personal-site', { label: 'A site in their own name', action: 'Publish a personal site at their name (e.g. firstlast.com) with a bio.' }],
  ['speaker', { label: 'Speaker or event bio', action: 'Speak at, or get listed by, an event that publishes speaker bios.' }],
  ['company-page', { label: 'Team or bio page on a company website', action: 'Get a bio on their company’s (or board’s, firm’s) team or leadership page.' }],
  ['news', { label: 'News or blog article', action: 'Earn or place an article that names them.' }],
]);

/** Pure: the same lift as liftTable, by kind of page instead of by domain. */
export function kindLiftTable(names, aggregator, { minNames = 5, minBoth = 3 } = {}) {
  const kinded = names.map((n) => {
    const person = n.people?.[0] ?? n.keyword;
    const kinds = new Set();
    for (const [domain, v] of n.domains) {
      if (isOf(domain, aggregator)) continue;
      const k = pageKind({ domain, url: v.url }, person);
      if (k) kinds.add(k);
    }
    return { ...n, kinds };
  });
  const withAgg = kinded.filter((n) => aggHit(n, aggregator));
  const nA = withAgg.length;
  const rows = [];
  for (const kind of Object.keys(KINDS)) {
    const nK = kinded.filter((n) => n.kinds.has(kind)).length;
    if (nK < minNames) continue;
    const both = withAgg.filter((n) => n.kinds.has(kind)).length;
    if (both < minBoth) continue;
    const nNot = kinded.length - nK;
    const aNot = nA - both;
    const lift = ((both + 0.5) / (nK + 1)) / ((aNot + 0.5) / (nNot + 1));
    rows.push({ kind, ...KINDS[kind], names: nK, both, pWith: both / nK, pWithout: nNot ? aNot / nNot : 0, lift });
  }
  rows.sort((a, b) => b.lift - a.lift || b.both - a.both);
  for (const r of rows) {
    r.sentence = `People with a ${r.label.toLowerCase()} in their results were ${r.lift.toFixed(1)}× as likely to have a ${aggregator} page (${Math.round(r.pWith * 100)}% vs ${Math.round(r.pWithout * 100)}%; ${r.both} of ${nA} people with one).`;
  }
  return { people: kinded.length, withAggregator: nA, rows };
}

/** The result page: everything from stored data (free). */
export function triggerReport(runId, { load = loadStudyData } = {}) {
  const run = getTriggerRun(runId);
  if (!run) throw new Error('No such run');
  const names = pooled(run, load);
  const lift = liftTable(names, run.aggregator);
  const candidates = lift.rows.slice(0, CANDIDATES_FOR_TIMING).map((r) => r.domain);
  const history = loadTriggerHistory(runId);
  const timing = timingTable(history, run.aggregator, lift.rows.map((r) => r.domain));
  const urls = names.map((n) => aggHit(n, run.aggregator)?.url).filter(Boolean).slice(0, PAGE_NAMES);
  const cites = citationTable(getAggregatorPages(urls));
  const rec = recommend(lift, timing, cites, run.aggregator);
  return {
    run,
    people: lift.people,
    withAggregator: lift.withAggregator,
    timedPeople: history.size,
    timedCandidates: candidates,
    pages: { read: cites.read, failed: cites.failed, cues: cites.cues, topLinks: [...cites.links].sort((a, b) => b[1] - a[1]).slice(0, 15), template: cites.template, templateCues: cites.templateCues },
    picks: rec.picks,
    kinds: kindLiftTable(names, run.aggregator).rows,
    rows: rec.rows.slice(0, 60),
  };
}
