/**
 * Ahrefs API v3 client. One job here: list the target's ranking keywords that
 * name a person, using Ahrefs' per-keyword entity tagging (DataForSEO has no
 * equivalent — it tags intent, not the people in a query).
 */
const BASE = 'https://api.ahrefs.com/v3';

export const hasKey = () => Boolean(process.env.AHREFS_API_KEY);

// Observed on a live call: keyword, entities, best_position, best_position_url
// and volume cost 15 units per row. volume alone is 10 of those.
export const UNITS_PER_KEYWORD = 15;

async function get(pathname, params) {
  if (!hasKey()) throw new Error('AHREFS_API_KEY is not set in .env');
  const url = new URL(BASE + pathname);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.AHREFS_API_KEY}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(180000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Ahrefs ${pathname}: HTTP ${res.status} ${body?.error ?? ''}`.trim());
  return body;
}

/** { limit, used, remaining, resetDate } for this key, preferring the workspace pool. */
export async function unitsLeft() {
  const { limits_and_usage: u } = await get('/subscription-info/limits-and-usage', {});
  const limit = u.units_limit_api_key ?? u.units_limit_workspace;
  const used = u.units_limit_api_key != null ? u.units_usage_api_key : u.units_usage_workspace ?? u.units_usage_api_key;
  return { limit, used, remaining: limit == null ? Infinity : limit - used, resetDate: u.usage_reset_date };
}

/**
 * Person-name keywords the target ranks for, highest volume first.
 *
 * @param o.minWords / o.maxWords  word-count range of the keyword, 0 = no
 *                    bound (2–2 = "first last"; 2–4 adds "name + employer")
 * @param o.maxPosition only keywords where the target ranks at or above this
 * @param o.minVolume / o.maxVolume  volume band; the cap trims celebrities
 */
/** Most rows Ahrefs returns for one request, whatever the limit. */
export const PAGE_SIZE = 100;

export async function personKeywords(target, { country = 'us', limit = 500, minWords = 2, maxWords = 2, maxPosition = 20, minVolume = 0, maxVolume = 0 } = {}) {
  const and = [
    { not: { field: 'person_entities', is: 'empty' } },
    { field: 'best_position', is: ['lte', maxPosition] },
    // Organic positions only. Without this, best_position includes Top
    // stories carousels: a news piece from this week reads as "#1" but is
    // gone from the live organic results, so the keyword is no contest.
    { field: 'is_main_position', is: ['eq', true] },
  ];
  if (minWords) and.push({ field: 'words', is: ['gte', minWords] });
  if (maxWords) and.push({ field: 'words', is: ['lte', maxWords] });
  if (minVolume) and.push({ field: 'volume', is: ['gte', minVolume] });
  if (maxVolume) and.push({ field: 'volume', is: ['lte', maxVolume] });

  // Ahrefs returns at most PAGE_SIZE rows per request whatever `limit` says
  // (checked October 2026: limit 150 gave 100). Page with a keyset cursor on
  // (volume desc, keyword asc): each request asks for rows after the last one.
  const rows = [];
  let cursor = null;
  while (rows.length < limit) {
    const where = cursor
      ? { and: [...and, { or: [{ field: 'volume', is: ['lt', cursor.volume] }, { and: [{ field: 'volume', is: ['eq', cursor.volume] }, { field: 'keyword', is: ['gt', cursor.keyword] }] }] }] }
      : { and };
    const want = Math.min(PAGE_SIZE, limit - rows.length);
    const body = await get('/site-explorer/organic-keywords', {
      target,
      mode: 'subdomains',
      country,
      date: new Date().toISOString().slice(0, 10),
      select: 'keyword,entities,best_position,best_position_url,volume',
      where: JSON.stringify(where),
      order_by: 'volume:desc,keyword:asc',
      limit: want,
    });
    const page = body.keywords ?? [];
    rows.push(...page);
    const last = page.at(-1);
    // A short page is the end; so is a row with no volume to page past.
    if (page.length < want || !last || last.volume == null) break;
    cursor = { volume: last.volume, keyword: last.keyword };
  }
  return rows.map((k) => ({
    keyword: k.keyword,
    people: (k.entities ?? []).filter((e) => e.category === 'Person').map((e) => e.name),
    orgs: (k.entities ?? []).filter((e) => e.category === 'Organization').map((e) => e.name),
    volume: k.volume ?? 0,
    position: k.best_position,
    url: k.best_position_url,
  }));
}

// batch-analysis: up to 100 URLs per request. Measured October 2026: 8 units
// per URL with index, url, url_rating and refdomains selected (75 URLs cost
// 600; 7 each without index), and at least 50 units a request (2 URLs cost
// 50). Runs log the measured cost.
export const BATCH_SIZE = 100;
export const UNITS_PER_PAGE = 8;
export const MIN_UNITS_PER_REQUEST = 50;
export function pageUnitsFor(n) {
  let units = 0;
  for (let left = n; left > 0; left -= BATCH_SIZE) units += Math.max(MIN_UNITS_PER_REQUEST, Math.min(left, BATCH_SIZE) * UNITS_PER_PAGE);
  return units;
}

/** Ahrefs echoes URLs without the scheme ("www.x.com/p/"); compare on that. */
const bare = (u) => String(u ?? '').replace(/^https?:\/\//i, '').replace(/#.*$/, '').toLowerCase();

/** URL rating and referring domains per exact URL, as a Map keyed by URL. */
export async function pageMetrics(urls) {
  if (!hasKey()) throw new Error('AHREFS_API_KEY is not set in .env');
  const out = new Map();
  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    const chunk = urls.slice(i, i + BATCH_SIZE);
    const res = await fetch(`${BASE}/batch-analysis/batch-analysis`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.AHREFS_API_KEY}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      // `index` is only returned when selected.
      body: JSON.stringify({ select: ['index', 'url', 'url_rating', 'refdomains'], targets: chunk.map((url) => ({ url, mode: 'exact', protocol: 'both' })) }),
      signal: AbortSignal.timeout(180000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Ahrefs batch-analysis: HTTP ${res.status} ${body?.error ?? ''}`.trim());
    const byBare = new Map(chunk.map((u) => [bare(u), u]));
    for (const t of body?.targets ?? []) {
      // `index` is the position in the request; otherwise match the echo.
      const url = Number.isInteger(t.index) ? chunk[t.index] : byBare.get(bare(t.url));
      if (url) out.set(url, { urlRating: t.url_rating ?? null, refdomains: t.refdomains ?? null });
    }
  }
  return out;
}
