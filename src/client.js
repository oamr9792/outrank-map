import { openDb, getClient, getStudy, listTargets, linkTargetStudy, findReusableStudy, saveClientSerp, setClientVolume } from './db.js';
import { createStudy, fetchSerps, estimate, DEFAULTS } from './run.js';
import { scoreDomains, mergeHosts, PRESETS, bandOf, cleanProfile } from './score.js';
import { negativeTitle, pageType } from './classify.js';
import * as dfs from './dataforseo.js';

/**
 * The client entry point: start from a person's name, confirm which results
 * on their name SERP are the problem, study each problem host, and merge.
 * Studies are made and fetched by the same createStudy / fetchSerps as the
 * single-domain flow.
 */

export const NAME_SERP_DEPTH = 30;

/** One live SERP for the client's name. Replaces any earlier one. */
export async function fetchNameSerp(clientId) {
  const c = getClient(clientId);
  if (!c) throw new Error('No such client');
  const locationCode = dfs.LOCATION_CODES[c.country];
  if (!locationCode) throw new Error(`No location code for country "${c.country}"`);
  dfs.resetSpend();
  const { cost, results } = await dfs.serp(c.name, { depth: NAME_SERP_DEPTH, locationCode });
  saveClientSerp(clientId, results, cost);
  return { cost, results };
}

/** Name SERP rows with the negative-headline flag and page type attached. */
export const annotateSerp = (rows = []) => rows.map((r) => ({ ...r, negative: negativeTitle(r.title), type: pageType(r.url) }));

/** Whether every keyword of a study has its SERP (or has failed for good). */
function studyComplete(studyId) {
  const r = openDb()
    .prepare('SELECT COUNT(*) AS n, SUM(serp_at IS NULL AND serp_error IS NULL) AS pending FROM keywords WHERE study_id = ?')
    .get(studyId);
  return r.n > 0 && !r.pending;
}

/**
 * What a run would do per host: keep the linked study, reuse another
 * finished study of the same domain and country, resume an unfinished one,
 * or run a new one. Hosts named in `rerun` always get a new study.
 */
export function planHosts(clientId, { rerun = [] } = {}) {
  const c = getClient(clientId);
  const byDomain = new Map();
  for (const t of listTargets(clientId)) {
    if (!byDomain.has(t.domain)) byDomain.set(t.domain, { domain: t.domain, urls: [], linked: null });
    const h = byDomain.get(t.domain);
    h.urls.push(t.url);
    if (t.study_id && getStudy(t.study_id)) h.linked = t.study_id;
  }
  return [...byDomain.values()].map((h) => {
    if (rerun.includes(h.domain)) return { ...h, action: 'new', studyId: null };
    if (h.linked) return { ...h, action: studyComplete(h.linked) ? 'linked' : 'resume', studyId: h.linked };
    const reuse = findReusableStudy(h.domain, c.country);
    return reuse ? { ...h, action: 'reuse', studyId: reuse } : { ...h, action: 'new', studyId: null };
  });
}

export function estimateClient(clientId, params, opts) {
  const plan = planHosts(clientId, opts);
  const fresh = plan.filter((h) => h.action === 'new').length;
  const one = estimate(params);
  return {
    plan: plan.map(({ domain, action, studyId }) => ({ domain, action, studyId })),
    newStudies: fresh,
    ahrefsUnits: fresh * one.ahrefsUnits,
    dataforseoUsd: +(fresh * one.dataforseoUsd).toFixed(2),
    serpMinutes: fresh * one.serpMinutes,
  };
}

/** Runs the plan, host by host. Budget checks live in createStudy / fetchSerps. */
export async function runClient(clientId, params, log, opts = {}) {
  const c = getClient(clientId);
  if (!c) throw new Error('No such client');
  const plan = planHosts(clientId, opts);
  if (!plan.length) throw new Error('Confirm at least one negative URL first');
  for (const h of plan) {
    if (h.action === 'linked') {
      log(`${h.domain}: study #${h.studyId} already complete`);
      continue;
    }
    if (h.action === 'reuse') {
      linkTargetStudy(clientId, h.domain, h.studyId);
      log(`${h.domain}: reusing finished study #${h.studyId} (no cost)`);
      continue;
    }
    let id = h.studyId;
    if (h.action === 'new') {
      log(`${h.domain}: new study`);
      id = await createStudy({ ...DEFAULTS, ...params, target: h.domain, country: c.country }, log);
      openDb().prepare('UPDATE studies SET client_id = ? WHERE id = ?').run(clientId, id);
      linkTargetStudy(clientId, h.domain, id);
    } else log(`${h.domain}: resuming study #${id}`);
    await fetchSerps(id, log);
  }
}

/** One paid call: the client's name search volume, which also sets the band. */
export async function fetchNameVolume(clientId) {
  const c = getClient(clientId);
  if (!c) throw new Error('No such client');
  dfs.resetSpend();
  const { cost, volume } = await dfs.searchVolume(c.name, { locationCode: dfs.LOCATION_CODES[c.country] });
  setClientVolume(clientId, { volume, band: bandOf(volume ?? 0), cost });
  return { cost, volume };
}

/**
 * The situation profile for one host, from that host's own negative URL
 * (its best-ranked one in the name SERP when there are several): its page
 * type, live position and negative category, plus the client's volume band.
 */
export function hostProfile(client, hostTargets) {
  if (!hostTargets.length) return {};
  const ranked = hostTargets.filter((t) => t.position_seen).sort((a, b) => a.position_seen - b.position_seen);
  const t = ranked[0] ?? hostTargets[0];
  const row = (client.serp ?? []).find((r) => r.url === t.url);
  const negative = row ? negativeTitle(row.title) : null;
  return cleanProfile({
    pageType: pageType(t.url),
    position: t.position_seen,
    volumeBand: client.volume_band,
    // A headline that only says "accused" or "probe" matches any negative one.
    category: negative ? (negative.category === 'unspecified' ? '*' : negative.category) : null,
  });
}

/**
 * The merged leaderboard. `load(studyId)` returns a study's keyword data
 * (the server passes its cached loader). mode 'profile' weights each host by
 * its own profile; a preset name applies that preset to every host.
 */
export function mergedForClient(clientId, load, { mode = 'profile', minContests = 10 } = {}) {
  const c = getClient(clientId);
  if (!c) throw new Error('No such client');
  const hosts = [];
  const targets = listTargets(clientId);
  for (const domain of [...new Set(targets.map((t) => t.domain))]) {
    const own = targets.filter((t) => t.domain === domain);
    const profile = mode === 'profile' ? hostProfile(c, own) : PRESETS[mode] ?? {};
    const studyId = own.find((t) => t.study_id)?.study_id;
    const study = studyId ? getStudy(studyId) : null;
    if (!study) {
      hosts.push({ domain, studyId: null, contests: 0, effectiveContests: 0, profile, domains: [] });
      continue;
    }
    const scored = scoreDomains(load(study.id), study.target, { profile });
    hosts.push({ domain, studyId: study.id, contests: scored.summary.contests, effectiveContests: scored.summary.effectiveContests, profile, domains: scored.domains });
  }
  return { client: { id: c.id, name: c.name, country: c.country }, ...mergeHosts(hosts, { nameSerp: c.serp ?? [], minContests }) };
}
