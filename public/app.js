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

const state = { studyId: null, scope: 'all', min: 2, sort: 'wins', dir: -1, filter: '', domain: null, data: null, picks: new Map(), view: 'table' };
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
  renderStudies(s.studies);
  const j = s.job;
  $('#jobCard').hidden = !j.running && !j.log.length;
  $('#jobTitle').textContent = j.running ? 'Running…' : j.error ? 'Stopped' : 'Last run';
  $('#jobLog').textContent = j.log.join('\n');
  $('#jobLog').scrollTop = 1e9;
  $('#new button').disabled = j.running;
  if (j.running && !polling) polling = setInterval(tick, 3000);
  if (!j.running && polling) {
    clearInterval(polling);
    polling = null;
    if (j.studyId && !state.studyId) state.studyId = j.studyId;
    if (state.studyId) loadStudy();
  }
  return s;
}
async function tick() {
  const s = await refreshStatus();
  // Show partial results as SERPs land.
  if (s.job.running && s.job.studyId) {
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
