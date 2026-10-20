const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (x) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
const num = (x) => Number(x ?? 0).toLocaleString();
// Result URLs come from Google, but only ever link to http(s).
function wordsLabel(p) {
  const lo = p.minWords ?? p.words ?? 0;
  const hi = p.maxWords ?? p.words ?? 0;
  if (!lo && !hi) return 'any-length';
  if (lo === hi) return `${lo}-word`;
  if (!hi) return `${lo}+ word`;
  if (!lo) return `≤${hi}-word`;
  return `${lo}–${hi}-word`;
}
const href = (u) => (/^https?:\/\//i.test(u ?? '') ? esc(u) : '#');

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && body.login) {
    showLogin();
    throw new Error('Sign in required');
  }
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

// ---- login ------------------------------------------------------------------
function showLogin(message = '') {
  if (polling) {
    clearInterval(polling);
    polling = null;
  }
  $('#login').hidden = false;
  $('#loginError').textContent = message;
  $('#login input').focus();
}
$('#login form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: e.target.password.value }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return showLogin(body.error ?? 'Sign-in failed');
  e.target.password.value = '';
  $('#login').hidden = true;
  refreshStatus().then(updateEstimate);
});
$('#logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  showLogin();
});

const state = { studyId: null, scope: 'all', min: 2, sort: 'wins', dir: -1, filter: '', domain: null, data: null, picks: new Map(), view: 'table', clientId: null, cdata: null, merged: null, cDomain: null, rerun: new Set(), defaults: null };
const SCOPES = [
  ['all', 'All person searches'],
  ['negative', 'Target page reads negative'],
  ['article', 'Target page is an article'],
];
const COLS = [
  ['picked', '★', false],
  ['domain', 'Domain', false],
  ['wins', 'Wins', true],
  ['reach', 'Reach', true],
  ['rawWinRate', 'Head-to-head', true],
  ['appearances', 'Seen with target', true],
  ['people', 'Distinct people', true],
  ['avgGap', 'Avg gap', true],
  ['top3Wins', 'Top-3 wins', true],
  ['volumeWon', 'Volume won', true],
  ['access', 'Access', false],
  ['types', 'Winning page types', false],
];

// ---- status / studies / job ---------------------------------------------
let polling = null;
async function refreshStatus() {
  const s = await api('/api/status');
  $('#logout').hidden = !s.loginRequired;
  $('#creds').innerHTML = `<span class="pill ${s.ahrefs ? '' : 'off'}">Ahrefs ${s.ahrefs ? 'key set' : 'no key'}</span><span class="pill ${s.dataforseo ? '' : 'off'}">DataForSEO ${s.dataforseo ? 'set' : 'missing'}</span>`;
  state.defaults = s.defaults;
  renderStudies(s.studies);
  renderClients(s.clients);
  const j = s.job;
  $('#jobCard').hidden = !j.running && !j.log.length;
  $('#jobTitle').textContent = j.running ? 'Running…' : j.error ? 'Stopped' : 'Last run';
  $('#jobLog').textContent = j.log.join('\n');
  $('#jobLog').scrollTop = 1e9;
  $('#new button').disabled = j.running;
  $('#newClient button').disabled = j.running;
  if (j.running && !polling) polling = setInterval(tick, 3000);
  if (!j.running && polling) {
    clearInterval(polling);
    polling = null;
    if (j.clientId && state.clientId === j.clientId) loadClient(j.kind !== 'name-serp');
    else {
      if (j.studyId && !state.studyId && !state.clientId) state.studyId = j.studyId;
      if (state.studyId) loadStudy();
    }
  }
  return s;
}
async function tick() {
  const s = await refreshStatus();
  // Show partial results as SERPs land.
  if (s.job.running && s.job.clientId && state.clientId === s.job.clientId) {
    // Only the plan and leaderboard: the name-SERP checklist may be mid-edit.
    if (s.job.kind === 'client') loadClient(true);
    return;
  }
  if (s.job.running && s.job.studyId && !state.clientId) {
    if (!state.studyId) state.studyId = s.job.studyId;
    if (state.studyId === s.job.studyId) loadStudy();
  }
}

function renderStudies(studies) {
  $('#studies').innerHTML = studies.length
    ? studies
        .map(
          (s) => `<li data-id="${s.id}" class="${s.id === state.studyId ? 'on' : ''}">
            <span><b>${esc(s.name || s.target)}</b>${s.name ? ` <span class="muted">${esc(s.target)}</span>` : ''} <span class="muted">${esc(s.country.toUpperCase())} · ${s.fetched ?? 0}/${s.keywords} SERPs${s.failed ? ` · ${s.failed} failed` : ''}</span></span>
            <button class="x" data-del="${s.id}" title="Delete study">×</button></li>`,
        )
        .join('')
    : '<li class="muted">None yet.</li>';
}

$('#studies').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    if (!confirm('Delete this study and its stored SERPs?')) return;
    await api(`/api/studies/${del.dataset.del}`, { method: 'DELETE' }).catch((err) => alert(err.message));
    if (Number(del.dataset.del) === state.studyId) {
      state.studyId = null;
      $('#view').innerHTML = '<div class="empty">Run a study, or pick one on the left.</div>';
    }
    return refreshStatus();
  }
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  state.studyId = Number(li.dataset.id);
  state.clientId = null;
  state.domain = null;
  state.view = 'table';
  refreshStatus();
  loadStudy();
});

// ---- new study ------------------------------------------------------------
const form = $('#new');
async function updateEstimate() {
  const e = await api(`/api/estimate?limit=${encodeURIComponent(form.limit.value)}&maxPosition=${encodeURIComponent(form.maxPosition.value)}`).catch(() => null);
  if (e) $('#estimate').textContent = `Up to ${num(e.ahrefsUnits)} Ahrefs units · ~$${e.dataforseoUsd} DataForSEO · ~${e.serpMinutes} min`;
}
form.limit.addEventListener("input", updateEstimate);
form.maxPosition.addEventListener("input", updateEstimate);
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(form));
  try {
    await api('/api/studies', { method: 'POST', body: JSON.stringify(body) });
    state.studyId = null;
    state.domain = null;
    $('#view').innerHTML = '<div class="empty">Pulling keywords…</div>';
    refreshStatus();
    if (!polling) polling = setInterval(tick, 3000);
  } catch (err) {
    alert(err.message);
  }
});

// ---- study view -----------------------------------------------------------
async function loadStudy() {
  const id = state.studyId;
  const d = await api(`/api/studies/${id}/domains?scope=${state.scope}&min=${state.min}`).catch((err) => ({ error: err.message }));
  if (id !== state.studyId) return;
  if (d.error) return ($('#view').innerHTML = `<div class="empty">${esc(d.error)}</div>`);
  state.data = d;
  state.picks = new Map(d.picks.map((p) => [p.domain, p.note]));
  if (state.view === 'report') return loadReport();
  renderStudy();
  if (state.domain) loadDomain(state.domain, false);
}

function renderStudy() {
  const { study, summary } = state.data;
  const p = study.params;
  $('#view').innerHTML = `
    <div class="head">
      <input id="studyName" class="title-input" value="${esc(study.name || '')}" placeholder="${esc(study.target)} — name this study">
      <div class="muted">${esc(study.target)} · ${esc(study.country.toUpperCase())} · ${wordsLabel(p)} person keywords · target pos ≤ ${p.maxPosition}${p.minVolume ? ` · vol ≥ ${p.minVolume}` : ''}${p.maxVolume ? ` · vol ≤ ${p.maxVolume}` : ''} · ${num(study.ahrefs_units)} Ahrefs units · $${study.dfs_cost.toFixed(2)} DataForSEO</div></div>
    <textarea id="studyNotes" rows="2" placeholder="Notes on this study (saved automatically)">${esc(study.notes || '')}</textarea>
    <div class="stats">
      <div class="stat"><b>${num(summary.contests)}</b><span>contests in scope<br>(target in live top ${p.depth})</span></div>
      <div class="stat"><b>${summary.targetAvgPosition?.toFixed(1) ?? '–'}</b><span>target's avg position</span></div>
      <div class="stat"><b>${num(summary.targetTop3)}</b><span>target in top 3</span></div>
      <div class="stat"><b>${num(summary.negativeContests)}</b><span>target page reads negative</span></div>
      <div class="stat"><b>${num(summary.targetAbsent)}</b><span>of ${num(summary.keywords)} SERPs: target gone since Ahrefs saw it</span></div>
    </div>
    <div class="toolbar">
      <div class="tabs">${SCOPES.map(([k, l]) => `<button data-scope="${k}" class="${k === state.scope ? 'on' : ''}">${l}</button>`).join('')}</div>
      <label style="flex:0;flex-direction:row;align-items:center;gap:6px;margin:0">Seen with target ≥ <input id="min" type="number" min="1" value="${state.min}" style="width:60px"></label>
      <input id="filter" placeholder="Filter domains" value="${esc(state.filter)}">
      <button id="openReport">Report (${state.picks.size} shortlisted)</button>
      <a class="btn ghost" href="/api/studies/${study.id}/export.csv?scope=${state.scope}">CSV</a>
      <button class="ghost" id="resume" title="Fetch any missing or failed SERPs">Resume / retry</button>
    </div>
    <div class="tablewrap"><table id="domains"><thead></thead><tbody></tbody></table></div>
    <p class="muted">Wins = searches where the domain's best organic result is above the target's. Reach = wins ÷ all contests in scope (how regularly it beats the target). Head-to-head = wins ÷ searches where both appear. Page types and the negative-headline flag are rule-based guesses.</p>
    <div id="detail" class="detail"></div>`;
  $('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-scope]');
    if (!b) return;
    state.scope = b.dataset.scope;
    loadStudy();
  });
  $('#min').addEventListener('change', (e) => {
    state.min = Math.max(1, Number(e.target.value) || 1);
    loadStudy();
  });
  $('#filter').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderTable();
  });
  const patch = (body) => api(`/api/studies/${study.id}`, { method: 'PATCH', body: JSON.stringify(body) }).then(() => refreshStatus()).catch((err) => alert(err.message));
  $('#studyName').addEventListener('change', (e) => patch({ name: e.target.value }));
  $('#studyNotes').addEventListener('change', (e) => patch({ notes: e.target.value }));
  $('#openReport').addEventListener('click', () => {
    state.view = 'report';
    loadReport();
  });
  $('#resume').addEventListener('click', async () => {
    await api(`/api/studies/${study.id}/resume`, { method: 'POST' }).catch((err) => alert(err.message));
    refreshStatus();
    if (!polling) polling = setInterval(tick, 3000);
  });
  renderTable();
}

function renderTable() {
  const { domains } = state.data;
  const max = Math.max(1, ...domains.map((d) => d.wins));
  const f = state.filter.trim().toLowerCase();
  for (const d of domains) d.picked = state.picks.has(d.domain) ? 1 : 0;
  const rows = domains
    .filter((d) => !f || d.domain.includes(f))
    .sort((a, b) => {
      const [x, y] = [a[state.sort], b[state.sort]];
      return (typeof x === 'string' || x == null ? String(x ?? '').localeCompare(String(y ?? '')) : x - y) * state.dir;
    })
    .slice(0, 300);
  $('#domains thead').innerHTML = `<tr>${COLS.map(([k, l, n]) => `<th data-k="${k}" class="${n ? 'num' : ''}">${l}${state.sort === k ? (state.dir < 0 ? ' ↓' : ' ↑') : ''}</th>`).join('')}</tr>`;
  $('#domains tbody').innerHTML = rows.length
    ? rows
        .map(
          (d) => `<tr data-d="${esc(d.domain)}" class="${d.domain === state.domain ? 'on' : ''}">
      <td><button class="star ${d.picked ? 'on' : ''}" data-star="${esc(d.domain)}" title="${d.picked ? 'Remove from shortlist' : 'Add to shortlist'}">${d.picked ? '★' : '☆'}</button></td>
      <td>${esc(d.domain)}</td>
      <td class="num">${d.wins}<span class="bar" style="width:${(d.wins / max) * 60}px"></span></td>
      <td class="num">${pct(d.reach)}</td>
      <td class="num" title="${d.wins} of ${d.appearances}">${pct(d.rawWinRate)}</td>
      <td class="num">${d.appearances}</td>
      <td class="num">${d.people}</td>
      <td class="num">${d.wins ? d.avgGap.toFixed(1) : '–'}</td>
      <td class="num">${d.top3Wins}</td>
      <td class="num">${num(d.volumeWon)}</td>
      <td>${d.access ? `<span class="tag">${esc(d.access)}</span>` : ''}</td>
      <td>${Object.entries(d.types).sort((a, b) => b[1] - a[1]).map(([t, n]) => `<span class="tag">${esc(t)} ${n}</span>`).join('')}</td></tr>`,
        )
        .join('')
    : `<tr><td colspan="${COLS.length}" class="muted">No domains${state.data.summary.contests ? ' match' : ' yet — SERPs still loading'}.</td></tr>`;
  $('#domains thead').onclick = (e) => {
    const th = e.target.closest('th');
    if (!th) return;
    if (state.sort === th.dataset.k) state.dir *= -1;
    else [state.sort, state.dir] = [th.dataset.k, th.classList.contains('num') ? -1 : 1];
    renderTable();
  };
  $('#domains tbody').onclick = (e) => {
    const star = e.target.closest('[data-star]');
    if (star) return togglePick(star.dataset.star);
    const tr = e.target.closest('tr[data-d]');
    if (tr) loadDomain(tr.dataset.d, true);
  };
}

async function loadDomain(domain, scroll) {
  state.domain = domain;
  document.querySelectorAll('#domains tbody tr').forEach((tr) => tr.classList.toggle('on', tr.dataset.d === domain));
  const { rows } = await api(`/api/studies/${state.studyId}/domain?d=${encodeURIComponent(domain)}&scope=${state.scope}`);
  const agg = state.data.domains.find((d) => d.domain === domain);
  const wins = rows.filter((r) => r.outcome === 'win');
  const picked = state.picks.has(domain);
  $('#detail').innerHTML = `
    <div class="head"><h3>${esc(domain)} vs ${esc(state.data.study.target)}</h3>
      <span class="muted">${wins.length} wins of ${rows.length} shared searches${agg?.sections?.length ? ` · winning sections: ${agg.sections.map(([s, n]) => `${esc(s)} ${n}`).join(', ')}` : ''}</span>
      <button id="pickBtn" class="${picked ? 'ghost' : ''}">${picked ? '★ Shortlisted — remove' : '☆ Add to shortlist'}</button></div>
    ${picked ? `<textarea id="pickNote" rows="2" placeholder="Why this domain, angle, contact, status… (saved automatically)">${esc(state.picks.get(domain))}</textarea>` : ''}
    <div class="tablewrap"><table>
      <thead><tr><th>Search</th><th class="num">Vol</th><th class="num">Them</th><th>Their page</th><th class="num">Target</th><th>Target's page</th></tr></thead>
      <tbody>${rows
        .map(
          (r) => `<tr class="${r.outcome}">
        <td>${esc(r.keyword)}${r.outcome === 'win' ? ' <span class="tag win">win</span>' : ''}</td>
        <td class="num">${num(r.volume)}</td>
        <td class="num pos">${r.them.position}</td>
        <td><a href="${href(r.them.url)}" target="_blank" rel="noopener noreferrer">${esc(r.them.title || r.them.url)}</a> <span class="tag">${esc(r.them.type)}</span><div class="u">${esc(r.them.url)}</div></td>
        <td class="num pos">${r.target.position}</td>
        <td><a href="${href(r.target.url)}" target="_blank" rel="noopener noreferrer">${esc(r.target.title || r.target.url)}</a> ${r.target.negative ? `<span class="tag neg" title="matched “${esc(r.target.negative)}”">negative</span>` : ''}<span class="tag">${esc(r.target.type)}</span></td></tr>`,
        )
        .join('')}</tbody></table></div>`;
  $('#pickBtn').onclick = () => togglePick(domain);
  $('#pickNote')?.addEventListener('change', (e) => savePick(domain, e.target.value));
  if (scroll) $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- shortlist & report -----------------------------------------------------------
async function savePick(domain, note = '') {
  const { picks } = await api(`/api/studies/${state.studyId}/picks`, { method: 'PUT', body: JSON.stringify({ domain, note }) });
  state.picks = new Map(picks.map((p) => [p.domain, p.note]));
}
async function togglePick(domain) {
  if (state.picks.has(domain)) {
    if (state.picks.get(domain) && !confirm(`Remove ${domain} and its note from the shortlist?`)) return;
    const { picks } = await api(`/api/studies/${state.studyId}/picks?d=${encodeURIComponent(domain)}`, { method: 'DELETE' });
    state.picks = new Map(picks.map((p) => [p.domain, p.note]));
  } else await savePick(domain);
  renderTable();
  $('#openReport').textContent = `Report (${state.picks.size} shortlisted)`;
  if (state.domain === domain) loadDomain(domain, false);
}

async function loadReport() {
  const r = await api(`/api/studies/${state.studyId}/report?scope=${state.scope}`);
  const s = r.study;
  const scopeLabel = SCOPES.find(([k]) => k === r.scope)[1];
  $('#view').innerHTML = `
    <div class="toolbar noprint"><button class="ghost" id="back">← Back to study</button><button id="print">Print / save as PDF</button></div>
    <article class="report">
      <h2>${esc(s.name || `Outranking ${s.target}`)}</h2>
      <p class="muted">Target: ${esc(s.target)} · ${esc(s.country.toUpperCase())} · scope: ${esc(scopeLabel)} · ${num(r.summary.contests)} person-name searches where the target ranks · generated ${new Date().toLocaleDateString()}</p>
      ${s.notes ? `<p class="notes">${esc(s.notes)}</p>` : ''}
      ${r.picks.length ? '' : '<p class="empty">Nothing shortlisted yet. Star domains in the study table to add them.</p>'}
      ${r.picks
        .map(
          (p) => `<section class="pick">
        <h3>${esc(p.domain)} ${p.stats?.access ? `<span class="tag">${esc(p.stats.access)}</span>` : ''}</h3>
        ${p.stats ? `<p class="muted">Beats ${esc(s.target)} on <b>${p.stats.wins}</b> searches (${pct(p.stats.reach)} of all) · head-to-head ${pct(p.stats.rawWinRate)} of ${p.stats.appearances} · ${p.stats.people} distinct people · avg ${p.stats.avgGap.toFixed(1)} positions higher · winning pages: ${Object.entries(p.stats.types).map(([t, n]) => `${esc(t)} ${n}`).join(', ') || 'none'}</p>` : '<p class="muted">Not seen alongside the target in this scope.</p>'}
        ${p.note ? `<p class="notes">${esc(p.note)}</p>` : ''}
        ${p.wins.length ? `<table><thead><tr><th>Search</th><th class="num">Them</th><th>Winning page</th><th class="num">Target</th></tr></thead><tbody>${p.wins
          .map((w) => `<tr><td>${esc(w.keyword)}</td><td class="num">${w.them.position}</td><td><a href="${href(w.them.url)}" target="_blank" rel="noopener noreferrer">${esc(w.them.title || w.them.url)}</a> <span class="tag">${esc(w.them.type)}</span></td><td class="num">${w.target.position}</td></tr>`)
          .join('')}</tbody></table>` : ''}
      </section>`,
        )
        .join('')}
    </article>`;
  $('#back').onclick = () => {
    state.view = 'table';
    loadStudy();
  };
  $('#print').onclick = () => window.print();
}

refreshStatus().then(updateEstimate);

// ---- clients -----------------------------------------------------------------
// Start from a person: their name SERP, the problem URLs on it, a study per
// problem host, and one merged leaderboard that has to beat every host.

function renderClients(list) {
  $('#clients').innerHTML = list.length
    ? list
        .map(
          (c) => `<li data-cid="${c.id}" class="${c.id === state.clientId ? 'on' : ''}">
            <span><b>${esc(c.name)}</b> <span class="muted">${esc(c.country.toUpperCase())} · ${c.targets} problem URL${c.targets === 1 ? '' : 's'}</span></span>
            <button class="x" data-cdel="${c.id}" title="Delete client">×</button></li>`,
        )
        .join('')
    : '<li class="muted">None yet.</li>';
}

$('#clients').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-cdel]');
  if (del) {
    e.stopPropagation();
    if (!confirm('Delete this client? Their studies are kept.')) return;
    await api(`/api/clients/${del.dataset.cdel}`, { method: 'DELETE' }).catch((err) => alert(err.message));
    if (Number(del.dataset.cdel) === state.clientId) {
      state.clientId = null;
      $('#view').innerHTML = '<div class="empty">Run a study, or pick one on the left.</div>';
    }
    return refreshStatus();
  }
  const li = e.target.closest('li[data-cid]');
  if (!li) return;
  openClient(Number(li.dataset.cid));
});

function openClient(id) {
  state.clientId = id;
  state.studyId = null;
  state.cDomain = null;
  state.rerun = new Set();
  refreshStatus();
  loadClient();
}

const clientForm = $('#newClient');
clientForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(clientForm));
  const urls = String(f.urls || '').split(/\s+/).filter(Boolean);
  try {
    const { id } = await api('/api/clients', { method: 'POST', body: JSON.stringify({ name: f.name, country: f.country, urls }) });
    clientForm.reset();
    openClient(id);
    if (!polling) polling = setInterval(tick, 3000);
  } catch (err) {
    alert(err.message);
  }
});

const ACTION_LABEL = { linked: 'study complete', reuse: 'will reuse a finished study (free)', resume: 'will resume the unfinished study', new: 'new study' };

/** Full render of the client page; `partial` redraws only plan + leaderboard. */
async function loadClient(partial = false) {
  const id = state.clientId;
  const c = await api(`/api/clients/${id}`).catch((err) => ({ error: err.message }));
  if (id !== state.clientId) return;
  if (c.error) return ($('#view').innerHTML = `<div class="empty">${esc(c.error)}</div>`);
  state.cdata = c;
  if (!partial || !$('#cSerp')) renderClient();
  renderPlan();
  loadMerged();
}

function renderClient() {
  const { client, targets } = state.cdata;
  const picked = new Set(targets.map((t) => t.url));
  const serp = client.serp ?? [];
  const extra = targets.filter((t) => !serp.some((r) => r.url === t.url));
  $('#view').innerHTML = `
    <div class="head"><h3>${esc(client.name)}</h3>
      <div class="muted">${esc(client.country.toUpperCase())} · name results ${client.serp_at ? `pulled ${new Date(client.serp_at).toLocaleString()}` : 'not pulled yet'} · $${(client.serp_cost ?? 0).toFixed(3)}
        <button class="ghost small" id="cResearch">Re-pull name results</button></div></div>

    <section class="card"><h2>1 · Google results for “${esc(client.name)}”</h2>
      <p class="muted">Tick the results that are the problem. Headlines that match the negative word list are flagged; it is a rule-based guess, so check each one.</p>
      ${serp.length ? '' : '<p class="empty">Pulling the name results… this takes about 30 seconds.</p>'}
      <div class="tablewrap"><table id="cSerp"><thead><tr><th></th><th class="num">Pos</th><th>Result</th><th>Domain</th></tr></thead><tbody>
      ${serp
        .map(
          (r) => `<tr><td><input type="checkbox" data-url="${esc(r.url)}" data-pos="${r.position}" ${picked.has(r.url) ? 'checked' : ''}></td>
          <td class="num pos">${r.position}</td>
          <td><a href="${href(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.title || r.url)}</a> ${r.negative ? `<span class="tag neg" title="matched “${esc(r.negative)}”">negative?</span>` : ''}<span class="tag">${esc(r.type)}</span><div class="u">${esc(r.url)}</div></td>
          <td>${esc(r.domain)}</td></tr>`,
        )
        .join('')}
      ${extra.map((t) => `<tr><td><input type="checkbox" data-url="${esc(t.url)}" data-pos="" checked></td><td class="num">–</td><td><span class="u">${esc(t.url)}</span> <span class="tag">added by hand</span></td><td>${esc(t.domain)}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="toolbar"><input id="cAddUrl" placeholder="Add a problem URL that is not in these results" style="flex:1"><button class="ghost" id="cAdd">Add</button></div>
      <h2 style="margin-top:12px">Hosts to study</h2>
      <p class="muted">Each problem URL is studied by its host. Edit a host to study the parent domain instead (e.g. events.example.com → example.com).</p>
      <div id="cHosts"></div>
      <button id="cSave">Save problem URLs</button>
    </section>

    <section class="card"><h2>2 · Studies per host</h2><div id="cPlan"></div></section>

    <section class="card"><h2>3 · Domains that beat every host</h2>
      <p class="muted">Merged = the domain's reach against the host it does worst against. It is inferred from how each domain does against these hosts on other people's names, not a prediction for ${esc(client.name)}'s own results. ★ = already in ${esc(client.name)}'s name results: a property to strengthen, sorted first at equal score.</p>
      <div class="toolbar"><div class="tabs" id="cScopes">${SCOPES.map(([k, l]) => `<button data-scope="${k}" class="${k === state.scope ? 'on' : ''}">${l}</button>`).join('')}</div>
        <input id="cFilter" placeholder="Filter domains" value="${esc(state.filter)}"></div>
      <div class="tablewrap"><table id="cMerged"><thead></thead><tbody></tbody></table></div>
      <div id="cDetail" class="detail"></div>
    </section>`;

  const hostInputs = () => {
    const urls = [...document.querySelectorAll('#cSerp input:checked')].map((b) => b.dataset.url);
    const known = new Map(state.cdata.targets.map((t) => [t.url, t.domain]));
    const hostOf = (u) => known.get(u) ?? new URL(u).hostname.replace(/^www\./, '');
    $('#cHosts').innerHTML = urls.length
      ? `<table><tbody>${urls.map((u) => `<tr><td class="u">${esc(u)}</td><td><input data-host-for="${esc(u)}" value="${esc(hostOf(u))}"></td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">No problem URLs ticked yet.</p>';
  };
  hostInputs();
  $('#cSerp').addEventListener('change', hostInputs);
  $('#cAdd').onclick = () => {
    const u = $('#cAddUrl').value.trim();
    if (!/^https?:\/\//i.test(u)) return alert('Enter a full URL starting with http(s)://');
    $('#cSerp tbody').insertAdjacentHTML('beforeend', `<tr><td><input type="checkbox" data-url="${esc(u)}" data-pos="" checked></td><td class="num">–</td><td><span class="u">${esc(u)}</span> <span class="tag">added by hand</span></td><td></td></tr>`);
    $('#cAddUrl').value = '';
    hostInputs();
  };
  $('#cSave').onclick = async () => {
    const targets = [...document.querySelectorAll('#cSerp input:checked')].map((b) => ({
      url: b.dataset.url,
      position: b.dataset.pos || null,
      domain: document.querySelector(`[data-host-for="${CSS.escape(b.dataset.url)}"]`)?.value,
    }));
    try {
      await api(`/api/clients/${state.clientId}/targets`, { method: 'PUT', body: JSON.stringify({ targets }) });
      refreshStatus();
      loadClient(true);
    } catch (err) {
      alert(err.message);
    }
  };
  $('#cResearch').onclick = async () => {
    if (!confirm('Pull the name results again? One DataForSEO call, about $0.005.')) return;
    await api(`/api/clients/${state.clientId}/serp`, { method: 'POST' }).catch((err) => alert(err.message));
    refreshStatus();
    if (!polling) polling = setInterval(tick, 3000);
  };
  $('#cScopes').onclick = (e) => {
    const b = e.target.closest('[data-scope]');
    if (!b) return;
    state.scope = b.dataset.scope;
    document.querySelectorAll('#cScopes button').forEach((x) => x.classList.toggle('on', x === b));
    loadMerged();
  };
  $('#cFilter').oninput = (e) => {
    state.filter = e.target.value;
    renderMerged();
  };
}

function runForm() {
  const d = state.defaults ?? {};
  return `<div class="row">
      <label>Keywords per host <input name="limit" type="number" min="1" max="10000" value="${d.limit ?? 300}"></label>
      <label>Min words <input name="minWords" type="number" min="0" max="10" value="${d.minWords ?? 2}"></label>
      <label>Max words <input name="maxWords" type="number" min="0" max="10" value="${d.maxWords ?? 2}"></label>
      <label>Target pos ≤ <input name="maxPosition" type="number" min="1" max="100" value="${d.maxPosition ?? 20}"></label></div>`;
}

async function renderPlan() {
  const { plan } = state.cdata;
  if (!plan.length) return ($('#cPlan').innerHTML = '<p class="muted">Save at least one problem URL first.</p>');
  const keep = $('#cRunForm') ? Object.fromEntries(new FormData($('#cRunForm'))) : null;
  $('#cPlan').innerHTML = `
    <table><thead><tr><th>Host</th><th class="num">URLs</th><th>Status</th><th>Re-run fresh</th></tr></thead><tbody>
    ${plan
      .map(
        (h) => `<tr><td>${esc(h.domain)}</td><td class="num">${h.urls.length}</td>
        <td>${esc(ACTION_LABEL[h.action] ?? h.action)}${h.studyId ? ` · <a href="#" data-open-study="${h.studyId}">study #${h.studyId}</a>` : ''}</td>
        <td>${h.action === 'new' && !state.rerun.has(h.domain) ? '' : `<input type="checkbox" data-rerun="${esc(h.domain)}" ${state.rerun.has(h.domain) ? 'checked' : ''}>`}</td></tr>`,
      )
      .join('')}</tbody></table>
    <form id="cRunForm">${runForm()}</form>
    <p id="cEstimate" class="muted"></p>
    <button id="cRun">Run studies</button>`;
  if (keep) for (const [k, v] of Object.entries(keep)) if ($('#cRunForm')[k]) $('#cRunForm')[k].value = v;
  const params = () => Object.fromEntries(new FormData($('#cRunForm')));
  const est = async () => {
    const p = params();
    const e = await api(`/api/clients/${state.clientId}/estimate?limit=${encodeURIComponent(p.limit)}&maxPosition=${encodeURIComponent(p.maxPosition)}&rerun=${encodeURIComponent([...state.rerun].join(','))}`).catch(() => null);
    if (e) $('#cEstimate').textContent = e.newStudies ? `${e.newStudies} new stud${e.newStudies === 1 ? 'y' : 'ies'}: up to ${num(e.ahrefsUnits)} Ahrefs units · ~$${e.dataforseoUsd} DataForSEO · ~${e.serpMinutes} min` : 'No new studies needed: nothing to pay for.';
  };
  est();
  $('#cRunForm').oninput = est;
  $('#cPlan').onclick = (e) => {
    const a = e.target.closest('[data-open-study]');
    if (a) {
      e.preventDefault();
      state.clientId = null;
      state.studyId = Number(a.dataset.openStudy);
      state.view = 'table';
      refreshStatus();
      loadStudy();
    }
  };
  $('#cPlan').onchange = (e) => {
    const b = e.target.closest('[data-rerun]');
    if (!b) return;
    b.checked ? state.rerun.add(b.dataset.rerun) : state.rerun.delete(b.dataset.rerun);
    est();
  };
  $('#cRun').onclick = async () => {
    try {
      await api(`/api/clients/${state.clientId}/run`, { method: 'POST', body: JSON.stringify({ params: params(), rerun: [...state.rerun] }) });
      state.rerun = new Set();
      refreshStatus();
      if (!polling) polling = setInterval(tick, 3000);
    } catch (err) {
      alert(err.message);
    }
  };
}

async function loadMerged() {
  const id = state.clientId;
  const m = await api(`/api/clients/${id}/merged?scope=${state.scope}`).catch((err) => ({ error: err.message }));
  if (id !== state.clientId || !$('#cMerged')) return;
  if (m.error) return ($('#cMerged tbody').innerHTML = `<tr><td class="muted">${esc(m.error)}</td></tr>`);
  state.merged = m;
  renderMerged();
  if (state.cDomain) loadClientDomain(state.cDomain, false);
}

function renderMerged() {
  const { hosts, domains } = state.merged;
  const f = state.filter.trim().toLowerCase();
  const rows = domains.filter((d) => !f || d.domain.includes(f)).slice(0, 300);
  $('#cMerged thead').innerHTML = `<tr><th>Domain</th><th class="num">Merged reach</th><th class="num">In name results</th>
    ${hosts.map((h) => `<th class="num" title="${h.counted ? '' : 'Too few searches to count toward the merged score'}">vs ${esc(h.domain)}<br><span class="muted">${h.studyId ? `${h.contests} searches${h.counted ? '' : ' · not counted'}` : 'not studied yet'}</span></th>`).join('')}
    <th class="num">Total wins</th><th>Access</th><th>Winning page types</th></tr>`;
  $('#cMerged tbody').innerHTML = rows.length
    ? rows
        .map(
          (d) => `<tr data-cd="${esc(d.domain)}" class="${d.domain === state.cDomain ? 'on' : ''}">
        <td>${d.inNameSerp ? '<span class="star on" title="Already in the name results">★</span> ' : ''}${esc(d.domain)}</td>
        <td class="num"><b>${pct(d.merged)}</b></td>
        <td class="num">${d.inNameSerp ? `#${d.inNameSerp}` : '–'}</td>
        ${hosts.map((h) => { const p = d.perHost[h.domain]; return `<td class="num ${h.domain === d.hardestHost && hosts.length > 1 ? 'weak' : ''}" title="${p.wins} wins of ${p.contests} searches">${h.studyId ? pct(p.reach) : '–'}</td>`; }).join('')}
        <td class="num">${d.totalWins}</td>
        <td>${d.access ? `<span class="tag">${esc(d.access)}</span>` : ''}</td>
        <td>${Object.entries(d.types).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, n]) => `<span class="tag">${esc(t)} ${n}</span>`).join('')}</td></tr>`,
        )
        .join('')
    : `<tr><td colspan="${hosts.length + 6}" class="muted">${hosts.some((h) => h.studyId) ? 'No domains match.' : 'Run the studies to see domains here.'}</td></tr>`;
  $('#cMerged tbody').onclick = (e) => {
    const tr = e.target.closest('tr[data-cd]');
    if (tr) loadClientDomain(tr.dataset.cd, true);
  };
}

/** Drill-down: the domain's winning pages against each host. */
async function loadClientDomain(domain, scroll) {
  state.cDomain = domain;
  document.querySelectorAll('#cMerged tbody tr').forEach((tr) => tr.classList.toggle('on', tr.dataset.cd === domain));
  const d = state.merged.domains.find((x) => x.domain === domain);
  const parts = await Promise.all(
    state.merged.hosts
      .filter((h) => h.studyId)
      .map(async (h) => ({ h, rows: (await api(`/api/studies/${h.studyId}/domain?d=${encodeURIComponent(domain)}&scope=${state.scope}`)).rows })),
  );
  $('#cDetail').innerHTML = `
    <div class="head"><h3>${esc(domain)}</h3>
      <span class="muted">${d?.inNameSerp ? `Already at #${d.inNameSerp} for ${esc(state.cdata.client.name)}: <a href="${href(d.nameSerpUrl)}" target="_blank" rel="noopener noreferrer">${esc(d.nameSerpUrl)}</a>` : `Not in ${esc(state.cdata.client.name)}'s name results yet.`}</span></div>
    ${parts
      .map(({ h, rows }) => {
        const wins = rows.filter((r) => r.outcome === 'win');
        return `<h2 style="margin-top:12px">vs ${esc(h.domain)}: ${wins.length} wins of ${rows.length} shared searches</h2>
        ${wins.length ? `<div class="tablewrap"><table><thead><tr><th>Search</th><th class="num">Them</th><th>Their page</th><th class="num">${esc(h.domain)}</th></tr></thead><tbody>
        ${wins.slice(0, 15).map((r) => `<tr><td>${esc(r.keyword)}</td><td class="num pos">${r.them.position}</td><td><a href="${href(r.them.url)}" target="_blank" rel="noopener noreferrer">${esc(r.them.title || r.them.url)}</a> <span class="tag">${esc(r.them.type)}</span></td><td class="num pos">${r.target.position}</td></tr>`).join('')}
        </tbody></table></div>${wins.length > 15 ? `<p class="muted">${wins.length - 15} more in <a href="#" data-open-study="${h.studyId}">study #${h.studyId}</a>.</p>` : ''}` : '<p class="muted">No wins against this host.</p>'}`;
      })
      .join('')}`;
  $('#cDetail').onclick = (e) => {
    const a = e.target.closest('[data-open-study]');
    if (!a) return;
    e.preventDefault();
    state.clientId = null;
    state.studyId = Number(a.dataset.openStudy);
    state.view = 'table';
    refreshStatus();
    loadStudy();
  };
  if (scroll) $('#cDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
