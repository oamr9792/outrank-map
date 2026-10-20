import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT } from './env.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS studies (
  id INTEGER PRIMARY KEY,
  target TEXT NOT NULL,
  country TEXT NOT NULL,
  params TEXT NOT NULL,          -- JSON: limit, words, maxPosition, minVolume, maxVolume, depth
  created_at TEXT NOT NULL,
  ahrefs_units INTEGER NOT NULL DEFAULT 0,
  dfs_cost REAL NOT NULL DEFAULT 0
);

-- One row per person-name keyword the target ranks for (from Ahrefs).
CREATE TABLE IF NOT EXISTS keywords (
  id INTEGER PRIMARY KEY,
  study_id INTEGER NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  people TEXT NOT NULL,          -- JSON array
  orgs TEXT NOT NULL,            -- JSON array
  volume INTEGER NOT NULL DEFAULT 0,
  ahrefs_position INTEGER,
  ahrefs_url TEXT,
  serp_at TEXT,                  -- null until the live SERP is in
  serp_error TEXT,
  UNIQUE (study_id, keyword)
);

-- The live organic results for each keyword (from DataForSEO).
CREATE TABLE IF NOT EXISTS results (
  keyword_id INTEGER NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  title TEXT NOT NULL,
  PRIMARY KEY (keyword_id, position, url)
);
CREATE INDEX IF NOT EXISTS results_domain ON results(domain);

-- Domains shortlisted from a study for the PR / content plan.
CREATE TABLE IF NOT EXISTS picks (
  study_id INTEGER NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  added_at TEXT NOT NULL,
  PRIMARY KEY (study_id, domain)
);

-- The target's position on each historical monthly snapshot of a keyword
-- (DataForSEO Labs historical SERPs). position is null when the target was
-- not among the snapshot's results_count organic results.
CREATE TABLE IF NOT EXISTS history (
  keyword_id INTEGER NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  snapshot_date TEXT NOT NULL,   -- yyyy-mm-dd
  position INTEGER,
  results_count INTEGER NOT NULL,
  PRIMARY KEY (keyword_id, snapshot_date)
);

-- Page-level facts, keyed by URL so no study pays for the same page twice.
CREATE TABLE IF NOT EXISTS page_metrics (
  url TEXT PRIMARY KEY,
  url_rating REAL,
  refdomains INTEGER,
  ahrefs_at TEXT,                -- null until Ahrefs has been asked
  published_at TEXT,             -- ISO date, when the page states one
  date_source TEXT,              -- url | jsonld | meta | time | none
  date_at TEXT,                  -- null until a date was looked for
  date_error TEXT,
  dfs_cost REAL NOT NULL DEFAULT 0
);

-- A client: a person whose own name SERP carries the negative results.
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  created_at TEXT NOT NULL,
  serp TEXT,                     -- JSON: live organic results for the name
  serp_at TEXT,
  serp_cost REAL NOT NULL DEFAULT 0
);

-- The negative URLs the user confirmed, and the study run against each host.
CREATE TABLE IF NOT EXISTS client_targets (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,          -- the host studied; editable, defaults to the URL's host
  position_seen INTEGER,         -- in the name SERP when confirmed; null if added by hand
  study_id INTEGER REFERENCES studies(id) ON DELETE SET NULL,
  UNIQUE (client_id, url)
);
`;

// Columns added after the first release, applied to older databases.
const MIGRATIONS = [
  'ALTER TABLE studies ADD COLUMN name TEXT',
  "ALTER TABLE studies ADD COLUMN notes TEXT NOT NULL DEFAULT ''",
  // Set on studies the client flow created. A reused study keeps its own
  // (possibly null) client_id; client_targets.study_id is the link either way.
  'ALTER TABLE studies ADD COLUMN client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL',
  // Hand-entered situation profile for the single-domain flow (JSON).
  'ALTER TABLE studies ADD COLUMN profile TEXT',
  // Item 5: the decay summary at the last history fetch (JSON), and its cost.
  'ALTER TABLE studies ADD COLUMN decay TEXT',
  'ALTER TABLE studies ADD COLUMN history_cost REAL NOT NULL DEFAULT 0',
  // The client's name search volume: fetched (volume) or picked by hand (band).
  'ALTER TABLE clients ADD COLUMN volume INTEGER',
  'ALTER TABLE clients ADD COLUMN volume_band INTEGER',
];

let db;

export function openDb(file = process.env.DB_PATH || 'data/outrank-map.db') {
  if (db) return db;
  const full = file === ':memory:' ? file : path.resolve(ROOT, file);
  if (full !== ':memory:') fs.mkdirSync(path.dirname(full), { recursive: true });
  db = new DatabaseSync(full);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 8000;');
  db.exec(SCHEMA);
  for (const sql of MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (err) {
      if (!/duplicate column/i.test(err.message)) throw err;
    }
  }
  return db;
}

export function tx(fn) {
  const d = openDb();
  d.exec('BEGIN');
  try {
    const out = fn(d);
    d.exec('COMMIT');
    return out;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

export function normalizeDomain(input) {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) throw new Error('Enter a domain');
  try {
    return new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./, '');
  } catch {
    throw new Error(`Not a domain: ${input}`);
  }
}

export function listStudies() {
  return openDb()
    .prepare(
      `SELECT s.*, COUNT(k.id) AS keywords, SUM(k.serp_at IS NOT NULL) AS fetched, SUM(k.serp_error IS NOT NULL) AS failed
       FROM studies s LEFT JOIN keywords k ON k.study_id = s.id GROUP BY s.id ORDER BY s.id DESC`,
    )
    .all()
    .map((s) => ({ ...s, params: JSON.parse(s.params) }));
}

export function getStudy(id) {
  const s = openDb().prepare('SELECT * FROM studies WHERE id = ?').get(id);
  return s ? { ...s, params: JSON.parse(s.params), profile: s.profile ? JSON.parse(s.profile) : {}, decay: s.decay ? JSON.parse(s.decay) : null } : null;
}

export function deleteStudy(id) {
  openDb().prepare('DELETE FROM studies WHERE id = ?').run(id);
}

export function updateStudy(id, { name, notes, profile }) {
  const d = openDb();
  if (profile !== undefined) d.prepare('UPDATE studies SET profile = ? WHERE id = ?').run(JSON.stringify(profile ?? {}), id);
  if (name !== undefined) d.prepare('UPDATE studies SET name = ? WHERE id = ?').run(String(name).trim().slice(0, 200) || null, id);
  if (notes !== undefined) d.prepare('UPDATE studies SET notes = ? WHERE id = ?').run(String(notes).slice(0, 20000), id);
}

export const listPicks = (studyId) => openDb().prepare('SELECT domain, note, added_at FROM picks WHERE study_id = ? ORDER BY added_at').all(studyId);

export function savePick(studyId, domain, note) {
  openDb()
    .prepare('INSERT INTO picks (study_id, domain, note, added_at) VALUES (?, ?, ?, ?) ON CONFLICT (study_id, domain) DO UPDATE SET note = excluded.note')
    .run(studyId, String(domain).toLowerCase().slice(0, 253), String(note ?? '').slice(0, 5000), new Date().toISOString());
}

export const removePick = (studyId, domain) => openDb().prepare('DELETE FROM picks WHERE study_id = ? AND domain = ?').run(studyId, String(domain).toLowerCase());

/** Keywords with their SERPs attached, in the shape score.js expects. */
export function loadStudyData(studyId) {
  const d = openDb();
  const keywords = d.prepare('SELECT * FROM keywords WHERE study_id = ? AND serp_at IS NOT NULL').all(studyId);
  const rows = d
    .prepare('SELECT r.* FROM results r JOIN keywords k ON k.id = r.keyword_id WHERE k.study_id = ? ORDER BY r.keyword_id, r.position')
    .all(studyId);
  const byKw = new Map();
  for (const r of rows) {
    if (!byKw.has(r.keyword_id)) byKw.set(r.keyword_id, []);
    byKw.get(r.keyword_id).push(r);
  }
  return keywords.map((k) => ({
    id: k.id,
    keyword: k.keyword,
    people: JSON.parse(k.people),
    orgs: JSON.parse(k.orgs),
    volume: k.volume,
    serpAt: k.serp_at,
    results: byKw.get(k.id) ?? [],
  }));
}

// --- clients -------------------------------------------------------------------

const parseClient = (c) => (c ? { ...c, serp: c.serp ? JSON.parse(c.serp) : null } : null);

export function createClient({ name, country }) {
  const clean = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
  if (!clean) throw new Error("Enter the client's name");
  const { lastInsertRowid } = openDb()
    .prepare('INSERT INTO clients (name, country, created_at) VALUES (?, ?, ?)')
    .run(clean, String(country || 'us').toLowerCase().slice(0, 2), new Date().toISOString());
  return Number(lastInsertRowid);
}

export const getClient = (id) => parseClient(openDb().prepare('SELECT * FROM clients WHERE id = ?').get(id));

export function listClients() {
  return openDb()
    .prepare('SELECT c.id, c.name, c.country, c.created_at, c.serp_at, COUNT(t.id) AS targets FROM clients c LEFT JOIN client_targets t ON t.client_id = c.id GROUP BY c.id ORDER BY c.id DESC')
    .all();
}

export const deleteClient = (id) => openDb().prepare('DELETE FROM clients WHERE id = ?').run(id);

export function saveClientSerp(id, results, cost) {
  openDb().prepare('UPDATE clients SET serp = ?, serp_at = ?, serp_cost = serp_cost + ? WHERE id = ?').run(JSON.stringify(results), new Date().toISOString(), cost, id);
}

export const listTargets = (clientId) => openDb().prepare('SELECT * FROM client_targets WHERE client_id = ? ORDER BY position_seen IS NULL, position_seen, id').all(clientId);

/**
 * Replaces the confirmed negative URLs. A target that is kept keeps its
 * study link unless its host was edited.
 */
export function setTargets(clientId, targets) {
  tx((d) => {
    const old = new Map(listTargets(clientId).map((t) => [t.url, t]));
    d.prepare('DELETE FROM client_targets WHERE client_id = ?').run(clientId);
    const ins = d.prepare('INSERT OR IGNORE INTO client_targets (client_id, url, domain, position_seen, study_id) VALUES (?, ?, ?, ?, ?)');
    for (const t of targets) {
      const url = String(t.url ?? '').trim();
      if (!/^https?:\/\//i.test(url)) throw new Error(`Not a URL: ${t.url}`);
      const domain = normalizeDomain(t.domain || url);
      const prev = old.get(url);
      const pos = Number(t.position) > 0 ? Math.floor(Number(t.position)) : null;
      ins.run(clientId, url, domain, pos, prev && prev.domain === domain ? prev.study_id : null);
    }
  });
}

export const linkTargetStudy = (clientId, domain, studyId) =>
  openDb().prepare('UPDATE client_targets SET study_id = ? WHERE client_id = ? AND domain = ?').run(studyId, clientId, domain);

/**
 * The newest study of a domain in a country with every keyword fetched (or
 * given up on) and at least one keyword: safe to reuse for another client.
 */
export function findReusableStudy(domain, country) {
  return (
    openDb()
      .prepare(
        `SELECT s.id FROM studies s JOIN keywords k ON k.study_id = s.id
         WHERE s.target = ? AND s.country = ?
         GROUP BY s.id HAVING COUNT(k.id) > 0 AND SUM(k.serp_at IS NULL AND k.serp_error IS NULL) = 0
         ORDER BY s.id DESC LIMIT 1`,
      )
      .get(domain, country)?.id ?? null
  );
}

/** volume: a fetched figure or null; band: an index into VOLUME_BANDS or null. */
export function setClientVolume(id, { volume, band, cost = 0 }) {
  const d = openDb();
  if (volume !== undefined) d.prepare('UPDATE clients SET volume = ? WHERE id = ?').run(volume, id);
  d.prepare('UPDATE clients SET volume_band = ?, serp_cost = serp_cost + ? WHERE id = ?').run(band ?? null, cost, id);
}

// --- page metrics ----------------------------------------------------------------

export function getPageMetrics(urls) {
  const d = openDb();
  const get = d.prepare('SELECT * FROM page_metrics WHERE url = ?');
  return new Map(urls.map((u) => [u, get.get(u)]).filter(([, r]) => r));
}

export function savePageAhrefs(url, { urlRating, refdomains }) {
  openDb()
    .prepare(
      `INSERT INTO page_metrics (url, url_rating, refdomains, ahrefs_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (url) DO UPDATE SET url_rating = excluded.url_rating, refdomains = excluded.refdomains, ahrefs_at = excluded.ahrefs_at`,
    )
    .run(url, urlRating ?? null, refdomains ?? null, new Date().toISOString());
}

export function savePageDate(url, { publishedAt, source, error, cost = 0 }) {
  openDb()
    .prepare(
      `INSERT INTO page_metrics (url, published_at, date_source, date_at, date_error, dfs_cost) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (url) DO UPDATE SET published_at = excluded.published_at, date_source = excluded.date_source,
         date_at = excluded.date_at, date_error = excluded.date_error, dfs_cost = page_metrics.dfs_cost + excluded.dfs_cost`,
    )
    .run(url, publishedAt ?? null, source ?? 'none', new Date().toISOString(), error ?? null, cost);
}

// --- history (item 5) ------------------------------------------------------------------

export function saveHistory(keywordId, snapshots, cost, studyId) {
  tx((d) => {
    d.prepare('DELETE FROM history WHERE keyword_id = ?').run(keywordId);
    const ins = d.prepare('INSERT OR REPLACE INTO history (keyword_id, snapshot_date, position, results_count) VALUES (?, ?, ?, ?)');
    for (const s of snapshots) ins.run(keywordId, s.date, s.position ?? null, s.resultsCount);
    d.prepare('UPDATE studies SET history_cost = history_cost + ? WHERE id = ?').run(cost, studyId);
  });
}

/** keyword_id -> [{ date, position, resultsCount }] for a study. */
export function loadHistory(studyId) {
  const rows = openDb()
    .prepare('SELECT h.* FROM history h JOIN keywords k ON k.id = h.keyword_id WHERE k.study_id = ? ORDER BY h.keyword_id, h.snapshot_date')
    .all(studyId);
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.keyword_id)) out.set(r.keyword_id, []);
    out.get(r.keyword_id).push({ date: r.snapshot_date, position: r.position, resultsCount: r.results_count });
  }
  return out;
}

export const saveDecay = (studyId, decay) => openDb().prepare('UPDATE studies SET decay = ? WHERE id = ?').run(JSON.stringify(decay), studyId);
