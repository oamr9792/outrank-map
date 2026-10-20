/**
 * Rule-based labels. All three are heuristics and say so in the UI; they are
 * there to sort and filter, not to be quoted as findings.
 */

/**
 * Whether a headline reads as negative coverage of its subject, and what
 * kind. Matches on whole words; deliberately biased towards recall, since the
 * flag narrows a set and a human reads the result.
 *
 * Grouped by the kind of trouble, which is what a client conversation turns
 * on (a lawsuit and a regulatory fine call for different responses). The
 * `unspecified` words say something is wrong without saying what; a headline
 * matching only those gets that category, and any specific word elsewhere in
 * the headline takes precedence ("accused of fraud" is legal-criminal).
 */
export const NEGATIVE_CATEGORIES = {
  'legal-criminal': [
    'fraud', 'fraudulent', 'scam', 'scheme', 'ponzi', 'indicted', 'indictment', 'charged', 'charges', 'arrest', 'arrested',
    'convicted', 'conviction', 'guilty', 'sentenced', 'sentence', 'sentences', 'prison', 'jail', 'plea', 'pleads', 'pleaded',
    'trafficking', 'bribery', 'bribe', 'embezzle', 'embezzlement', 'laundering', 'tax evasion', 'stole', 'theft', 'raid',
    'raided', 'fbi', 'doj',
  ],
  'civil-litigation': [
    'lawsuit', 'lawsuits', 'sue', 'sues', 'sued', 'suing', 'countersues', 'settle', 'settles', 'settlement', 'dispute',
    'feud', 'battle', 'clash', 'judgment', 'contempt',
  ],
  'financial-distress': [
    'foreclosure', 'foreclose', 'forecloses', 'default', 'defaults', 'defaulted', 'bankrupt', 'bankruptcy', 'chapter 11',
    'liens', 'lien', 'unpaid', 'owes', 'collapse', 'collapses', 'distressed', 'liquidation', 'receivership', 'evict',
    'evicts', 'eviction', 'evictions',
  ],
  regulatory: [
    'fined', 'penalty', 'violations', 'violation', 'banned', 'barred', 'disbarred', 'revoked', 'expelled', 'sanctioned',
    'censured', 'sec', 'finra', 'attorney general', 'subpoena',
  ],
  conduct: ['harassment', 'misconduct', 'scandal', 'fired', 'ousted', 'resigns', 'discrimination', 'deceptive', 'lied', 'cheated', 'whistleblower'],
  'reputation-opinion': ['worst', 'slumlord', 'troubled'],
  unspecified: ['accused', 'accuses', 'alleged', 'allegedly', 'allegations', 'allege', 'alleges', 'probe', 'investigation', 'investigated'],
};

const WORD_CATEGORY = new Map(Object.entries(NEGATIVE_CATEGORIES).flatMap(([cat, words]) => words.map((w) => [w, cat])));
const NEG_RE = new RegExp(`\\b(${[...WORD_CATEGORY.keys()].map((w) => w.replace(/ /g, '\\s+')).join('|')})\\b`, 'gi');

/** { word, category } for a negative headline, or null. */
export function negativeTitle(title = '') {
  let generic = null;
  for (const m of String(title).matchAll(NEG_RE)) {
    const word = m[1].toLowerCase().replace(/\s+/g, ' ');
    const category = WORD_CATEGORY.get(word);
    if (category !== 'unspecified') return { word, category };
    generic ??= { word, category };
  }
  return generic;
}

/** What kind of page a URL is, from its host and path alone. */
export function pageType(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return 'other';
  }
  const host = u.hostname.replace(/^www\./, '');
  const p = u.pathname.toLowerCase();
  if (/(^|\.)(youtube\.com|youtu\.be|vimeo\.com)$/.test(host) || /\/video(s)?\//.test(p)) return 'video';
  if (/(^|\.)(x\.com|twitter\.com|facebook\.com|instagram\.com|tiktok\.com|threads\.net)$/.test(host)) return 'social';
  if (/(^|\.)(wikipedia\.org|wikidata\.org)$/.test(host)) return 'wiki';
  if (/(^|\.)(reddit\.com|quora\.com)$/.test(host)) return 'forum';
  if (/(^|\.)linkedin\.com$/.test(host)) return /\/(pulse|posts)\//.test(p) ? 'article' : 'profile';
  if (/\/(people|person|profile|profiles|bio|bios|team|leadership|our-team|about|staff|speakers?|ny-speakers|executives?|directory|agent|agents|broker|brokers|lawyers?|attorneys?)(\/|$)/.test(p) || /(^|\.)(crunchbase\.com|zoominfo\.com|rocketreach\.co|theorg\.com|prabook\.com|muckrack\.com|imdb\.com|bloomberg\.com\/profile)/.test(host + p)) return 'profile';
  if (/\/(19|20)\d\d\/\d{1,2}\//.test(p) || /\/(news|article|articles|story|stories|blog|insights|press|press-release|press-releases|sites)\//.test(p)) return 'article';
  const slug = p.split('/').filter(Boolean).pop() ?? '';
  if (slug.split('-').length >= 4) return 'article';
  return 'other';
}

/**
 * How a client could get content onto a domain. Only domains with an
 * unambiguous answer are listed; everything else is left for a human.
 */
const ACCESS = [
  ['self-publish', /(^|\.)(linkedin\.com|medium\.com|substack\.com|youtube\.com|x\.com|twitter\.com|facebook\.com|instagram\.com|tiktok\.com|threads\.net|github\.com|about\.me|pinterest\.com|soundcloud\.com|vimeo\.com|wordpress\.com|blogspot\.com|tumblr\.com)$/],
  ['profile / directory', /(^|\.)(crunchbase\.com|muckrack\.com|theorg\.com|zoominfo\.com|rocketreach\.co|prabook\.com|pitchbook\.com|apollo\.io|signalhire\.com|bizjournals\.com|f6s\.com|angel\.co|wellfound\.com|imdb\.com|ballotpedia\.org|opencorporates\.com)$/],
  ['community', /(^|\.)(reddit\.com|quora\.com)$/],
  ['reference', /(^|\.)(wikipedia\.org|wikidata\.org|britannica\.com)$/],
  ['press release', /(^|\.)(prnewswire\.com|businesswire\.com|globenewswire\.com|accesswire\.com|einpresswire\.com|newswire\.com|prweb\.com)$/],
];

export function accessTag(domain) {
  for (const [tag, re] of ACCESS) if (re.test(domain)) return tag;
  return null;
}

/** First path segment, for "which section of the site wins" rollups. */
export function section(url) {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean)[0];
    return seg && !/^\d+$/.test(seg) && seg.length < 40 ? `/${seg}/` : '/';
  } catch {
    return '/';
  }
}
