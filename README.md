# outrank-map

Finds the domains that most regularly outrank a target domain (e.g. a site
carrying negative coverage of a client) on **person-name searches** — the
searches shaped like the client's own. A domain that beats the target on
hundreds of other people's names is a good bet to beat it on the client's
name too, if it carried a piece about them.

## How it works

1. **Ahrefs** (`site-explorer/organic-keywords`) lists the target's ranking
   keywords that contain a person entity, filtered to a word-count range
   (default 2–2 — "first last"; 2–4 adds "name + employer" searches), a target position ceiling and an optional
   volume band, organic positions only (Top stories carousel hits are
   excluded — they rarely survive to the live organic results). ~15 API
   units per keyword; the run refuses to start if the
   key's remaining monthly units would not cover it.
2. **DataForSEO** (`serp/google/organic/live/advanced`) pulls the live Google
   organic results for each keyword (~$0.0016 per 10 results fetched, so
   ~$0.005 at the default depth of 30); capped per run by
   `DATAFORSEO_MAX_USD`. Resumable: stop, raise the cap, press *Resume / retry*.
3. **Scoring.** Each keyword where the target is still in the live results is
   a contest. Per domain:
   - **Wins** — contests where its best organic result is above the target's
   - **Reach** — wins ÷ all contests in scope ("how regularly it outranks")
   - **Head-to-head** — wins ÷ contests where both appear
   - **Distinct people**, **avg gap** (positions above), **top-3 wins**,
     **volume won**, winning **page types** and winning site **sections**
4. **Situation profile and weighted reach.** Each contest gets a weight, 0
   to 1, for how much it looks like the client's case: the target page's type
   (0.4), its position within ±3 of the client's negative page (0.3), the
   keyword's volume band (0.2) and the negative category (0.1). Only the parts
   the profile sets count, normalised over those. **Weighted reach** = Σ weight
   of contests won ÷ Σ weight of all contests; it is the default sort, shown
   beside plain reach, with "effective contests" (Σ weights) as its sample
   size. The old scopes are presets: *All* (no weighting), *Target page reads
   negative* and *Target page is an article* each set one part, so their
   weighted reach equals the old filtered reach. A study can save its own
   profile; in the client flow each host is weighted by its own negative URL
   plus the name's volume band (picked by hand, or fetched for ~$0.075).
5. **Drill-down.** Click a domain for every shared search: its URL and title
   vs the target's, win or loss, and the contest's weight with which parts
   matched.

**Client flow.** Start from a person instead of a domain: enter the client's
name (and optionally known negative URLs). The app pulls the live name SERP
(depth 30, ~$0.005), flags headlines that match the negative word list, and
you tick which results are the problem. Each problem URL's host gets a study:
a finished study of the same domain and country is reused for free (tick
*Re-run fresh* to replace it), otherwise a new one runs through the same
`createStudy` / `fetchSerps`. The merged leaderboard scores each domain by its
reach against the host it does worst against, with a column per host; hosts
with fewer than 10 contests get a column but are left out of that minimum.
Domains already in the client's name SERP are marked ★ (properties to
strengthen) and sort first at equal score.

**Saved work.** Name a study and add notes; star domains to shortlist them,
with a note each; **Report** shows the shortlist with each domain's stats and
winning pages, printable to PDF. All of it is stored in the database.

**Hosting.** See [DEPLOY.md](DEPLOY.md) (Render, password-protected). Locally
on 127.0.0.1 with no `APP_PASSWORD` the login is skipped.

**Does the target fade on its own?** For up to 30 contests in scope (weight
above 0 under the profile), highest volume first, the study pulls 12 months
of monthly Google snapshots (DataForSEO Labs historical SERPs, ~$0.0014 a
search at the listed price; the real charge is logged and capped like
`fetchSerps`). It charts the target's median position by month and gives one
number: the median change between the latest month and six months before.
A month where the target is missing counts as just below the last result,
so dropping out shows as decay. Stored per study, shown in the report.

**Why winning pages win.** *Explain shortlist* looks up, for each starred
domain's winning pages and the target pages they beat: URL rating and
referring domains (Ahrefs `batch-analysis`, 100 URLs a request) and the
publish date (from the URL when it carries one, otherwise the page's own
JSON-LD / meta / `<time>` tags read through DataForSEO, ~$0.00015 a page).
The confirm dialog shows the cost first; results are cached by URL in
`page_metrics`, so nothing is paid for twice. The domain's drill-down and the
report then say, e.g., "Wins 71% of the time with pages that have no external
links, median page age 14 months, name in the title 92% of the time", with
how many wins each figure rests on. Name-in-title / URL needs no lookup.

**Negative categories.** The headline word list in `src/classify.js` is
grouped into legal-criminal, civil-litigation, financial-distress,
regulatory, conduct and reputation-opinion; `negativeTitle()` returns the
matched word and its category. Generic words (accused, alleged, probe,
investigation) are *unspecified*: they flag a headline, but any specific word
in it decides the category, and on their own they match "any negative
headline" in a profile. The study summary counts contests per category, and
the profile can weight by one.

Access tags (self-publish, profile/directory, press release, reference,
community) are a fixed list in `src/classify.js`; untagged domains are
earned media or unknown.

## Run

```
cp .env.example .env    # fill in AHREFS_API_KEY and DataForSEO
npm start               # http://127.0.0.1:8801
npm test
```

Zero npm dependencies; Node 22 (`node:sqlite`). Data lives in `data/`.

## Caveats

- This is an inference from analogous searches, not a guarantee: ranking for
  a specific name also depends on the page's links, freshness and focus.
- Page type and the negative flag are rule-based guesses from URL and title.
- Ahrefs positions can be stale; the live SERP is what's scored. "Target gone"
  counts keywords where the target has since dropped out of the fetched depth.
