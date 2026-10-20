import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { loadEnv, ROOT } from './src/env.js';
import { installTrustStore } from './src/tls-trust.js';

loadEnv();
// On Render, keep the database on the mounted disk even if DB_PATH was not
// set; anywhere else on the container it is wiped by every deploy.
if (process.env.RENDER && !process.env.DB_PATH) {
  if (fs.existsSync('/var/data')) process.env.DB_PATH = '/var/data/outrank-map.db';
  else console.warn('WARNING: no disk mounted at /var/data. Studies and reports will be lost on every deploy. Add a disk in Render (Settings → Disks, mount path /var/data).');
}
installTrustStore((process.env.EXTRA_CA_CERTS || '').split(';').filter(Boolean));

const { openDb, listStudies, getStudy, deleteStudy, updateStudy, loadStudyData, listPicks, savePick, removePick, createClient, getClient, listClients, deleteClient, listTargets, setTargets } = await import('./src/db.js');
const clients = await import('./src/client.js');
const auth = await import('./src/auth.js');
const { createStudy, fetchSerps, estimate, DEFAULTS } = await import('./src/run.js');
const { scoreDomains, domainDetail } = await import('./src/score.js');
const ahrefs = await import('./src/ahrefs.js');
const dfs = await import('./src/dataforseo.js');

openDb();

const PORT = Number(process.env.PORT || 8801);
// Render (which sets RENDER=true) routes to the container from outside, so a
// loopback default there means a running app that only ever answers 502.
const HOST = process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
const LOGIN_REQUIRED = auth.initAuth({ host: HOST });
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

// One background job at a time: every job spends API units or money.
const job = { running: false, kind: null, studyId: null, clientId: null, startedAt: null, finishedAt: null, log: [], error: null };

function startJob(kind, fn) {
  if (job.running) return false;
  Object.assign(job, { running: true, kind, studyId: null, clientId: null, startedAt: new Date().toISOString(), finishedAt: null, log: [], error: null });
  const log = (line) => {
    job.log.push(line);
    if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
  };
  fn(log)
    .catch((err) => {
      job.error = err.message;
      log(`error: ${err.message}`);
    })
    .finally(() => {
      job.running = false;
      job.finishedAt = new Date().toISOString();
    });
  return true;
}

// Scoring re-reads every SERP, so cache a study's data until it changes.
const cache = new Map();
function studyData(id) {
  const fetched = openDb().prepare('SELECT COUNT(*) AS n FROM keywords WHERE study_id = ? AND serp_at IS NOT NULL').get(id).n;
  const hit = cache.get(id);
  if (hit && hit.fetched === fetched) return hit.data;
  const data = loadStudyData(id);
  cache.set(id, { fetched, data });
  return data;
}

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1e5) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}

/** Any other page open in the browser must not be able to spend API credit. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return ['same-origin', 'none', undefined].includes(req.headers['sec-fetch-site']);
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function api(req, res, url) {
  const q = url.searchParams;
  const route = `${req.method} ${url.pathname}`;
  if (req.method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'cross-origin request refused' });

  // Health check for the host; says nothing about the data.
  if (route === 'GET /api/health') return send(res, 200, { ok: true });
  if (route === 'POST /api/login') {
    if (!LOGIN_REQUIRED) return send(res, 200, { ok: true });
    const { password } = await readJson(req);
    res.setHeader('Set-Cookie', auth.login(req, password));
    return send(res, 200, { ok: true });
  }
  if (route === 'POST /api/logout') {
    res.setHeader('Set-Cookie', auth.logout(req));
    return send(res, 200, { ok: true });
  }
  // Everything below needs a session.
  if (!auth.isAuthenticated(req)) return send(res, 401, { error: 'sign in required', login: true });

  if (route === 'GET /api/status') {
    return send(res, 200, {
      studies: listStudies(),
      clients: listClients(),
      job: { ...job, log: job.log.slice(-80) },
      ahrefs: ahrefs.hasKey(),
      dataforseo: dfs.hasCredentials(),
      dataforseoCap: dfs.budget(),
      defaults: DEFAULTS,
      loginRequired: LOGIN_REQUIRED,
    });
  }
  if (route === 'GET /api/estimate') return send(res, 200, estimate({ limit: q.get('limit'), maxPosition: q.get('maxPosition') }));
  if (route === 'GET /api/units') return send(res, 200, await ahrefs.unitsLeft());

  if (route === 'POST /api/studies') {
    const body = await readJson(req);
    const started = startJob('study', async (log) => {
      const id = await createStudy(body, log);
      job.studyId = id;
      await fetchSerps(id, log);
      log('Done.');
    });
    return send(res, started ? 202 : 409, started ? { started: true } : { error: 'a job is already running' });
  }

  // --- clients ------------------------------------------------------------------
  const busy = () => send(res, 409, { error: 'a job is already running' });
  // Pulls the client's name SERP as a job (it spends DataForSEO credit and
  // shares the run's budget counter, so it must not overlap another job).
  const nameSerpJob = (clientId, urls = []) =>
    startJob('name-serp', async (log) => {
      job.clientId = clientId;
      log(`Pulling the live Google results for "${getClient(clientId).name}" (depth ${clients.NAME_SERP_DEPTH})…`);
      const { cost, results } = await clients.fetchNameSerp(clientId);
      log(`${results.length} organic results, $${cost.toFixed(3)}`);
      if (urls.length) {
        const norm = (u) => String(u).replace(/[#?].*$/, '').replace(/\/$/, '').toLowerCase();
        const existing = listTargets(clientId).map((t) => ({ url: t.url, domain: t.domain, position: t.position_seen }));
        const added = urls.map((u) => ({ url: u, position: results.find((r) => norm(r.url) === norm(u))?.position ?? null }));
        setTargets(clientId, [...existing, ...added.filter((a) => !existing.some((e) => e.url === a.url))]);
      }
      log('Done. Confirm which results are the problem.');
    });

  if (route === 'POST /api/clients') {
    if (job.running) return busy();
    const body = await readJson(req);
    const country = String(body.country || 'us').toLowerCase();
    if (!dfs.LOCATION_CODES[country]) return send(res, 400, { error: `No location code for country "${country}"` });
    const urls = [].concat(body.urls ?? []).map((u) => String(u).trim()).filter((u) => /^https?:\/\//i.test(u));
    const id = createClient({ name: body.name, country });
    nameSerpJob(id, urls);
    return send(res, 202, { id });
  }

  const cm = url.pathname.match(/^\/api\/clients\/(\d+)(\/[a-z]+)?$/);
  if (cm) {
    const id = Number(cm[1]);
    const client = getClient(id);
    if (!client) return send(res, 404, { error: 'no such client' });
    const sub = cm[2] ?? '';
    const scope = ['all', 'negative', 'article'].includes(q.get('scope')) ? q.get('scope') : 'all';
    const rerun = (q.get('rerun') ?? '').split(',').filter(Boolean);

    if (req.method === 'GET' && !sub) {
      return send(res, 200, {
        client: { ...client, serp: clients.annotateSerp(client.serp ?? []) },
        targets: listTargets(id),
        plan: clients.planHosts(id),
      });
    }
    if (req.method === 'DELETE' && !sub) {
      if (job.running && job.clientId === id) return busy();
      deleteClient(id);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && sub === '/serp') return nameSerpJob(id) ? send(res, 202, { started: true }) : busy();
    if (req.method === 'PUT' && sub === '/targets') {
      if (job.running && job.clientId === id) return busy();
      const { targets } = await readJson(req);
      setTargets(id, [].concat(targets ?? []));
      return send(res, 200, { targets: listTargets(id), plan: clients.planHosts(id) });
    }
    if (req.method === 'GET' && sub === '/estimate') {
      return send(res, 200, clients.estimateClient(id, { limit: q.get('limit'), maxPosition: q.get('maxPosition') }, { rerun }));
    }
    if (req.method === 'POST' && sub === '/run') {
      const body = await readJson(req);
      const started = startJob('client', async (log) => {
        job.clientId = id;
        await clients.runClient(id, body.params ?? {}, log, { rerun: [].concat(body.rerun ?? []) });
        log('Done.');
      });
      return started ? send(res, 202, { started: true }) : busy();
    }
    if (req.method === 'GET' && sub === '/merged') {
      return send(res, 200, clients.mergedForClient(id, studyData, { scope, minContests: Math.max(1, Number(q.get('minContests') || 10)) }));
    }
    return send(res, 404, { error: 'not found' });
  }

  const m = url.pathname.match(/^\/api\/studies\/(\d+)(\/[a-z.]+)?$/);
  if (m) {
    const id = Number(m[1]);
    const study = getStudy(id);
    if (!study) return send(res, 404, { error: 'no such study' });
    const sub = m[2] ?? '';
    const scope = ['all', 'negative', 'article'].includes(q.get('scope')) ? q.get('scope') : 'all';

    if (req.method === 'DELETE' && !sub) {
      if (job.running && job.studyId === id) return send(res, 409, { error: 'this study is being fetched' });
      deleteStudy(id);
      cache.delete(id);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'PATCH' && !sub) {
      updateStudy(id, await readJson(req));
      return send(res, 200, { study: getStudy(id) });
    }
    if (sub === '/picks') {
      if (req.method === 'PUT') {
        const { domain, note } = await readJson(req);
        if (!domain) return send(res, 400, { error: 'domain required' });
        savePick(id, domain, note);
      } else if (req.method === 'DELETE') removePick(id, q.get('d') ?? '');
      else if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      return send(res, 200, { picks: listPicks(id) });
    }
    if (req.method === 'GET' && sub === '/report') {
      const data = studyData(id);
      const { summary, domains } = scoreDomains(data, study.target, { scope });
      const byDomain = new Map(domains.map((d) => [d.domain, d]));
      const picks = listPicks(id).map((p) => ({
        ...p,
        stats: byDomain.get(p.domain) ?? null,
        wins: domainDetail(data, study.target, p.domain, { scope }).filter((r) => r.outcome === 'win').slice(0, 8),
      }));
      return send(res, 200, { study, scope, summary, picks });
    }
    if (route.startsWith('POST') && sub === '/resume') {
      const started = startJob('resume', async (log) => {
        job.studyId = id;
        await fetchSerps(id, log, { retryFailed: true });
        log('Done.');
      });
      return send(res, started ? 202 : 409, started ? { started: true } : { error: 'a job is already running' });
    }
    if (req.method === 'GET' && sub === '/domains') {
      const scored = scoreDomains(studyData(id), study.target, { scope, minAppearances: Math.max(1, Number(q.get('min') || 1)) });
      return send(res, 200, { study, ...scored, picks: listPicks(id) });
    }
    if (req.method === 'GET' && sub === '/domain') {
      const domain = String(q.get('d') ?? '').toLowerCase();
      return send(res, 200, { study, domain, rows: domainDetail(studyData(id), study.target, domain, { scope }) });
    }
    if (req.method === 'GET' && sub === '/export.csv') {
      const { domains } = scoreDomains(studyData(id), study.target, { scope });
      const head = ['domain', 'wins', 'appearances', 'reach_pct', 'win_rate_pct', 'people', 'avg_gap', 'top3_wins', 'volume_won', 'access', 'page_types'];
      const lines = [head.join(',')].concat(
        domains.map((d) =>
          [d.domain, d.wins, d.appearances, (d.reach * 100).toFixed(1), (d.rawWinRate * 100).toFixed(1), d.people, d.avgGap.toFixed(1), d.top3Wins, d.volumeWon, d.access ?? '', Object.entries(d.types).map(([t, n]) => `${t}:${n}`).join(' ')]
            .map(csvCell)
            .join(','),
        ),
      );
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${study.target}-outrankers-${scope}.csv"` });
      return res.end(lines.join('\n'));
    }
  }
  return send(res, 404, { error: 'not found' });
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  // no-referrer: drill-down links open other sites, which should not learn
  // this app's address. noindex: a private tool has no business in search.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    return serveStatic(res, decodeURIComponent(url.pathname));
  } catch (err) {
    return send(res, err.status ?? 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => console.log(`outrank-map listening on http://${HOST}:${PORT}${LOGIN_REQUIRED ? ' (password required)' : ' (local, no login)'}`));
