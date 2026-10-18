/**
 * Rule-based labels. All three are heuristics and say so in the UI; they are
 * there to sort and filter, not to be quoted as findings.
 */

/**
 * Whether a headline reads as negative coverage of its subject. Matches on
 * whole words and stems; deliberately biased towards recall, since the filter
 * it feeds narrows a set and a human reads the result.
 */
const NEGATIVE = [
  'lawsuit', 'lawsuits', 'sue', 'sues', 'sued', 'suing', 'fraud', 'fraudulent', 'scam', 'scheme', 'ponzi',
  'indicted', 'indictment', 'charged', 'charges', 'arrest', 'arrested', 'convicted', 'conviction', 'guilty',
  'sentenced', 'sentence', 'sentences', 'prison', 'jail', 'plea', 'pleads', 'pleaded', 'trafficking', 'probe', 'investigation',
  'investigated', 'subpoena', 'accused', 'accuses', 'alleged', 'allegedly', 'allegations', 'allege', 'alleges',
  'foreclosure', 'foreclose', 'forecloses', 'default', 'defaults', 'defaulted', 'bankrupt', 'bankruptcy', 'chapter 11',
  'evict', 'evicts', 'eviction', 'evictions', 'violations', 'violation', 'fined', 'penalty', 'settle', 'settles',
  'settlement', 'dispute', 'feud', 'battle', 'clash', 'ousted', 'fired', 'resigns', 'scandal', 'misconduct', 'harassment',
  'discrimination', 'bribery', 'bribe', 'embezzle', 'embezzlement', 'laundering', 'tax evasion', 'liens', 'lien',
  'unpaid', 'owes', 'collapse', 'collapses', 'troubled', 'distressed', 'slumlord', 'worst', 'banned', 'barred',
  'disbarred', 'revoked', 'expelled', 'deceptive', 'lied', 'cheated', 'stole', 'theft', 'raid', 'raided', 'fbi', 'sec',
  'doj', 'attorney general', 'whistleblower', 'countersues', 'judgment', 'contempt', 'liquidation', 'receivership',
];
const NEG_RE = new RegExp(`\\b(${NEGATIVE.map((w) => w.replace(/ /g, '\\s+')).join('|')})\\b`, 'i');

export function negativeTitle(title = '') {
  const m = String(title).match(NEG_RE);
  return m ? m[1].toLowerCase() : null;
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
