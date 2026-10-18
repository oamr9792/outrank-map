/**
 * DataForSEO client: live Google organic results for one keyword.
 *
 * Every call's cost is added to a per-run tally checked against
 * DATAFORSEO_MAX_USD before the next call goes out.
 */
const BASE = 'https://api.dataforseo.com/v3';
const TIMEOUT_MS = 90000;

let spent = 0;
export const spentUsd = () => spent;
export const resetSpend = () => (spent = 0);
export const hasCredentials = () => Boolean(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
export const budget = () => Number(process.env.DATAFORSEO_MAX_USD || 10);
// Live advanced is billed per 10 results fetched. Observed October 2026:
// 15 calls at depth 40 cost $0.093, so about $0.0016 per 10.
export const usdPerSerp = (depth = 30) => 0.0016 * Math.ceil(depth / 10);

export class BudgetError extends Error {}

async function post(pathname, task) {
  if (!hasCredentials()) throw new Error('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set in .env');
  if (spent >= budget()) throw new BudgetError(`DataForSEO budget reached ($${spent.toFixed(3)} of $${budget()}). Raise DATAFORSEO_MAX_USD and resume.`);
  const auth = 'Basic ' + Buffer.from(`${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`).toString('base64');

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(BASE + pathname, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify([task]),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = await res.json().catch(() => null);
      if (!body) throw new Error(`DataForSEO HTTP ${res.status}`);
      if (body.status_code !== 20000) {
        const err = new Error(`DataForSEO: ${body.status_message} (${body.status_code})`);
        if (/^40[12]/.test(String(body.status_code))) err.fatal = true;
        throw err;
      }
      spent += Number(body.cost ?? 0);
      const t = body.tasks?.[0];
      // "Completed with partial results" still carries usable items.
      const partial = Array.isArray(t?.result) && t.result.some((r) => r?.items?.length);
      if (!t || (t.status_code !== 20000 && !partial)) {
        const err = new Error(`DataForSEO task: ${t?.status_message ?? 'no task'} (${t?.status_code})`);
        // Auth / funds stop the run; 40101 and friends are transient.
        if (/^40(100|200|210)/.test(String(t?.status_code))) err.fatal = true;
        throw err;
      }
      return { task: t, cost: Number(body.cost ?? t.cost ?? 0) };
    } catch (err) {
      lastErr = err;
      if (err.fatal) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/**
 * Organic results only, as { position, url, domain, title }. position is the
 * organic rank (rank_group), so SERP features above do not shift it — the
 * same basis Ahrefs' best_position uses.
 */
export async function serp(keyword, { depth = 20, locationCode = 2840, languageCode = 'en' } = {}) {
  const { task, cost } = await post('/serp/google/organic/live/advanced', {
    keyword,
    depth,
    location_code: locationCode,
    language_code: languageCode,
    device: 'desktop',
  });
  const results = [];
  for (const item of task.result?.[0]?.items ?? []) {
    if (item?.type !== 'organic' || !item.url) continue;
    results.push({
      position: item.rank_group,
      url: item.url,
      domain: hostOf(item.url) ?? (item.domain ?? '').replace(/^www\./, ''),
      title: item.title ?? '',
    });
  }
  return { cost, results };
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Google Ads location codes for the countries this tool is likely to see. */
export const LOCATION_CODES = { us: 2840, gb: 2826, ca: 2124, au: 2036, ie: 2372, il: 2376, de: 2276, fr: 2250 };
