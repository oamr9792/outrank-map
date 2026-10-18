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
`;

// Columns added after the first release, applied to older databases.
const MIGRATIONS = ['ALTER TABLE studies ADD COLUMN name TEXT', "ALTER TABLE studies ADD COLUMN notes TEXT NOT NULL DEFAULT ''"];

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
  return s ? { ...s, params: JSON.parse(s.params) } : null;
}

export function deleteStudy(id) {
  openDb().prepare('DELETE FROM studies WHERE id = ?').run(id);
}

export function updateStudy(id, { name, notes }) {
  const d = openDb();
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
    results: byKw.get(k.id) ?? [],
  }));
}
