/**
 * Plain-English help for every metric and setting: what it is, and what to
 * use it for. One source for the ⓘ popovers; the Guide page (guide.md)
 * uses the same words.
 */
export const HELP = {
  // --- leaderboard columns ------------------------------------------------------------
  weightedReach: {
    name: 'Weighted reach',
    what: 'Out of all the searches we tested, how often this site showed up above the target. Searches that look like your client’s situation count more than ones that don’t.',
    use: 'Your main ranking. Use it to decide which sites to put content on first.',
  },
  reach: {
    name: 'Reach',
    what: 'The same as weighted reach, but every search counts equally.',
    use: 'A sanity check. If reach is high but weighted reach is low, the site mostly wins on searches that don’t look like your client’s.',
  },
  wins: {
    name: 'Wins',
    what: 'How many searches this site ranked above the target.',
    use: 'The raw count behind reach. Read it together with reach: lots of wins and low reach means the site just shows up a lot.',
  },
  rawWinRate: {
    name: 'Head-to-head',
    what: 'When this site and the target both show up on the same search, how often this site is higher.',
    use: 'Who wins a straight fight. High head-to-head with low reach means it’s strong when it has a page, but often has none. The page has to exist first.',
  },
  appearances: {
    name: 'Seen with target',
    what: 'How many searches had both this site and the target in the results.',
    use: 'Sample size. Don’t trust a 100% head-to-head that rests on 2 searches.',
  },
  people: {
    name: 'Distinct people',
    what: 'How many different people’s names this site won on.',
    use: 'Breadth. A site that wins for 80 different people is a safer bet for your client than one that wins 80 times for one famous person.',
  },
  avgGap: {
    name: 'Avg gap',
    what: 'On the searches it wins, how many places above the target it lands, on average.',
    use: 'Cushion. Winning by 1 place can flip next month; winning by 8 places is solid.',
  },
  top3Wins: {
    name: 'Top-3 wins',
    what: 'Wins where this site was in the top 3 results.',
    use: 'The top 3 is where people click. Use it to find sites that push the target down where it actually matters.',
  },
  volumeWon: {
    name: 'Volume won',
    what: 'Add up the monthly searches of every name this site won on.',
    use: 'A tie-breaker that favours wins on names people actually search for.',
  },
  access: {
    name: 'Access',
    what: 'How you could get content onto this site. Self-publish: you can post it yourself. Profile / directory: create or claim a listing. Press release: a wire service. Reference: Wikipedia and similar. Community: Reddit, Quora. Court / public record: dockets and filings. News: mostly articles, so it needs a pitch to an editor. Blank: unknown.',
    use: 'Turns the list into a to-do list. Self-publish can happen today; news needs PR; court records are a competitor, not a placement.',
  },
  types: {
    name: 'Winning page types',
    what: 'What kind of page wins for this site: profile, article, video, social post, court record, homepage and so on. A guess from the web address.',
    use: 'Tells you what to make. If a site wins with profile pages, build a profile there, not an article.',
  },
  sections: {
    name: 'Winning sections',
    what: 'The part of the site the winning pages live in, like /profile/ or /news/.',
    use: 'Points at the exact section to aim for when you pitch or publish.',
  },
  picked: {
    name: 'Shortlist (★)',
    what: 'Your picks. Star a domain to add it to the shortlist, with a note.',
    use: 'Starred domains go into the report and are the only ones “Explain shortlist” spends money on.',
  },

  // --- study summary --------------------------------------------------------------------
  contests: {
    name: 'Contests',
    what: 'A search where the target still shows up in today’s Google results, so there’s a fair fight to score.',
    use: 'How much evidence the study rests on. More is better; under about 30, read everything as a hint.',
  },
  effectiveContests: {
    name: 'Effective contests',
    what: 'The contests counted by how much each looks like your client’s situation (the sum of the weights).',
    use: 'The real sample size behind weighted reach. Under about 10, the weighted numbers are a hint, not a verdict.',
  },
  targetAvgPosition: {
    name: 'Target’s avg position',
    what: 'Where the target usually sits on these searches.',
    use: 'How hard the target is to beat. Averaging #3 is tough; averaging #15 is easy.',
  },
  targetTop3: {
    name: 'Target in top 3',
    what: 'How many of these searches have the target in the top 3.',
    use: 'Shows how often it holds the clickable spots.',
  },
  negativeContests: {
    name: 'Target page reads negative',
    what: 'Searches where the target’s page has a headline with words like “sued”, “indicted” or “foreclosure”, split by kind of trouble. A rule-based guess.',
    use: 'These are the searches most like your client’s case. Use the category to match like for like: a lawsuit story against lawsuit stories.',
  },
  targetAbsent: {
    name: 'Target gone',
    what: 'Searches where Ahrefs said the target ranked, but today’s Google results don’t show it.',
    use: 'A freshness check. Many of these mean the target is losing ground, or Ahrefs is out of date.',
  },
  medianDrift: {
    name: 'Median drift',
    what: 'How far today’s position is from the one Ahrefs reported. + means the target has slipped since Ahrefs looked.',
    use: 'How much to trust Ahrefs’ numbers for this site. The scores use today’s results either way.',
  },

  // --- situation profile ---------------------------------------------------------------
  profile: {
    name: 'Situation profile',
    what: 'A description of your client’s problem page: its type, its position, how often the name is searched, and the kind of trouble. Each search is weighted by how much it looks like that.',
    use: 'Makes the ranking about your client’s case, not every case. Set it once per study, or let the client page set it from the problem URL.',
  },
  pageType: {
    name: 'Page type (profile)',
    what: 'The kind of page your client’s problem is: a news article, a profile page, a forum post…',
    use: 'Counts most (0.4). A site that beats news articles may not beat profile pages.',
  },
  position: {
    name: 'Target at # (profile)',
    what: 'Where the problem page sits on your client’s results. Searches where the target sits within 3 places of that count more.',
    use: 'Beating a #2 page is a different job from beating a #14 page (0.3).',
  },
  volumeBand: {
    name: 'Volume band',
    what: 'How many times a month people search your client’s name, in bands: under 100, 100–1k, 1k–10k, 10k+.',
    use: 'Famous names behave differently from little-known ones (0.2). Most clients are under 100.',
  },
  category: {
    name: 'Negative category',
    what: 'The kind of trouble in the headline: criminal, lawsuit, money trouble, regulatory, conduct, or opinion.',
    use: 'Match like for like (0.1): a site that buries lawsuit stories may not bury fraud charges.',
  },
  presets: {
    name: 'Presets',
    what: 'Ready-made profiles. All: every search counts the same. Negative: only negative headlines count. Article: only searches where the target’s page is an article count.',
    use: 'Quick ways to look at the same data. Use Custom when you know your client’s situation.',
  },
  weight: {
    name: 'Weight',
    what: 'How much this one search counts, from 0 to 1, by how closely it matches the profile. Hover to see which parts matched.',
    use: 'Explains why a win counted for little: maybe the target’s page there was a profile while your client’s problem is an article.',
  },

  // --- client page -----------------------------------------------------------------------
  merged: {
    name: 'Merged reach',
    what: 'For a client with several bad results, this site’s weighted reach against the hardest one of them.',
    use: 'A placement only helps if it beats every bad result, so this is the number that says whether it can.',
  },
  inNameSerp: {
    name: 'In name results',
    what: 'Where this site already shows up when you Google your client’s name. ★ marks it.',
    use: 'Already there means improve that page, which is cheaper and faster than a new placement. They sort first at equal score.',
  },
  perHost: {
    name: 'vs each bad site',
    what: 'This site’s weighted reach against each bad site separately. The shaded cell is the one it struggles with most.',
    use: 'Shows which bad result will be hardest to push down, and which sites can beat it.',
  },
  hostThin: {
    name: 'Not counted',
    what: 'This bad site ranks for fewer than 10 person searches, so there’s too little evidence about who beats it.',
    use: 'It still gets a column, but it doesn’t drag the merged score to zero.',
  },
  nameVolume: {
    name: 'Name’s search volume',
    what: 'How many times a month people Google your client’s name. Pick a band, or fetch the real figure (one paid call).',
    use: 'Feeds the volume part of the profile. Leave it on “any” if you don’t know.',
  },

  // --- why pages win ---------------------------------------------------------------------
  explain: {
    name: 'Explain shortlist',
    what: 'For starred sites, looks up whether their winning pages have links from other sites, how old they were, and whether the person’s name is in the title and web address. It shows the cost first and never pays for the same page twice.',
    use: 'Tells you what it takes to rank there: whether a fresh page will do, or whether you’ll also need links.',
  },
  noLinkShare: {
    name: 'Wins with no external links',
    what: 'How often this site wins with pages no other website links to.',
    use: 'High means the site’s own strength carries the page: a new page can rank without a link campaign.',
  },
  pageAge: {
    name: 'Median page age',
    what: 'How old the winning pages were when they won.',
    use: 'How long to wait before judging a new placement.',
  },
  nameIn: {
    name: 'Name in title / URL',
    what: 'How often the person’s full name is in the winning page’s headline and web address.',
    use: 'If it’s high, put your client’s full name in both.',
  },
  refdomains: {
    name: 'Referring domains',
    what: 'How many different websites link to a page.',
    use: 'If winners have many and the target’s pages have few, a placement on that site needs links to win.',
  },

  // --- decay --------------------------------------------------------------------------------
  decay: {
    name: 'Does it fade on its own?',
    what: 'Follows the target on its biggest searches over the last 12 months and asks: did it rise or fall over the last ~6 months?',
    use: 'Fading already: less, slower effort may do. Holding or rising: start sooner and push harder.',
  },

  // --- all studies ---------------------------------------------------------------------------
  targetsBeaten: {
    name: 'Targets beaten',
    what: 'How many of the sites you’ve ever studied this domain beat at least once, out of how many it met.',
    use: 'Your house ranking. Domains that beat many different news sites are your reliable go-to placements.',
  },
  allContests: {
    name: 'Contests (all studies)',
    what: 'All the fair fights in the studies this domain appeared in.',
    use: 'The evidence behind its numbers across your whole history.',
  },

  // --- placements & calibration ---------------------------------------------------------------
  placements: {
    name: 'Placements',
    what: 'A log of what you actually published for this client. “Check now” Googles the name once and records where each placement and each bad result sits.',
    use: 'Track whether the work is working. Check every few weeks; nothing runs on its own.',
  },
  predicted: {
    name: 'Predicted',
    what: 'The site’s merged reach at the moment you logged the placement: what the tool expected.',
    use: 'Compared with the outcome later, it tells you whether to trust the tool’s scores.',
  },
  outcome: {
    name: 'Outcome',
    what: 'At the latest check: above every bad result, above some, below all, or not in the top 30.',
    use: '“Above every bad result” is the goal. “Not in top 30” after a few months means rethink the page or the site.',
  },
  calibration: {
    name: 'Calibration',
    what: 'Every checked placement across all clients: what the tool predicted next to what actually happened.',
    use: 'After a few months, this shows whether high scores really lead to wins. Trust the scores more, or less, accordingly.',
  },
};

export function helpIcon(key, label) {
  const h = HELP[key];
  if (!h) return '';
  return `<button type="button" class="help-i noprint" data-help="${key}" aria-label="What is ${h.name}?" title="">i</button>`;
}

/** One popover for the whole page; opens on click/tap or keyboard, closes on Escape or outside click. */
export function installHelp() {
  const pop = document.createElement('div');
  pop.className = 'help-pop';
  pop.setAttribute('role', 'dialog');
  pop.hidden = true;
  document.body.appendChild(pop);
  let openFor = null;
  const close = () => {
    pop.hidden = true;
    openFor = null;
  };
  const open = (btn) => {
    const h = HELP[btn.dataset.help];
    if (!h) return;
    pop.innerHTML = `<b>${h.name}</b><p><span class="k">What it is:</span> ${h.what}</p><p><span class="k">Use it for:</span> ${h.use}</p>`;
    pop.hidden = false;
    const r = btn.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 24);
    pop.style.width = `${w}px`;
    pop.style.left = `${Math.max(12, Math.min(window.innerWidth - w - 12, r.left + window.scrollX - 8))}px`;
    pop.style.top = `${r.bottom + window.scrollY + 6}px`;
    openFor = btn;
  };
  // Capture phase, so a click on an icon inside a sortable header does not sort.
  document.addEventListener(
    'click',
    (e) => {
      const btn = e.target.closest?.('.help-i');
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        openFor === btn ? close() : open(btn);
        return;
      }
      if (!pop.contains(e.target)) close();
    },
    true,
  );
  document.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  window.addEventListener('resize', close);
}
