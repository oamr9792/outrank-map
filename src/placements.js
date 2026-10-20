import { getClient, listTargets, listPlacements, saveCheck, listChecks, allPlacements, addPlacement } from './db.js';
import * as dfs from './dataforseo.js';

/**
 * What was done for a client and whether it worked (brief item 7). Nothing
 * is automatic: each "check now" is one live SERP for the client's name,
 * recording where every placement and every negative URL sits. Over time
 * the placements give a calibration set: the weighted reach the tool
 * predicted for a domain against what its placement actually did.
 */

export const CHECK_DEPTH = 30;

/** URLs compared without scheme, www, query, fragment or trailing slash. */
export const normUrl = (u) =>
  String(u ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();

/** Best position of a URL in a result list, or null. */
export function positionOf(url, results) {
  const want = normUrl(url);
  let best = null;
  for (const r of results) if (normUrl(r.url) === want && (best === null || r.position < best)) best = r.position;
  return best;
}

/** Rows to log for one check: every placement, then every negative URL. */
export function checkRows(placements, targets, results) {
  return [
    ...placements.map((p) => ({ kind: 'placement', url: p.url, placementId: p.id, position: positionOf(p.url, results) })),
    ...targets.map((t) => ({ kind: 'negative', url: t.url, position: positionOf(t.url, results) })),
  ];
}

/**
 * Pure: a placement's outcome at one check, against the negative URLs at
 * that check. A URL missing from the results sits below everything fetched.
 *   beats-all   above every negative URL that is in the results
 *   beats-some  above at least one
 *   below-all   in the results but under every negative URL
 *   not-ranking not in the results fetched
 */
export function outcome(placementPos, negativePositions) {
  if (placementPos == null) return { outcome: 'not-ranking', beaten: 0, of: negativePositions.length };
  const beaten = negativePositions.filter((n) => n == null || placementPos < n).length;
  const of = negativePositions.length;
  return { outcome: beaten === of ? 'beats-all' : beaten > 0 ? 'beats-some' : 'below-all', beaten, of };
}

export async function checkNow(clientId) {
  const c = getClient(clientId);
  if (!c) throw new Error('No such client');
  const placements = listPlacements(clientId);
  const targets = listTargets(clientId);
  if (!placements.length && !targets.length) throw new Error('Add a placement or a problem URL first');
  dfs.resetSpend();
  const { cost, results } = await dfs.serp(c.name, { depth: CHECK_DEPTH, locationCode: dfs.LOCATION_CODES[c.country] });
  const rows = checkRows(placements, targets, results);
  const id = saveCheck(clientId, c.name, rows, cost);
  return { id, cost, rows };
}

export function addClientPlacement(clientId, body, predictedReach) {
  const c = getClient(clientId);
  if (!c) throw new Error('No such client');
  addPlacement(clientId, { url: body.url, domain: body.domain, publishedAt: body.publishedAt, keyword: c.name, predictedReach });
}

/** A placement's position history and its latest outcome. */
function placementState(p, checks) {
  const history = [];
  for (const ch of [...checks].reverse()) {
    const mine = ch.rows.find((r) => r.kind === 'placement' && r.placement_id === p.id);
    if (!mine) continue;
    const negatives = ch.rows.filter((r) => r.kind === 'negative').map((r) => r.position);
    history.push({ checkedAt: ch.checked_at, position: mine.position, ...outcome(mine.position, negatives) });
  }
  return { ...p, history, latest: history.at(-1) ?? null };
}

/** The client page: placements with history, and every check's negative positions. */
export function clientPlacements(clientId) {
  const checks = listChecks(clientId);
  return {
    placements: listPlacements(clientId).map((p) => placementState(p, checks)),
    checks: checks.map((ch) => ({ id: ch.id, checkedAt: ch.checked_at, cost: ch.cost, negatives: ch.rows.filter((r) => r.kind === 'negative') })),
  };
}

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

/**
 * Calibration across all clients: one row per placement that has been
 * checked, predicted weighted reach against the latest observed outcome.
 */
export function calibration() {
  const checksByClient = new Map();
  const rows = [];
  for (const p of allPlacements()) {
    if (!checksByClient.has(p.client_id)) checksByClient.set(p.client_id, listChecks(p.client_id));
    const s = placementState(p, checksByClient.get(p.client_id));
    if (!s.latest) continue;
    rows.push({
      client: p.client_name,
      domain: p.domain,
      url: p.url,
      predictedReach: p.predicted_reach,
      publishedAt: p.published_at,
      daysLive: p.published_at ? daysBetween(p.published_at, s.latest.checkedAt) : null,
      checks: s.history.length,
      ...s.latest,
    });
  }
  rows.sort((a, b) => (b.predictedReach ?? -1) - (a.predictedReach ?? -1));
  return rows;
}
