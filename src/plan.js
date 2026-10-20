import { getClient, listTargets, listClientPicks } from './db.js';
import { mergedForClient, annotateSerp } from './client.js';
import { currentDecay } from './decay.js';
import { estimateExplain, runExplain, explanations } from './pages.js';
import { normUrl } from './placements.js';

/**
 * The client plan (brief item 8): the report read as a plan, in this order —
 * the name SERP with the problem URLs marked, whether each problem host fades
 * on its own, then the shortlist split into properties to strengthen (already
 * in the name SERP) and new placements. Everything here is read from stored
 * data; the only paid step is the explain run, which is confirmed first.
 */

export const REPORT_SERP_ROWS = 20;

const pickDomains = (clientId) => listClientPicks(clientId).map((p) => p.domain);

/** Hosts that have a study, for the per-host explain runs. */
function studiedHosts(clientId, load) {
  return mergedForClient(clientId, load, { mode: 'profile' }).hosts.filter((h) => h.studyId);
}

export function estimateClientExplain(clientId, load) {
  const domains = pickDomains(clientId);
  const per = studiedHosts(clientId, load).map((h) => ({ host: h.domain, ...estimateExplain(h.studyId, domains) }));
  const sum = (k) => per.reduce((a, p) => a + p[k], 0);
  return {
    domains: domains.length,
    hosts: per.length,
    pages: sum('pages'),
    cached: sum('cached'),
    ahrefsPages: sum('ahrefsPages'),
    ahrefsUnits: sum('ahrefsUnits'),
    htmlPages: sum('htmlPages'),
    dataforseoUsd: +per.reduce((a, p) => a + p.dataforseoUsd, 0).toFixed(3),
  };
}

export async function runClientExplain(clientId, load, log) {
  const domains = pickDomains(clientId);
  if (!domains.length) throw new Error('Star at least one domain in the client table first');
  for (const h of studiedHosts(clientId, load)) {
    log(`${h.domain} (study #${h.studyId}):`);
    await runExplain(h.studyId, log, { domains });
  }
}

export function clientReport(clientId, load) {
  const c = getClient(clientId);
  if (!c) throw new Error('No such client');
  const targets = listTargets(clientId);
  const problem = new Set(targets.map((t) => normUrl(t.url)));
  const picks = listClientPicks(clientId);
  const picked = new Set(picks.map((p) => p.domain));
  const merged = mergedForClient(clientId, load, { mode: 'profile' });

  const serp = annotateSerp(c.serp ?? [])
    .slice(0, REPORT_SERP_ROWS)
    .map((r) => ({ ...r, problem: problem.has(normUrl(r.url)), shortlisted: [...picked].some((d) => r.domain === d || r.domain.endsWith(`.${d}`)) }));
  const offSerp = targets.filter((t) => !serp.some((r) => normUrl(r.url) === normUrl(t.url))).map((t) => ({ url: t.url, domain: t.domain, position: t.position_seen }));

  const hosts = merged.hosts.map((h) => ({ ...h, decay: h.studyId ? currentDecay(h.studyId) : null }));
  const why = Object.fromEntries(hosts.filter((h) => h.studyId).map((h) => [h.domain, explanations(h.studyId, [...picked])]));

  const shortlist = picks.map((p) => {
    const d = merged.domains.find((x) => x.domain === p.domain);
    return {
      domain: p.domain,
      note: p.note,
      found: Boolean(d),
      merged: d?.merged ?? null,
      hardestHost: d?.hardestHost ?? null,
      perHost: d?.perHost ?? {},
      inNameSerp: d?.inNameSerp ?? null,
      nameSerpUrl: d?.nameSerpUrl ?? null,
      access: d?.access ?? null,
      types: d?.types ?? {},
      sections: d?.sections ?? [],
      why: Object.fromEntries(Object.entries(why).map(([host, ex]) => [host, ex[p.domain]?.sentence ?? null])),
    };
  });
  const byScore = (a, b) => (b.merged ?? -1) - (a.merged ?? -1);
  return {
    client: { id: c.id, name: c.name, country: c.country, serpAt: c.serp_at },
    serp,
    offSerp,
    hosts,
    strengthen: shortlist.filter((s) => s.inNameSerp).sort((a, b) => a.inNameSerp - b.inNameSerp),
    newPlacements: shortlist.filter((s) => !s.inNameSerp).sort(byScore),
  };
}
