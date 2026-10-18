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
 * @param o.words      exact word count of the keyword (2 = "first last")
 * @param o.maxPosition only keywords where the target ranks at or above this
 * @param o.minVolume / o.maxVolume  volume band; the cap trims celebrities
 */
export async function personKeywords(target, { country = 'us', limit = 500, words = 2, maxPosition = 20, minVolume = 0, maxVolume = 0 } = {}) {
  const and = [
    { not: { field: 'person_entities', is: 'empty' } },
    { field: 'best_position', is: ['lte', maxPosition] },
    // Organic positions only. Without this, best_position includes Top
    // stories carousels: a news piece from this week reads as "#1" but is
    // gone from the live organic results, so the keyword is no contest.
    { field: 'is_main_position', is: ['eq', true] },
  ];
  if (words) and.push({ field: 'words', is: ['eq', words] });
  if (minVolume) and.push({ field: 'volume', is: ['gte', minVolume] });
  if (maxVolume) and.push({ field: 'volume', is: ['lte', maxVolume] });

  const body = await get('/site-explorer/organic-keywords', {
    target,
    mode: 'subdomains',
    country,
    date: new Date().toISOString().slice(0, 10),
    select: 'keyword,entities,best_position,best_position_url,volume',
    where: JSON.stringify({ and }),
    order_by: 'volume:desc',
    limit,
  });
  return (body.keywords ?? []).map((k) => ({
    keyword: k.keyword,
    people: (k.entities ?? []).filter((e) => e.category === 'Person').map((e) => e.name),
    orgs: (k.entities ?? []).filter((e) => e.category === 'Organization').map((e) => e.name),
    volume: k.volume ?? 0,
    position: k.best_position,
    url: k.best_position_url,
  }));
}
