import { helpIcon, installHelp } from './help.js';

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

const state = { studyId: null, scope: 'all', pMode: 'saved', pCustom: {}, cMode: 'profile', min: 2, sort: 'weightedReach', dir: -1, filter: '', domain: null, data: null, picks: new Map(), view: 'table', clientId: null, cdata: null, merged: null, cDomain: null, rerun: new Set(), defaults: null };
const SCOPES = [
  ['all', 'All person searches'],
  ['negative', 'Target page reads negative'],
  ['article', 'Target page is an article'],
];
const COLS = [
  ['picked', '★', false],
  ['domain', 'Domain', false],
  ['weightedReach', 'Weighted reach', true],
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

// ---- situation profile ---------------------------------------------------------
const VOLUME_LABELS = ['<100', '100–1k', '1k–10k', '10k+'];
const PAGE_TYPES = ['article', 'profile', 'court', 'homepage', 'forum', 'social', 'video', 'wiki', 'other'];
const PART_LABEL = { pageType: 'page type', position: 'position ±3', volumeBand: 'volume band', category: 'negative category' };

function profileLabel(p = {}) {
  const bits = [];
  if (p.pageType) bits.push(p.pageType);
  if (p.position) bits.push(`#${p.position} ±3`);
  if (p.volumeBand != null) bits.push(`${VOLUME_LABELS[p.volumeBand]} searches`);
  if (p.category) bits.push(p.category === '*' ? 'negative headline' : p.category);
  return bits.length ? bits.join(' · ') : 'every contest weighs 1';
}

/** The flag for a negative headline: its category, with the matched word on hover. */
const negTag = (neg, suffix = '') => (neg ? `<span class="tag neg" title="matched “${esc(neg.word)}”">${esc(neg.category)}${suffix}</span>` : '');

/** The target's median position by month, as a small inline SVG (1 at the top). */
function decayChart(series) {
  const pts = series.filter((s) => s.median != null && !s.thin);
  if (pts.length < 2) return '<p class="muted">Not enough months to draw a line.</p>';
  const W = 600, H = 170, L = 34, R = 10, T = 12, B = 26;
  const max = Math.max(...pts.map((p) => p.median)), min = Math.min(...pts.map((p) => p.median));
  const lo = Math.max(1, Math.floor(min - 1)), hi = Math.ceil(max + 1);
  const x = (i) => L + (i * (W - L - R)) / (pts.length - 1);
  const y = (v) => T + ((v - lo) * (H - T - B)) / Math.max(1, hi - lo);
  const ticks = [lo, Math.round((lo + hi) / 2), hi];
  return `<svg class="decay" viewBox="0 0 ${W} ${H}" role="img" aria-label="Target's median position by month">
    ${ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">#${t}</text>`).join('')}
    <polyline points="${pts.map((p, i) => `${x(i)},${y(p.median)}`).join(' ')}" class="line"/>
    ${pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.median)}" r="3" class="dot"><title>${p.month}: median #${p.median} over ${p.keywords} searches${p.missing ? `, ${p.missing} not in the results` : ''}</title></circle>`).join('')}
    ${pts.map((p, i) => (i % Math.ceil(pts.length / 6) === 0 || i === pts.length - 1 ? `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === pts.length - 1 ? 'end' : i === 0 ? 'start' : 'middle'}">${p.month}</text>` : '')).join('')}
  </svg>`;
}

/** The one-number summary of decay, in words. */
function decayLine(d) {
  if (!d || d.change6 == null) return d ? 'Not enough history: no search has snapshots about six months apart.' : '';
  const n = Math.abs(d.change6);
  const dir = d.change6 > 0 ? `down ${n.toFixed(1)} positions (fading)` : d.change6 < 0 ? `up ${n.toFixed(1)} positions (strengthening)` : 'no change';
  const few = d.change6Keywords < 10 ? ' Few searches: treat as indicative.' : '';
  return `Over about ${Math.round(d.spanMonths)} months, the target's median change is ${dir}, across ${d.change6Keywords} of ${d.keywords} searches.${few}`;
}

/** Why a contest weighs what it does, for the drill-down's tooltip. */
const partsLabel = (parts = {}) =>
  Object.keys(parts).length ? Object.entries(parts).map(([k, ok]) => `${PART_LABEL[k]} ${ok ? '✓' : '✗'}`).join(' · ') : 'no profile set: weight 1';

/** The study's profile choice as a query string: saved, a preset, or custom. */
function profileQuery() {
  if (state.pMode === 'custom') return `profile=${encodeURIComponent(JSON.stringify(state.pCustom))}`;
  if (state.pMode && state.pMode !== 'saved') return `scope=${state.pMode}`;
  return '';
}

function profileFields(p = {}, idPrefix = 'pf') {
  return `<label>Page type${helpIcon('pageType')} <select id="${idPrefix}Type"><option value="">any</option>${PAGE_TYPES.map((t) => `<option ${p.pageType === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <label>Target at #${helpIcon('position')} <input id="${idPrefix}Pos" type="number" min="1" max="100" value="${p.position ?? ''}" placeholder="any"></label>
    <label>Volume band${helpIcon('volumeBand')} <select id="${idPrefix}Vol"><option value="">any</option>${VOLUME_LABELS.map((l, i) => `<option value="${i}" ${p.volumeBand === i ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>Negative category${helpIcon('category')} <select id="${idPrefix}Cat"><option value="">any</option><option value="*" ${p.category === '*' ? 'selected' : ''}>any negative headline</option>${(state.categories ?? []).filter((c) => c !== 'unspecified').map((c) => `<option ${p.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>`;
}
const readProfileFields = (idPrefix = 'pf') => ({
  pageType: $(`#${idPrefix}Type`).value || undefined,
  position: $(`#${idPrefix}Pos`).value || undefined,
  volumeBand: $(`#${idPrefix}Vol`).value === '' ? undefined : Number($(`#${idPrefix}Vol`).value),
  category: $(`#${idPrefix}Cat`).value || undefined,
});

// ---- status / studies / job ---------------------------------------------
let polling = null;
async function refreshStatus() {
  const s = await api('/api/status');
  $('#logout').hidden = !s.loginRequired;
  $('#creds').innerHTML = `<span class="pill ${s.ahrefs ? '' : 'off'}">Ahrefs ${s.ahrefs ? 'key set' : 'no key'}</span><span class="pill ${s.dataforseo ? '' : 'off'}">DataForSEO ${s.dataforseo ? 'set' : 'missing'}</span>`;
  state.defaults = s.defaults;
  state.categories = s.negativeCategories ?? [];
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
  state.pMode = 'saved';
  if (['all', 'clientReport', 'guide'].includes(state.view)) state.view = 'table';
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
  const d = await api(`/api/studies/${id}/domains?${profileQuery()}&min=${state.min}`).catch((err) => ({ error: err.message }));
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
      <div class="muted">${esc(study.target)} · ${esc(study.country.toUpperCase())} · ${wordsLabel(p)} person keywords · ${esc(p.device ?? 'desktop')} · target pos ≤ ${p.maxPosition}${p.minVolume ? ` · vol ≥ ${p.minVolume}` : ''}${p.maxVolume ? ` · vol ≤ ${p.maxVolume}` : ''} · ${num(study.ahrefs_units)} Ahrefs units · $${study.dfs_cost.toFixed(2)} DataForSEO</div></div>
    <textarea id="studyNotes" rows="2" placeholder="Notes on this study (saved automatically)">${esc(study.notes || '')}</textarea>
    <div class="stats">
      <div class="stat"><b>${num(summary.contests)}</b><span>contests${helpIcon('contests')}<br>(target in live top ${p.depth})</span></div>
      <div class="stat"><b>${summary.effectiveContests.toFixed(1)}</b><span>effective contests${helpIcon('effectiveContests')}<br>(sum of weights)</span></div>
      <div class="stat"><b>${summary.targetAvgPosition?.toFixed(1) ?? '–'}</b><span>target's avg position${helpIcon('targetAvgPosition')}</span></div>
      <div class="stat"><b>${num(summary.targetTop3)}</b><span>target in top 3${helpIcon('targetTop3')}</span></div>
      <div class="stat"><b>${num(summary.negativeContests)}</b><span>target page reads negative${helpIcon('negativeContests')}${Object.keys(summary.categories ?? {}).length ? `<br>${Object.entries(summary.categories).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${esc(c)} ${n}`).join(' · ')}` : ''}</span></div>
      <div class="stat"><b>${num(summary.targetAbsent)}</b><span>of ${num(summary.keywords)} SERPs: target gone since Ahrefs saw it${helpIcon('targetAbsent')}</span></div>
      <div class="stat" title="Live position minus the position Ahrefs reported, over contests. Positive = the target has slipped since Ahrefs looked."><b>${summary.medianDrift == null ? '–' : `${summary.medianDrift > 0 ? '+' : ''}${summary.medianDrift}`}</b><span>median drift, Ahrefs → live${helpIcon('medianDrift')}<br>${summary.driftKeywords ? `${summary.driftOver3} of ${summary.driftKeywords} moved more than 3` : ''}</span></div>
    </div>
    <section class="card" id="decayCard"></section>
    <section class="card profile">
      <h2>Situation profile${helpIcon('profile')} <span class="muted">— weights each contest by how much it looks like your client's case</span></h2>
      <div class="tabs" id="pPresets">${[['saved', "Study's saved profile"], ...SCOPES, ['custom', 'Custom']].map(([k, l]) => `<button data-p="${k}" class="${k === state.pMode ? 'on' : ''}">${l}</button>`).join('')}</div>${helpIcon('presets')}
      <p class="muted">In use: <b>${esc(profileLabel(state.data.profile))}</b>. Weights: page type 0.4 · target position within ±3 0.3 · volume band 0.2 · negative category 0.1; only the parts you set count, so a single part gives weights of 1 or 0.</p>
      <div class="row" id="pFields" ${state.pMode === 'custom' ? '' : 'hidden'}>${profileFields(state.pMode === 'custom' ? state.pCustom : state.data.profile)}</div>
      <div class="toolbar" style="margin:0"><button class="ghost" id="pApply" ${state.pMode === 'custom' ? '' : 'hidden'}>Apply</button>
        <button class="ghost" id="pSave" title="Use this profile whenever the study opens">Save as the study's profile</button></div>
    </section>
    <div class="toolbar">
      <label style="flex:0;flex-direction:row;align-items:center;gap:6px;margin:0">Seen with target ≥ <input id="min" type="number" min="1" value="${state.min}" style="width:60px"></label>
      <input id="filter" placeholder="Filter domains" value="${esc(state.filter)}">
      <button id="openReport">Report (${state.picks.size} shortlisted)</button>
      <button class="ghost" id="explain" title="Look up links and page age for the shortlisted domains' winning pages">Explain shortlist</button>${helpIcon('explain')}
      <a class="btn ghost" href="/api/studies/${study.id}/export.csv?${profileQuery()}">CSV</a>
      <button class="ghost" id="resume" title="Fetch any missing or failed SERPs">Resume / retry</button>
    </div>
    <div class="tablewrap"><table id="domains"><thead></thead><tbody></tbody></table></div>
    <p class="muted">Wins = searches where the domain's best organic result is above the target's. Reach = wins ÷ all contests (how regularly it beats the target). Weighted reach = the same with each contest counted by its weight, so wins on searches like your client's count most. Head-to-head = wins ÷ searches where both appear. Page types and the negative-headline flag are rule-based guesses.</p>
    <div id="detail" class="detail"></div>`;
  $('#pPresets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    if (b.dataset.p === 'custom' && state.pMode !== 'custom') state.pCustom = { ...state.data.profile };
    state.pMode = b.dataset.p;
    loadStudy();
  });
  $('#pApply').addEventListener('click', () => {
    state.pCustom = readProfileFields();
    loadStudy();
  });
  $('#pSave').addEventListener('click', async () => {
    const profile = state.pMode === 'custom' ? readProfileFields() : state.data.profile;
    await api(`/api/studies/${study.id}`, { method: 'PATCH', body: JSON.stringify({ profile }) }).catch((err) => alert(err.message));
    state.pMode = 'saved';
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
  renderDecay(study);
  $('#explain').addEventListener('click', async () => {
    const { estimate: e } = await api(`/api/studies/${study.id}/explain`);
    if (!e.domains) return alert('Star at least one domain first: only shortlisted domains are explained.');
    const paid = e.ahrefsPages || e.htmlPages;
    const msg = `${e.domains} shortlisted domain${e.domains === 1 ? '' : 's'}, ${e.pages} pages (their winning pages and the target pages they beat); ${e.cached} already cached.

`
      + (paid ? `Ahrefs: ${e.ahrefsPages} pages, about ${num(e.ahrefsUnits)} units.
DataForSEO: ${e.htmlPages} pages to read dates from, about $${e.dataforseoUsd}.

Run it?` : 'Everything is cached: no cost. Run it?');
    if (!confirm(msg)) return;
    await api(`/api/studies/${study.id}/explain`, { method: 'POST' }).catch((err) => alert(err.message));
    refreshStatus();
    if (!polling) polling = setInterval(tick, 3000);
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
  $('#domains thead').innerHTML = `<tr>${COLS.map(([k, l, n]) => `<th data-k="${k}" class="${n ? 'num' : ''}">${l}${state.sort === k ? (state.dir < 0 ? ' ↓' : ' ↑') : ''}${helpIcon(k)}</th>`).join('')}</tr>`;
  $('#domains tbody').innerHTML = rows.length
    ? rows
        .map(
          (d) => `<tr data-d="${esc(d.domain)}" class="${d.domain === state.domain ? 'on' : ''}">
      <td><button class="star ${d.picked ? 'on' : ''}" data-star="${esc(d.domain)}" title="${d.picked ? 'Remove from shortlist' : 'Add to shortlist'}">${d.picked ? '★' : '☆'}</button></td>
      <td>${esc(d.domain)}</td>
      <td class="num"><b>${pct(d.weightedReach)}</b></td>
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
  const { rows } = await api(`/api/studies/${state.studyId}/domain?d=${encodeURIComponent(domain)}&${profileQuery()}`);
  const agg = state.data.domains.find((d) => d.domain === domain);
  const wins = rows.filter((r) => r.outcome === 'win');
  const picked = state.picks.has(domain);
  $('#detail').innerHTML = `
    <div class="head"><h3>${esc(domain)} vs ${esc(state.data.study.target)}</h3>
      <span class="muted">${wins.length} wins of ${rows.length} shared searches${agg?.sections?.length ? ` · winning sections: ${agg.sections.map(([s, n]) => `${esc(s)} ${n}`).join(', ')}` : ''}</span>
      <button id="pickBtn" class="${picked ? 'ghost' : ''}">${picked ? '★ Shortlisted — remove' : '☆ Add to shortlist'}</button></div>
    ${picked ? `<textarea id="pickNote" rows="2" placeholder="Why this domain, angle, contact, status… (saved automatically)">${esc(state.picks.get(domain))}</textarea><p class="notes" id="explainLine"></p>` : ''}
    <div class="tablewrap"><table>
      <thead><tr><th>Search</th><th class="num">Weight${helpIcon('weight')}</th><th class="num">Vol</th><th class="num">Them</th><th>Their page</th><th class="num">Target</th><th>Target's page</th></tr></thead>
      <tbody>${rows
        .map(
          (r) => `<tr class="${r.outcome}">
        <td>${esc(r.keyword)}${r.outcome === 'win' ? ' <span class="tag win">win</span>' : ''}</td>
        <td class="num" title="${esc(partsLabel(r.parts))}">${r.weight.toFixed(2)}</td>
        <td class="num">${num(r.volume)}</td>
        <td class="num pos">${r.them.position}</td>
        <td><a href="${href(r.them.url)}" target="_blank" rel="noopener noreferrer">${esc(r.them.title || r.them.url)}</a> <span class="tag">${esc(r.them.type)}</span><div class="u">${esc(r.them.url)}</div></td>
        <td class="num pos">${r.target.position}</td>
        <td><a href="${href(r.target.url)}" target="_blank" rel="noopener noreferrer">${esc(r.target.title || r.target.url)}</a> ${negTag(r.target.negative)}<span class="tag">${esc(r.target.type)}</span></td></tr>`,
        )
        .join('')}</tbody></table></div>`;
  if (picked) {
    api(`/api/studies/${state.studyId}/explain`).then(({ explanations }) => {
      const e = explanations[domain];
      if (!e || !$('#explainLine')) return;
      $('#explainLine').textContent = e.linksKnown || e.agesKnown ? e.sentence : `${e.sentence} Press “Explain shortlist” to add links and page age.`;
    });
  }
  $('#pickBtn').onclick = () => togglePick(domain);
  $('#pickNote')?.addEventListener('change', (e) => savePick(domain, e.target.value));
  if (scroll) $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- decay (item 5) ----------------------------------------------------------------
async function renderDecay(study) {
  const { decay: d, estimate: e } = await api(`/api/studies/${study.id}/decay?${profileQuery()}`);
  if (!$('#decayCard')) return;
  $('#decayCard').innerHTML = `<h2>Does the target fade on its own?${helpIcon('decay')}</h2>
    ${d ? `<p><b>${esc(decayLine(d))}</b></p>${decayChart(d.series)}<p class="muted">The target's median position on ${d.keywords} of these searches, by month (DataForSEO historical snapshots, ${new Date(d.fetchedAt).toLocaleDateString()}, $${d.cost.toFixed(3)}). A month where it was missing counts as just below the last result. Months with fewer than ${d.minKeywordsPerMonth} searches are left off the line${d.series.some((s) => s.thin) ? ` (${d.series.filter((s) => s.thin).map((s) => s.month).join(', ')})` : ''}, since a different mix of searches is not a trend.</p>` : '<p class="muted">Follows the target on its highest-volume searches in scope over the last 12 months.</p>'}
    <button class="ghost" id="decayRun">${d ? 'Re-fetch' : 'Fetch'} 12-month history (${e.keywords} searches, ~$${e.dataforseoUsd})</button>`;
  $('#decayRun').onclick = async () => {
    if (!e.keywords) return alert('No contests in scope under this profile.');
    if (!confirm(`Pull 12 months of Google history for ${e.keywords} searches (highest volume first, weighted in under the current profile)? DataForSEO, about $${e.dataforseoUsd} at the listed price; the real charge is logged.`)) return;
    await api(`/api/studies/${study.id}/decay?${profileQuery()}`, { method: 'POST' }).catch((err) => alert(err.message));
    refreshStatus();
    if (!polling) polling = setInterval(tick, 3000);
  };
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
  const r = await api(`/api/studies/${state.studyId}/report?${profileQuery()}`);
  const s = r.study;
  const scopeLabel = profileLabel(r.profile);
  $('#view').innerHTML = `
    <div class="toolbar noprint"><button class="ghost" id="back">← Back to study</button><button id="print">Print / save as PDF</button></div>
    <article class="report">
      <h2>${esc(s.name || `Outranking ${s.target}`)}</h2>
      <p class="muted">Target: ${esc(s.target)} · ${esc(s.country.toUpperCase())} · weighted for: ${esc(scopeLabel)} · ${num(r.summary.contests)} person-name searches where the target ranks · generated ${new Date().toLocaleDateString()}</p>
      ${s.notes ? `<p class="notes">${esc(s.notes)}</p>` : ''}
      ${s.decay ? `<p><b>${esc(decayLine(s.decay))}</b></p>${decayChart(s.decay.series)}` : ''}
      ${r.picks.length ? '' : '<p class="empty">Nothing shortlisted yet. Star domains in the study table to add them.</p>'}
      ${r.picks
        .map(
          (p) => `<section class="pick">
        <h3>${esc(p.domain)} ${p.stats?.access ? `<span class="tag">${esc(p.stats.access)}</span>` : ''}</h3>
        ${p.stats ? `<p class="muted">Weighted reach <b>${pct(p.stats.weightedReach)}</b> · beats ${esc(s.target)} on <b>${p.stats.wins}</b> searches (${pct(p.stats.reach)} of all) · head-to-head ${pct(p.stats.rawWinRate)} of ${p.stats.appearances} · ${p.stats.people} distinct people · avg ${p.stats.avgGap.toFixed(1)} positions higher · winning pages: ${Object.entries(p.stats.types).map(([t, n]) => `${esc(t)} ${n}`).join(', ') || 'none'}</p>` : '<p class="muted">Not seen alongside the target in this scope.</p>'}
        ${p.explanation ? `<p>${esc(p.explanation.sentence)}</p>` : ''}
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
  if (['all', 'clientReport', 'guide'].includes(state.view)) state.view = 'table';
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
  if (state.view === 'clientReport') return loadClientReport();
  const id = state.clientId;
  await loadClientPicks().catch(() => (state.cPicks = new Map()));
  const c = await api(`/api/clients/${id}`).catch((err) => ({ error: err.message }));
  if (id !== state.clientId) return;
  if (c.error) return ($('#view').innerHTML = `<div class="empty">${esc(c.error)}</div>`);
  state.cdata = c;
  if (!partial || !$('#cSerp')) renderClient();
  renderPlan();
  loadMerged();
  renderPlacements();
}

function renderClient() {
  const { client, targets } = state.cdata;
  const picked = new Set(targets.map((t) => t.url));
  const serp = client.serp ?? [];
  const extra = targets.filter((t) => !serp.some((r) => r.url === t.url));
  $('#view').innerHTML = `
    <div class="head"><h3>${esc(client.name)}</h3>
      <div class="muted">${esc(client.country.toUpperCase())} · name results ${client.serp_at ? `pulled ${new Date(client.serp_at).toLocaleString()}` : 'not pulled yet'} · $${(client.serp_cost ?? 0).toFixed(3)} DataForSEO spent
        <button class="ghost small" id="cResearch">Re-pull name results</button></div>
      <div class="row" style="align-items:flex-end;max-width:620px;margin-top:6px">
        <label>Name's search volume band${helpIcon('nameVolume')} <select id="cBand"><option value="">any (not used in weighting)</option>${state.cdata.volumeBands.map((l, i) => `<option value="${i}" ${client.volume_band === i ? 'selected' : ''}>${l} searches a month</option>`).join('')}</select></label>
        <span class="muted" style="flex:1">${client.volume != null ? `Fetched: ${num(client.volume)} a month.` : 'Pick a band, or fetch the figure.'}</span>
        <button class="ghost small" id="cVolume">Fetch volume (~$${state.cdata.volumeTaskUsd.toFixed(3)})</button></div></div>

    <section class="card"><h2>1 · Google results for “${esc(client.name)}”</h2>
      <p class="muted">Tick the results that are the problem. Headlines that match the negative word list are flagged; it is a rule-based guess, so check each one.</p>
      ${serp.length ? '' : '<p class="empty">Pulling the name results… this takes about 30 seconds.</p>'}
      <div class="tablewrap"><table id="cSerp"><thead><tr><th></th><th class="num">Pos</th><th>Result</th><th>Domain</th></tr></thead><tbody>
      ${serp
        .map(
          (r) => `<tr><td><input type="checkbox" data-url="${esc(r.url)}" data-pos="${r.position}" ${picked.has(r.url) ? 'checked' : ''}></td>
          <td class="num pos">${r.position}</td>
          <td><a href="${href(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.title || r.url)}</a> ${negTag(r.negative, '?')}<span class="tag">${esc(r.type)}</span><div class="u">${esc(r.url)}</div></td>
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
      <p class="muted">Merged = the domain's weighted reach against the host it does worst against. It is inferred from how each domain does against these hosts on other people's names, not a prediction for ${esc(client.name)}'s own results. ★ = already in ${esc(client.name)}'s name results: a property to strengthen, sorted first at equal score.</p>
      <p class="muted">Situation profile (default): each host's contests are weighted by that host's own negative URL — its page type, position and headline — plus the name's volume band. A preset applies the same weighting to every host.</p>
      <div class="toolbar"><div class="tabs" id="cScopes">${[['profile', 'Situation profile'], ...SCOPES].map(([k, l]) => `<button data-scope="${k}" class="${k === state.cMode ? 'on' : ''}">${l}</button>`).join('')}</div>
        <input id="cFilter" placeholder="Filter domains" value="${esc(state.filter)}">
        <button class="ghost" id="cExplain" title="Links and page age for the shortlisted domains' winning pages, against every host">Explain shortlist</button>${helpIcon('explain')}
        <button id="cReport">Plan report</button></div>
      <div class="tablewrap"><table id="cMerged"><thead></thead><tbody></tbody></table></div>
      <div id="cDetail" class="detail"></div>
    </section>

    <section class="card"><h2>4 · Placements and outcomes${helpIcon('placements')}</h2><div id="cPlacements"></div></section>`;

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
  $('#cBand').onchange = async (e) => {
    await api(`/api/clients/${state.clientId}`, { method: 'PATCH', body: JSON.stringify({ volumeBand: e.target.value }) }).catch((err) => alert(err.message));
    loadClient(true);
  };
  $('#cVolume').onclick = async () => {
    if (!confirm(`Look up the monthly Google search volume for "${client.name}"? One DataForSEO call, about $${state.cdata.volumeTaskUsd.toFixed(3)}. It also sets the band.`)) return;
    await api(`/api/clients/${state.clientId}/volume`, { method: 'POST' }).catch((err) => alert(err.message));
    refreshStatus();
    if (!polling) polling = setInterval(tick, 3000);
  };
  $('#cScopes').onclick = (e) => {
    const b = e.target.closest('[data-scope]');
    if (!b) return;
    state.cMode = b.dataset.scope;
    document.querySelectorAll('#cScopes button').forEach((x) => x.classList.toggle('on', x === b));
    loadMerged();
  };
  $('#cFilter').oninput = (e) => {
    state.filter = e.target.value;
    renderMerged();
  };
  $('#cReport').onclick = () => {
    state.view = 'clientReport';
    loadClientReport();
  };
  $('#cExplain').onclick = async () => {
    const { estimate: e } = await api(`/api/clients/${state.clientId}/explain`);
    if (!e.domains) return alert('Star at least one domain in the table first.');
    const paid = e.ahrefsPages || e.htmlPages;
    if (!confirm(`${e.domains} shortlisted domain${e.domains === 1 ? '' : 's'} against ${e.hosts} host${e.hosts === 1 ? '' : 's'}: ${e.pages} pages, ${e.cached} already cached.

` + (paid ? `Ahrefs: ${e.ahrefsPages} pages, about ${num(e.ahrefsUnits)} units.
DataForSEO: ${e.htmlPages} pages, about $${e.dataforseoUsd}.

Run it?` : 'Everything is cached: no cost. Run it?'))) return;
    await api(`/api/clients/${state.clientId}/explain`, { method: 'POST' }).catch((err) => alert(err.message));
    refreshStatus();
    if (!polling) polling = setInterval(tick, 3000);
  };
}

function runForm() {
  const d = state.defaults ?? {};
  return `<div class="row">
      <label>Keywords per host <input name="limit" type="number" min="1" max="10000" value="${d.limit ?? 300}"></label>
      <label>Min words <input name="minWords" type="number" min="0" max="10" value="${d.minWords ?? 2}"></label>
      <label>Max words <input name="maxWords" type="number" min="0" max="10" value="${d.maxWords ?? 2}"></label>
      <label>Target pos ≤ <input name="maxPosition" type="number" min="1" max="100" value="${d.maxPosition ?? 20}"></label>
      <label>Device <select name="device"><option>desktop</option><option>mobile</option></select></label></div>`;
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
        <td>${esc(ACTION_LABEL[h.action] ?? h.action)}${h.studyId ? ` · <a href="#" data-open-study="${h.studyId}">study #${h.studyId}</a> (${esc(h.device)})` : ''}</td>
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
    const e = await api(`/api/clients/${state.clientId}/estimate?limit=${encodeURIComponent(p.limit)}&maxPosition=${encodeURIComponent(p.maxPosition)}&device=${encodeURIComponent(p.device || 'desktop')}&rerun=${encodeURIComponent([...state.rerun].join(','))}`).catch(() => null);
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
  const m = await api(`/api/clients/${id}/merged?mode=${state.cMode}`).catch((err) => ({ error: err.message }));
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
  $('#cMerged thead').innerHTML = `<tr><th>★${helpIcon('picked')}</th><th>Domain</th><th class="num">Merged reach${helpIcon('merged')}</th><th class="num">In name results${helpIcon('inNameSerp')}</th>
    ${hosts.map((h) => `<th class="num" title="${h.counted ? '' : 'Too few searches to count toward the merged score'}">vs ${esc(h.domain)}${helpIcon('perHost')}<br><span class="muted">${h.studyId ? `${h.contests} searches (${h.effectiveContests.toFixed(1)} effective)${h.counted ? '' : ` · not counted${helpIcon('hostThin')}`}` : 'not studied yet'}</span><br><span class="muted" title="Weighting profile for this host">${esc(profileLabel(h.profile))}</span></th>`).join('')}
    <th class="num">Total wins${helpIcon('wins')}</th><th>Access${helpIcon('access')}</th><th>Winning page types${helpIcon('types')}</th></tr>`;
  $('#cMerged tbody').innerHTML = rows.length
    ? rows
        .map(
          (d) => `<tr data-cd="${esc(d.domain)}" class="${d.domain === state.cDomain ? 'on' : ''}">
        <td><button class="star ${state.cPicks?.has(d.domain) ? 'on' : ''}" data-cstar="${esc(d.domain)}" title="Shortlist for the plan">${state.cPicks?.has(d.domain) ? '★' : '☆'}</button></td>
        <td>${d.inNameSerp ? '<span class="star on" title="Already in the name results">★</span> ' : ''}${esc(d.domain)}</td>
        <td class="num"><b>${pct(d.merged)}</b></td>
        <td class="num">${d.inNameSerp ? `#${d.inNameSerp}` : '–'}</td>
        ${hosts.map((h) => { const p = d.perHost[h.domain]; return `<td class="num ${h.domain === d.hardestHost && hosts.length > 1 ? 'weak' : ''}" title="weighted ${pct(p.reach)} · plain ${pct(p.rawReach ?? p.reach)} · ${p.wins} wins of ${p.contests} searches">${h.studyId ? pct(p.reach) : '–'}</td>`; }).join('')}
        <td class="num">${d.totalWins}</td>
        <td>${d.access ? `<span class="tag">${esc(d.access)}</span>` : ''}</td>
        <td>${Object.entries(d.types).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, n]) => `<span class="tag">${esc(t)} ${n}</span>`).join('')}</td></tr>`,
        )
        .join('')
    : `<tr><td colspan="${hosts.length + 7}" class="muted">${hosts.some((h) => h.studyId) ? 'No domains match.' : 'Run the studies to see domains here.'}</td></tr>`;
  $('#cMerged tbody').onclick = (e) => {
    const star = e.target.closest('[data-cstar]');
    if (star) return toggleClientPick(star.dataset.cstar);
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
      .map(async (h) => ({ h, rows: (await api(`/api/studies/${h.studyId}/domain?d=${encodeURIComponent(domain)}&profile=${encodeURIComponent(JSON.stringify(h.profile ?? {}))}`)).rows })),
  );
  $('#cDetail').innerHTML = `
    <div class="head"><h3>${esc(domain)}</h3>
      <button id="cPickBtn" class="${state.cPicks?.has(domain) ? 'ghost' : ''}">${state.cPicks?.has(domain) ? '★ Shortlisted — remove' : '☆ Shortlist for the plan'}</button>
      <span class="muted">${d?.inNameSerp ? `Already at #${d.inNameSerp} for ${esc(state.cdata.client.name)}: <a href="${href(d.nameSerpUrl)}" target="_blank" rel="noopener noreferrer">${esc(d.nameSerpUrl)}</a>` : `Not in ${esc(state.cdata.client.name)}'s name results yet.`}</span></div>
    ${state.cPicks?.has(domain) ? `<textarea id="cPickNote" rows="2" placeholder="Angle, contact, status… (saved automatically)">${esc(state.cPicks.get(domain))}</textarea>` : ''}
    ${parts
      .map(({ h, rows }) => {
        const wins = rows.filter((r) => r.outcome === 'win');
        return `<h2 style="margin-top:12px">vs ${esc(h.domain)}: ${wins.length} wins of ${rows.length} shared searches</h2>
        ${wins.length ? `<div class="tablewrap"><table><thead><tr><th>Search</th><th class="num">Weight</th><th class="num">Them</th><th>Their page</th><th class="num">${esc(h.domain)}</th></tr></thead><tbody>
        ${wins.slice(0, 15).map((r) => `<tr><td>${esc(r.keyword)}</td><td class="num" title="${esc(partsLabel(r.parts))}">${r.weight.toFixed(2)}</td><td class="num pos">${r.them.position}</td><td><a href="${href(r.them.url)}" target="_blank" rel="noopener noreferrer">${esc(r.them.title || r.them.url)}</a> <span class="tag">${esc(r.them.type)}</span></td><td class="num pos">${r.target.position}</td></tr>`).join('')}
        </tbody></table></div>${wins.length > 15 ? `<p class="muted">${wins.length - 15} more in <a href="#" data-open-study="${h.studyId}">study #${h.studyId}</a>.</p>` : ''}` : '<p class="muted">No wins against this host.</p>'}`;
      })
      .join('')}`;
  $('#cPickBtn').onclick = () => toggleClientPick(domain);
  $('#cPickNote')?.addEventListener('change', async (e) => {
    await api(`/api/clients/${state.clientId}/picks`, { method: 'PUT', body: JSON.stringify({ domain, note: e.target.value }) });
    await loadClientPicks();
  });
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

// ---- all studies (item 6) -------------------------------------------------------------
// Every domain across the newest study of every target: the house ranking of
// placement domains by how many targets they beat, and how regularly.

const ALL_COLS = [
  ['domain', 'Domain', false],
  ['targetsBeaten', 'Targets beaten', true],
  ['weightedReach', 'Weighted reach', true],
  ['wins', 'Wins', true],
  ['contests', 'Contests', true],
  ['reach', 'Reach', true],
  ['rawWinRate', 'Head-to-head', true],
  ['appearances', 'Seen with target', true],
  ['people', 'People', true],
  ['avgGap', 'Avg gap', true],
  ['top3Wins', 'Top-3 wins', true],
  ['volumeWon', 'Volume won', true],
  ['access', 'Access', false],
  ['types', 'Winning page types', false],
];
state.all = { scope: 'all', min: 2, minTargets: 1, sort: 'targetsBeaten', dir: -1, filter: '', domain: null, data: null };

$('#openAll').addEventListener('click', () => {
  state.studyId = null;
  state.clientId = null;
  state.view = 'all';
  refreshStatus();
  loadAll();
});

async function loadAll() {
  const a = state.all;
  const d = await api(`/api/all?scope=${a.scope}&min=${a.min}&minTargets=${a.minTargets}`).catch((err) => ({ error: err.message }));
  if (state.view !== 'all') return;
  if (d.error) return ($('#view').innerHTML = `<div class="empty">${esc(d.error)}</div>`);
  a.data = d;
  $('#view').innerHTML = `
    <div class="head"><h3>All studies</h3>
      <div class="muted">${d.studies.length} target${d.studies.length === 1 ? '' : 's'}: ${d.studies.map((s) => `${esc(s.target)} (${s.contests})`).join(' · ')}. The newest study per target and country counts; nothing here costs API credit.</div></div>
    <div class="toolbar">
      <div class="tabs" id="allScopes">${SCOPES.map(([k, l]) => `<button data-scope="${k}" class="${k === a.scope ? 'on' : ''}">${l}</button>`).join('')}</div>
      <label style="flex:0;flex-direction:row;align-items:center;gap:6px;margin:0">Seen with targets ≥ <input id="allMin" type="number" min="1" value="${a.min}" style="width:60px"></label>
      <label style="flex:0;flex-direction:row;align-items:center;gap:6px;margin:0">Targets met ≥ <input id="allMinT" type="number" min="1" value="${a.minTargets}" style="width:60px"></label>
      <input id="allFilter" placeholder="Filter domains" value="${esc(a.filter)}">
    </div>
    <div class="tablewrap"><table id="allTable"><thead></thead><tbody></tbody></table></div>
    <p class="muted">Targets beaten = targets it won at least one contest against, of the targets it met. Contests = the contests of the studies it appeared in; reach = wins ÷ those. A preset applies to every study.</p>
    <div id="allDetail" class="detail"></div>
    <section class="card" id="calibration" style="margin-top:16px"></section>`;
  renderCalibration();
  $('#allScopes').onclick = (e) => {
    const b = e.target.closest('[data-scope]');
    if (!b) return;
    a.scope = b.dataset.scope;
    loadAll();
  };
  $('#allMin').onchange = (e) => {
    a.min = Math.max(1, Number(e.target.value) || 1);
    loadAll();
  };
  $('#allMinT').onchange = (e) => {
    a.minTargets = Math.max(1, Number(e.target.value) || 1);
    loadAll();
  };
  $('#allFilter').oninput = (e) => {
    a.filter = e.target.value;
    renderAllTable();
  };
  renderAllTable();
  if (a.domain) renderAllDetail(a.domain);
}

function renderAllTable() {
  const a = state.all;
  const f = a.filter.trim().toLowerCase();
  const rows = a.data.domains
    .filter((d) => !f || d.domain.includes(f))
    .sort((x, y) => {
      const [p, q] = [x[a.sort], y[a.sort]];
      return (typeof p === 'string' || p == null ? String(p ?? '').localeCompare(String(q ?? '')) : p - q) * a.dir;
    })
    .slice(0, 300);
  $('#allTable thead').innerHTML = `<tr>${ALL_COLS.map(([k, l, n]) => `<th data-k="${k}" class="${n ? 'num' : ''}">${l}${a.sort === k ? (a.dir < 0 ? ' ↓' : ' ↑') : ''}${helpIcon(k === 'contests' ? 'allContests' : k)}</th>`).join('')}</tr>`;
  $('#allTable tbody').innerHTML = rows.length
    ? rows
        .map(
          (d) => `<tr data-ad="${esc(d.domain)}" class="${d.domain === a.domain ? 'on' : ''}">
      <td>${esc(d.domain)}${d.isTarget ? ' <span class="tag neg" title="Also studied as a target">target</span>' : ''}</td>
      <td class="num"><b>${d.targetsBeaten}</b> of ${d.targetsMet}</td>
      <td class="num">${pct(d.weightedReach)}</td>
      <td class="num">${d.wins}</td>
      <td class="num">${d.contests}</td>
      <td class="num">${pct(d.reach)}</td>
      <td class="num">${pct(d.rawWinRate)}</td>
      <td class="num">${d.appearances}</td>
      <td class="num">${d.people}</td>
      <td class="num">${d.wins ? d.avgGap.toFixed(1) : '–'}</td>
      <td class="num">${d.top3Wins}</td>
      <td class="num">${num(d.volumeWon)}</td>
      <td>${d.access ? `<span class="tag">${esc(d.access)}</span>` : ''}</td>
      <td>${Object.entries(d.types).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([t, n]) => `<span class="tag">${esc(t)} ${n}</span>`).join('')}</td></tr>`,
        )
        .join('')
    : `<tr><td colspan="${ALL_COLS.length}" class="muted">${a.data.studies.length ? 'No domains match.' : 'No finished studies yet.'}</td></tr>`;
  $('#allTable thead').onclick = (e) => {
    const th = e.target.closest('th');
    if (!th) return;
    if (a.sort === th.dataset.k) a.dir *= -1;
    else [a.sort, a.dir] = [th.dataset.k, th.classList.contains('num') ? -1 : 1];
    renderAllTable();
  };
  $('#allTable tbody').onclick = (e) => {
    const tr = e.target.closest('tr[data-ad]');
    if (!tr) return;
    a.domain = tr.dataset.ad;
    document.querySelectorAll('#allTable tbody tr').forEach((x) => x.classList.toggle('on', x.dataset.ad === a.domain));
    renderAllDetail(a.domain, true);
  };
}

function renderAllDetail(domain, scroll) {
  const d = state.all.data.domains.find((x) => x.domain === domain);
  if (!d) return ($('#allDetail').innerHTML = '');
  $('#allDetail').innerHTML = `
    <div class="head"><h3>${esc(domain)} against each target</h3><span class="muted">Open a study to see the winning pages.</span></div>
    <div class="tablewrap"><table><thead><tr><th>Target</th><th class="num">Wins</th><th class="num">Contests</th><th class="num">Reach</th><th></th></tr></thead><tbody>
    ${d.targets.map((t) => `<tr><td>${esc(t.target)} <span class="muted">${esc(t.country.toUpperCase())}</span></td><td class="num">${t.wins}</td><td class="num">${t.contests}</td><td class="num">${pct(t.reach)}</td><td><a href="#" data-open-study="${t.studyId}" data-open-domain="${esc(domain)}">open study #${t.studyId}</a></td></tr>`).join('')}
    </tbody></table></div>`;
  $('#allDetail').onclick = (e) => {
    const link = e.target.closest('[data-open-study]');
    if (!link) return;
    e.preventDefault();
    state.view = 'table';
    state.studyId = Number(link.dataset.openStudy);
    state.domain = link.dataset.openDomain;
    state.pMode = 'saved';
    refreshStatus();
    loadStudy();
  };
  if (scroll) $('#allDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- placements & outcomes (item 7) ------------------------------------------------------
const OUTCOME_LABEL = { 'beats-all': 'above every negative URL', 'beats-some': 'above some negative URLs', 'below-all': 'below every negative URL', 'not-ranking': `not in the top 30` };

async function renderPlacements() {
  const id = state.clientId;
  const p = await api(`/api/clients/${id}/placements`).catch(() => null);
  if (!p || id !== state.clientId || !$('#cPlacements')) return;
  const last = p.checks[0];
  $('#cPlacements').innerHTML = `
    <p class="muted">Log what was published for ${esc(state.cdata.client.name)}, then press “Check now” from time to time: one live search for the name (about $0.005) records where each placement and each problem URL sits. Nothing runs on its own.</p>
    <form id="cPlaceForm" class="row" style="align-items:flex-end;flex-wrap:wrap">
      <label style="flex:3;min-width:220px">Placement URL <input name="url" placeholder="https://…" required></label>
      <label style="flex:1;min-width:140px">Published <input name="publishedAt" type="date"></label>
      <button type="submit" style="margin-bottom:8px">Add placement</button>
    </form>
    ${p.placements.length ? `<div class="tablewrap"><table><thead><tr><th>Placement</th><th class="num">Predicted${helpIcon('predicted')}</th><th>Published</th><th>History (oldest → newest)</th><th>Latest${helpIcon('outcome')}</th><th></th></tr></thead><tbody>
      ${p.placements.map((x) => `<tr>
        <td><a href="${href(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.domain)}</a><div class="u">${esc(x.url)}</div></td>
        <td class="num" title="Merged weighted reach of the domain when it was added">${x.predicted_reach == null ? '–' : pct(x.predicted_reach)}</td>
        <td>${esc(x.published_at ?? '–')}</td>
        <td>${x.history.length ? x.history.map((h) => `<span class="tag" title="${esc(new Date(h.checkedAt).toLocaleString())}">${h.position ? `#${h.position}` : '–'}</span>`).join('') : '<span class="muted">not checked yet</span>'}</td>
        <td>${x.latest ? `<span class="tag ${x.latest.outcome === 'beats-all' ? 'win' : x.latest.outcome === 'beats-some' ? '' : 'neg'}">${esc(OUTCOME_LABEL[x.latest.outcome])}</span> <span class="muted">${x.latest.beaten}/${x.latest.of}</span>` : ''}</td>
        <td><button class="x" data-pdel="${x.id}" title="Remove placement">×</button></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">No placements logged yet.</p>'}
    ${last ? `<p class="muted">Last check ${esc(new Date(last.checkedAt).toLocaleString())}: problem URLs at ${last.negatives.map((n) => `${n.position ? `#${n.position}` : 'not in top 30'}`).join(', ') || 'none'}. ${p.checks.length} check${p.checks.length === 1 ? '' : 's'} so far.</p>` : ''}
    <button class="ghost" id="cCheck">Check now (~$0.005)</button>`;
  $('#cPlaceForm').onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    await api(`/api/clients/${id}/placements`, { method: 'POST', body: JSON.stringify(body) }).catch((err) => alert(err.message));
    renderPlacements();
  };
  $('#cPlacements').onclick = async (e) => {
    const del = e.target.closest('[data-pdel]');
    if (!del) return;
    if (!confirm('Remove this placement and its position history?')) return;
    await api(`/api/clients/${id}/placements?pid=${del.dataset.pdel}`, { method: 'DELETE' }).catch((err) => alert(err.message));
    renderPlacements();
  };
  $('#cCheck').onclick = async () => {
    if (!confirm(`Pull the live Google results for "${state.cdata.client.name}" and log where the placements and problem URLs sit? One DataForSEO call, about $0.005.`)) return;
    await api(`/api/clients/${id}/check`, { method: 'POST' }).catch((err) => alert(err.message));
    refreshStatus();
    if (!polling) polling = setInterval(tick, 3000);
  };
}

/** Calibration across every client, under the All studies table. */
async function renderCalibration() {
  const { rows } = await api('/api/calibration').catch(() => ({ rows: [] }));
  if (!$('#calibration')) return;
  $('#calibration').innerHTML = `<h2>Calibration: predicted vs observed${helpIcon('calibration')}</h2>
    <p class="muted">Every checked placement: the merged weighted reach the tool gave its domain when it was added, against where it sat at its latest check. This is how to learn whether the scoring is right.</p>
    ${rows.length ? `<div class="tablewrap"><table><thead><tr><th>Client</th><th>Domain</th><th class="num">Predicted${helpIcon('predicted')}</th><th class="num">Days live</th><th class="num">Checks</th><th class="num">Position</th><th>Outcome${helpIcon('outcome')}</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${esc(r.client)}</td><td><a href="${href(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.domain)}</a></td><td class="num">${r.predictedReach == null ? '–' : pct(r.predictedReach)}</td><td class="num">${r.daysLive ?? '–'}</td><td class="num">${r.checks}</td><td class="num">${r.position ? `#${r.position}` : '–'}</td><td>${esc(OUTCOME_LABEL[r.outcome])} <span class="muted">${r.beaten}/${r.of}</span></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">No placements have been checked yet.</p>'}`;
}

// ---- client shortlist & plan report (item 8) ---------------------------------------------

async function loadClientPicks() {
  const { picks } = await api(`/api/clients/${state.clientId}/picks`);
  state.cPicks = new Map(picks.map((p) => [p.domain, p.note]));
}

async function toggleClientPick(domain) {
  if (state.cPicks.has(domain)) {
    if (state.cPicks.get(domain) && !confirm(`Remove ${domain} and its note from the shortlist?`)) return;
    await api(`/api/clients/${state.clientId}/picks?d=${encodeURIComponent(domain)}`, { method: 'DELETE' });
  } else await api(`/api/clients/${state.clientId}/picks`, { method: 'PUT', body: JSON.stringify({ domain, note: '' }) });
  await loadClientPicks();
  renderMerged();
  if (state.cDomain === domain) loadClientDomain(domain, false);
}

const PLAN_OUTCOME_HINT = 'Inferred from how each domain does against these hosts on other people’s names; not a prediction for this name.';

function planDomainBlock(s, hosts) {
  const studied = hosts.filter((h) => h.studyId);
  const why = studied.map((h) => (s.why[h.domain] ? `<li><b>vs ${esc(h.domain)}:</b> ${esc(s.why[h.domain])}</li>` : '')).join('');
  const types = Object.entries(s.types).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([t]) => t).join(', ');
  return `<section class="pick">
    <h3>${esc(s.domain)} ${s.access ? `<span class="tag">${esc(s.access)}</span>` : ''}${s.inNameSerp ? ` <span class="tag win">now #${s.inNameSerp}</span>` : ''}</h3>
    ${s.found
      ? `<p>Weighted reach <b>${pct(s.merged)}</b> against ${studied.length > 1 ? `the hardest host${s.hardestHost ? ` (${esc(s.hardestHost)})` : ''}` : esc(studied[0]?.domain ?? 'the host')}${studied.length > 1 ? `; ${studied.map((h) => `${esc(h.domain)} ${pct(s.perHost[h.domain]?.reach ?? 0)}`).join(' · ')}` : ''}. Wins with ${esc(types || 'no page type yet')}${s.sections.length ? ` pages, mostly in ${s.sections.map(([x]) => esc(x)).join(', ')}` : ''}.</p>`
      : '<p class="muted">Not seen against these hosts in the studies.</p>'}
    ${why ? `<ul class="why">${why}</ul>` : ''}
    ${s.inNameSerp && s.nameSerpUrl ? `<p class="muted">Existing page: ${esc(s.nameSerpUrl)}</p>` : ''}
    ${s.note ? `<p class="notes">${esc(s.note)}</p>` : ''}
  </section>`;
}

async function loadClientReport() {
  const r = await api(`/api/clients/${state.clientId}/report`).catch((err) => ({ error: err.message }));
  if (state.view !== 'clientReport') return;
  if (r.error) return ($('#view').innerHTML = `<div class="empty">${esc(r.error)}</div>`);
  const c = r.client;
  $('#view').innerHTML = `
    <div class="toolbar noprint"><button class="ghost" id="cBack">← Back to ${esc(c.name)}</button><button id="cPrint">Print / save as PDF</button></div>
    <article class="report plan">
      <h2>Plan: ${esc(c.name)}</h2>
      <p class="muted">${esc(c.country.toUpperCase())} Google · name results pulled ${c.serpAt ? esc(new Date(c.serpAt).toLocaleDateString()) : '–'} · generated ${new Date().toLocaleDateString()}. ${PLAN_OUTCOME_HINT}</p>

      <h3 class="sec">1. What Google shows for “${esc(c.name)}”</h3>
      <table class="compact"><tbody>
      ${r.serp.map((x) => `<tr class="${x.problem ? 'problem' : ''}"><td class="num">${x.position}</td><td>${esc(x.title || x.url)} <span class="muted">${esc(x.domain)}</span></td><td>${x.problem ? '<span class="tag neg">problem</span>' : ''}${x.shortlisted && !x.problem ? '<span class="tag win">shortlisted</span>' : ''}</td></tr>`).join('')}
      </tbody></table>
      ${r.offSerp.length ? `<p class="muted">Also flagged, outside the top ${r.serp.length}: ${r.offSerp.map((t) => esc(t.url)).join(', ')}</p>` : ''}

      <h3 class="sec">2. Will the problem fade on its own?</h3>
      ${r.hosts.map((h) => `<div class="decayblock"><b>${esc(h.domain)}</b>: ${h.decay ? `${esc(decayLine(h.decay))}${decayChart(h.decay.series)}` : `<span class="muted">${h.studyId ? `not measured; fetch the 12-month history on study #${h.studyId}.` : 'not studied yet.'}</span>`}</div>`).join('')}

      <h3 class="sec">3. Strengthen what is already there</h3>
      ${r.strengthen.length ? r.strengthen.map((s) => planDomainBlock(s, r.hosts)).join('') : '<p class="muted">No shortlisted domain is in the name results yet.</p>'}

      <h3 class="sec">4. New placements</h3>
      ${r.newPlacements.length ? r.newPlacements.map((s) => planDomainBlock(s, r.hosts)).join('') : '<p class="muted">No other shortlisted domains. Star domains in the client table to add them.</p>'}
    </article>`;
  $('#cBack').onclick = () => {
    state.view = 'table';
    loadClient();
  };
  $('#cPrint').onclick = () => window.print();
}

installHelp();

// ---- quickstart guide -------------------------------------------------------------------
// guide.md is the one source; this renders the small subset of Markdown it uses.

function renderMarkdown(md) {
  const inline = (s) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\*(.+?)\*/g, '<i>$1</i>')
      .replace(/`(.+?)`/g, '<code>$1</code>');
  const out = [];
  const lines = md.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      out.push(`<h${m[1].length + 1} class="g">${inline(m[2])}</h${m[1].length + 1}>`);
      i++;
    } else if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const body = rows.filter((r) => !/^\|[\s:|-]+\|$/.test(r));
      out.push(`<div class="tablewrap"><table><thead><tr>${cells(body[0]).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.slice(1).map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''));
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
    } else if (line.startsWith('>')) {
      const q = [];
      while (i < lines.length && lines[i].startsWith('>')) q.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<p class="notes">${inline(q.join(' '))}</p>`);
    } else {
      const p = [];
      while (i < lines.length && lines[i].trim() && !/^(#|\||>|\s*([-*]|\d+\.)\s)/.test(lines[i])) p.push(lines[i++]);
      out.push(`<p>${inline(p.join(' '))}</p>`);
    }
  }
  return out.join('\n');
}

async function openGuide() {
  state.studyId = null;
  state.clientId = null;
  state.view = 'guide';
  refreshStatus();
  const md = await fetch('guide.md').then((r) => r.text()).catch(() => '# Guide unavailable');
  if (state.view !== 'guide') return;
  $('#view').innerHTML = `<article class="report guide">${renderMarkdown(md)}</article>`;
  window.scrollTo(0, 0);
}
$('#openGuide').addEventListener('click', openGuide);
document.addEventListener('click', (e) => {
  if (e.target.id === 'emptyGuide') {
    e.preventDefault();
    openGuide();
  }
});
