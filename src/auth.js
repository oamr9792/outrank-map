import crypto from 'node:crypto';
import { openDb } from './db.js';

/**
 * Single-user authentication.
 *
 * Deployed, this app is an endpoint that spends Ahrefs units and DataForSEO
 * money on request and holds research about real people, so it must not
 * answer anyone without a session. One password (APP_PASSWORD) is the whole
 * account model: there is one user.
 *
 * Locally on a loopback address with no APP_PASSWORD set, the login is
 * skipped. Anywhere else the server refuses to start without one.
 */

const COOKIE = 'om_session';
const TTL_MS = 30 * 24 * 3600 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1 };

const isLoopback = (host) => ['127.0.0.1', 'localhost', '::1'].includes(host);

let passwordKey = null; // scrypt(APP_PASSWORD), derived once at startup
const salt = crypto.randomBytes(16);
const derive = (pw) => crypto.scryptSync(String(pw), salt, 64, SCRYPT);

/** Returns whether a login is required; throws if the deployment is unsafe. */
export function initAuth({ host }) {
  const pw = process.env.APP_PASSWORD ?? '';
  if (!pw) {
    if (isLoopback(host)) return false;
    throw new Error(`APP_PASSWORD must be set when listening on ${host}. Refusing to start an open deployment.`);
  }
  if (pw.length < 12) throw new Error('APP_PASSWORD must be at least 12 characters.');
  passwordKey = derive(pw);
  openDb().exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
  openDb().prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  return true;
}

export const authEnabled = () => passwordKey !== null;

// --- throttling: per IP, in memory -------------------------------------------
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

export function clientIp(req) {
  if (process.env.TRUST_PROXY === 'true') {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? '-';
}

function throttled(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

// --- sessions ------------------------------------------------------------------
const hashId = (id) => crypto.createHash('sha256').update(id).digest('hex');

function cookieOf(req) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

const cookieAttrs = () => `Path=/; HttpOnly; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;

export function isAuthenticated(req) {
  if (!authEnabled()) return true;
  const id = cookieOf(req);
  if (!id) return false;
  // Only the hash of the session id is stored, so a copy of the database
  // does not hand out live sessions.
  const row = openDb().prepare('SELECT expires_at FROM sessions WHERE id = ?').get(hashId(id));
  return Boolean(row && row.expires_at > Date.now());
}

/** Returns a Set-Cookie value on success; throws { status } on failure. */
export function login(req, password) {
  const ip = clientIp(req);
  if (throttled(ip)) throw Object.assign(new Error('Too many failed attempts. Try again in 15 minutes.'), { status: 429 });
  const given = derive(password ?? '');
  if (!crypto.timingSafeEqual(given, passwordKey)) {
    const rec = attempts.get(ip);
    if (!rec || Date.now() - rec.first > WINDOW_MS) attempts.set(ip, { count: 1, first: Date.now() });
    else rec.count++;
    throw Object.assign(new Error('Wrong password.'), { status: 401 });
  }
  attempts.delete(ip);
  const id = crypto.randomBytes(32).toString('base64url');
  openDb().prepare('INSERT INTO sessions (id, expires_at) VALUES (?, ?)').run(hashId(id), Date.now() + TTL_MS);
  return `${COOKIE}=${id}; ${cookieAttrs()}; Max-Age=${TTL_MS / 1000}`;
}

export function logout(req) {
  const id = cookieOf(req);
  if (id) openDb().prepare('DELETE FROM sessions WHERE id = ?').run(hashId(id));
  return `${COOKIE}=; ${cookieAttrs()}; Max-Age=0`;
}
