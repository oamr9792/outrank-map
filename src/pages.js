import { getStudy, listPicks, loadStudyData, getPageMetrics, savePageAhrefs, savePageDate } from './db.js';
import { domainDetail } from './score.js';
import * as ahrefs from './ahrefs.js';
import * as dfs from './dataforseo.js';

/**
 * Why winning pages win (brief item 4). For a study's shortlisted domains:
 * whether their winning pages have links of their own, how old they were
 * when they won, and whether the person's name is in the title and URL.
 * Paid lookups run only for those pages and are cached by URL.
 */

// --- page dates -----------------------------------------------------------------

const iso = (y, m, d = 1) => {
  const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (Number.isNaN(dt.getTime()) || dt.getUTCFullYear() < 1995 || dt > new Date(Date.now() + 864e5)) return null;
  return dt.toISOString().slice(0, 10);
};

/** A date written into the URL path: /2024/03/15/…, /2024-03-15-…, /2024/03/… */
export function urlDate(url) {
  let p;
  try {
    p = new URL(url).pathname;
  } catch {
    return null;
  }
  const m = p.match(/(?:^|\/|-)((?:19|20)\d\d)[/-](0?[1-9]|1[0-2])(?:[/-](0?[1-9]|[12]\d|3[01]))?(?=$|[/-])/);
  return m ? iso(m[1], m[2], m[3] ?? 1) : null;
}

/**
 * The published date a page states about itself, preferring structured data:
 * JSON-LD datePublished, then meta tags (article:published_time and friends),
 * then the first <time datetime>.
 */
export function htmlDate(html = '') {
  const parse = (s) => {
    const m = String(s ?? '').match(/((?:19|20)\d\d)-(\d\d)-(\d\d)/);
    return m ? iso(m[1], m[2], m[3]) : null;
  };
  const ld = html.match(/"datePublished"\s*:\s*"([^"]+)"/i);
  if (ld && parse(ld[1])) return { date: parse(ld[1]), source: 'jsonld' };
  const metaRe = /<meta\b[^>]*>/gi;
  for (const tag of html.match(metaRe) ?? []) {
    if (!/(article:published_time|og:published_time|datePublished|pubdate|publish[-_]?date|date\.published|sailthru\.date|parsely-pub-date|dc\.date)/i.test(tag)) continue;
    const content = tag.match(/content\s*=\s*["']([^"']+)["']/i)?.[1];
    if (parse(content)) return { date: parse(content), source: 'meta' };
  }
  const t = html.match(/<time\b[^>]*datetime\s*=\s*["']([^"']+)["']/i);
  if (t && parse(t[1])) return { date: parse(t[1]), source: 'time' };
  return null;
}

// --- name in title / URL ----------------------------------------------------------

const fold = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const tokens = (name) => fold(name).split(/[^a-z0-9]+/).filter((t) => t.length > 1);

/** Whether every part of the person's name appears in the title / the URL path. */
export function nameIn(name, { title = '', url = '' } = {}) {
  const parts = tokens(name);
  if (!parts.length) return { title: false, slug: false };
  const t = new Set(tokens(title));
  let path = '';
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    /* leave empty */
  }
  const slug = new Set(tokens(path));
  // Slugs often run names together ("janedoe"), so also test the joined form.
  const joined = fold(path).replace(/[^a-z0-9]/g, '');
  return { title: parts.every((p) => t.has(p)), slug: parts.every((p) => slug.has(p)) || joined.includes(parts.join('')) };
}

// --- explanation per domain -------------------------------------------------------

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const monthsBetween = (from, to) => (Date.parse(to) - Date.parse(from)) / (30.44 * 864e5);
const pctText = (x) => `${Math.round(x * 100)}%`;

/**
 * Pure: the explanation for one domain from its winning drill-down rows and
 * the page metrics known so far. Every figure carries how many wins it rests
 * on, since links or dates can be unknown for some pages.
 */
export function explainDomain(winRows, metrics) {
  const m = (url) => metrics.get(url) ?? {};
  const n = winRows.length;
  const linked = winRows.filter((r) => m(r.them.url).refdomains != null);
  const noLinks = linked.filter((r) => m(r.them.url).refdomains === 0).length;
  const ages = winRows
    .map((r) => (m(r.them.url).published_at && r.serpAt ? monthsBetween(m(r.them.url).published_at, r.serpAt) : null))
    .filter((a) => a !== null && a >= 0);
  const names = winRows.map((r) => nameIn(r.people?.[0] ?? r.keyword, { title: r.them.title, url: r.them.url }));
  const targetRd = winRows.map((r) => m(r.target.url).refdomains).filter((x) => x != null);
  const winRd = linked.map((r) => m(r.them.url).refdomains);
  const out = {
    wins: n,
    linksKnown: linked.length,
    noLinkShare: linked.length ? noLinks / linked.length : null,
    medianRefdomains: median(winRd),
    targetMedianRefdomains: median(targetRd),
    agesKnown: ages.length,
    medianAgeMonths: median(ages),
    nameInTitleShare: n ? names.filter((x) => x.title).length / n : null,
    nameInSlugShare: n ? names.filter((x) => x.slug).length / n : null,
  };
  out.sentence = sentence(out);
  return out;
}

function sentence(e) {
  if (!e.wins) return 'No wins to explain.';
  const bits = [];
  if (e.noLinkShare != null) bits.push(`Wins ${pctText(e.noLinkShare)} of the time with pages that have no external links`);
  if (e.medianAgeMonths != null) bits.push(`median page age ${Math.round(e.medianAgeMonths)} month${Math.round(e.medianAgeMonths) === 1 ? '' : 's'}`);
  bits.push(`name in the title ${pctText(e.nameInTitleShare)} of the time`);
  bits.push(`in the URL ${pctText(e.nameInSlugShare)}`);
  let s = `${bits.join(', ')}.`;
  s = s[0].toUpperCase() + s.slice(1);
  const rd = (n) => `${n} referring domain${n === 1 ? '' : 's'}`;
  if (e.medianRefdomains != null && e.targetMedianRefdomains != null) s += ` Its winning pages have a median of ${rd(e.medianRefdomains)}; the target pages they beat have ${e.targetMedianRefdomains}.`;
  const gaps = [];
  if (e.linksKnown < e.wins) gaps.push(`links known for ${e.linksKnown} of ${e.wins} wins`);
  if (e.agesKnown < e.wins) gaps.push(`age known for ${e.agesKnown}`);
  if (gaps.length) s += ` (${gaps.join('; ')}.)`;
  return s;
}

// --- the run ---------------------------------------------------------------------

/** The pages to look up: each shortlisted domain's winning pages, plus the target's page in those contests. */
function pagesFor(studyId) {
  const study = getStudy(studyId);
  const data = loadStudyData(studyId);
  const byDomain = new Map();
  const urls = new Set();
  for (const p of listPicks(studyId)) {
    const wins = domainDetail(data, study.target, p.domain).filter((r) => r.outcome === 'win');
    byDomain.set(p.domain, wins);
    for (const r of wins) {
      urls.add(r.them.url);
      urls.add(r.target.url);
    }
  }
  return { study, byDomain, urls: [...urls] };
}

/** What a run would cost, counting only pages not already cached. */
export function estimateExplain(studyId) {
  const { byDomain, urls } = pagesFor(studyId);
  const cached = getPageMetrics(urls);
  const needAhrefs = urls.filter((u) => !cached.get(u)?.ahrefs_at);
  const needDate = urls.filter((u) => !cached.get(u)?.date_at);
  const needHtml = needDate.filter((u) => !urlDate(u));
  return {
    domains: byDomain.size,
    pages: urls.length,
    cached: urls.length - new Set([...needAhrefs, ...needDate]).size,
    ahrefsPages: needAhrefs.length,
    ahrefsUnits: ahrefs.pageUnitsFor(needAhrefs.length),
    htmlPages: needHtml.length,
    dataforseoUsd: +(needHtml.length * dfs.USD_PER_HTML_PAGE).toFixed(3),
  };
}

export async function runExplain(studyId, log) {
  const est = estimateExplain(studyId);
  if (!est.domains) throw new Error('Shortlist (star) at least one domain first');
  const { urls } = pagesFor(studyId);
  const cached = getPageMetrics(urls);

  const needAhrefs = urls.filter((u) => !cached.get(u)?.ahrefs_at);
  if (needAhrefs.length) {
    const before = await ahrefs.unitsLeft();
    log(`Ahrefs: ${needAhrefs.length} pages, est. ${est.ahrefsUnits.toLocaleString()} units; ${before.remaining.toLocaleString()} left`);
    if (est.ahrefsUnits > before.remaining) throw new Error(`Not enough Ahrefs units: need about ${est.ahrefsUnits.toLocaleString()}, ${before.remaining.toLocaleString()} left until ${before.resetDate}.`);
    const got = await ahrefs.pageMetrics(needAhrefs);
    // Only pages Ahrefs answered for are marked done; the rest retry next run.
    for (const [u, m] of got) savePageAhrefs(u, m);
    if (got.size < needAhrefs.length) log(`Ahrefs: no row for ${needAhrefs.length - got.size} pages; they will be retried`);
    const after = await ahrefs.unitsLeft().catch(() => null);
    if (after) log(`Ahrefs: ${got.size} pages back; measured ${(after.used - before.used).toLocaleString()} units`);
  }

  const needDate = urls.filter((u) => !cached.get(u)?.date_at);
  let fromUrl = 0, fromHtml = 0, none = 0;
  dfs.resetSpend();
  const html = [];
  for (const u of needDate) {
    const d = urlDate(u);
    if (d) {
      savePageDate(u, { publishedAt: d, source: 'url' });
      fromUrl++;
    } else html.push(u);
  }
  if (html.length) log(`Reading published dates from ${html.length} pages via DataForSEO (~$${(html.length * dfs.USD_PER_HTML_PAGE).toFixed(3)}, cap $${dfs.budget()})…`);
  let i = 0;
  let stop = null;
  async function worker() {
    while (!stop && i < html.length) {
      const u = html[i++];
      try {
        const { html: page, cost } = await dfs.rawHtml(u);
        const found = htmlDate(page);
        savePageDate(u, { publishedAt: found?.date, source: found?.source ?? 'none', cost });
        found ? fromHtml++ : none++;
      } catch (err) {
        if (err instanceof dfs.BudgetError || err.fatal) {
          stop = err;
          break;
        }
        savePageDate(u, { source: 'none', error: err.message });
        none++;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Number(process.env.SERP_CONCURRENCY || 8)) }, worker));
  log(`Dates: ${fromUrl} from the URL, ${fromHtml} from the page, ${none} not found; $${dfs.spentUsd().toFixed(3)} spent`);
  if (stop) throw stop;
}

/** Explanations for every shortlisted domain, from cached metrics only (free). */
export function explanations(studyId) {
  const { byDomain, urls } = pagesFor(studyId);
  const metrics = getPageMetrics(urls);
  return Object.fromEntries([...byDomain].map(([domain, wins]) => [domain, explainDomain(wins, metrics)]));
}
