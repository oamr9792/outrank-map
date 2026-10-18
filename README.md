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
4. **Scopes.** *All person searches*; *target page reads negative* (headline
   matches a lawsuit/fraud/sentenced/foreclosure… lexicon — the closest
   analogue to a client's situation); *target page is an article*.
5. **Drill-down.** Click a domain for every shared search: its URL and title
   vs the target's, win or loss.

**Saved work.** Name a study and add notes; star domains to shortlist them,
with a note each; **Report** shows the shortlist with each domain's stats and
winning pages, printable to PDF. All of it is stored in the database.

**Hosting.** See [DEPLOY.md](DEPLOY.md) (Render, password-protected). Locally
on 127.0.0.1 with no `APP_PASSWORD` the login is skipped.

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
