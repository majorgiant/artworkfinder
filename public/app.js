// Artwork Finder frontend — hash-routed single page app, no build step.

const $ = (sel, el = document) => el.querySelector(sel);
const app = $('#app');
const lb = $('#lightbox');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let keyStatus = { hasTmdb: false, hasFanart: false };

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const KIND_LABELS = {
  all: 'All', poster: 'Posters', backdrop: 'Backdrops', logo: 'Logos', still: 'Stills', clearart: 'ClearArt',
  character: 'Character art', thumb: 'Thumbs', banner: 'Banners', season: 'Season posters', disc: 'Disc art',
  titlecard: 'Title cards', other: 'Other art', web: 'Google Images',
};
// Artwork straight from the streaming services and review sites (vs. community databases).
const OFFICIAL = new Set(['Apple TV', 'Prime Video', 'Netflix', 'Disney+', 'Plex', 'Rotten Tomatoes']);
// Fan-made artwork by other designers, marked as such on each card.
const FAN_ART = new Set(['PosterSpy']);
const TEXTLESS_KINDS = new Set(['poster', 'backdrop', 'season']);
const WIDE_KINDS = new Set(['titlecard', 'backdrop', 'thumb', 'banner', 'logo', 'clearart']);
const LANG_NAMES = new Intl.DisplayNames(['en'], { type: 'language' });
const langName = l => { try { return LANG_NAMES.of(l); } catch { return l; } };

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
function route() {
  const [path, qs] = location.hash.slice(1).split('?');
  const params = new URLSearchParams(qs);
  const parts = (path || '/').split('/').filter(Boolean);
  if (!lb.hidden) closeLightbox();
  $('#selectionBar')?.remove();
  pendingRedraw = null;
  $('#updatesReady')?.remove();
  window.scrollTo(0, 0);
  if (parts[0] === 'search') return renderSearch(params.get('q') || '');
  if (parts[0] === 'title') return renderTitle(parts[1], parts[2]);
  if (parts[0] === 'sources') return renderSources();
  renderHome();
}
window.addEventListener('hashchange', route);

$('#searchForm').addEventListener('submit', e => {
  e.preventDefault();
  const q = $('#searchInput').value.trim();
  if (q) location.hash = '#/search?q=' + encodeURIComponent(q);
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const settings = $('#settings');
function updateKeyStatus() {
  for (const el of settings.querySelectorAll('[data-status]')) {
    const ok = keyStatus[el.dataset.status];
    el.textContent = ok ? '✓ configured' : 'not set';
    el.className = ok ? 'ok' : 'missing';
  }
}
function openSettings() {
  updateKeyStatus();
  const [pw, ph] = posterSize();
  $('#settingsForm').posterW.value = pw;
  $('#settingsForm').posterH.value = ph;
  $('#sourceToggles').innerHTML = (keyStatus.sources || []).map(s => `
    <label class="toggle"><input type="checkbox" name="source" value="${esc(s.id)}" ${s.enabled ? 'checked' : ''}> ${esc(s.name)}</label>`).join('');
  settings.showModal();
}
const sourceEnabled = id => (keyStatus.sources || []).find(s => s.id === id)?.enabled !== false;
$('#settingsBtn').addEventListener('click', openSettings);
settings.addEventListener('close', async () => {
  const form = $('#settingsForm');
  if (settings.returnValue === 'save') {
    const body = {};
    if (form.tmdbKey.value) body.tmdbKey = form.tmdbKey.value;
    if (form.fanartKey.value) body.fanartKey = form.fanartKey.value;
    if (form.serpKey.value) body.serpKey = form.serpKey.value;
    if (form.tvdbKey.value) body.tvdbKey = form.tvdbKey.value;
    if (form.tvdbPin.value) body.tvdbPin = form.tvdbPin.value;
    const disabled = [...form.querySelectorAll('[name=source]')].filter(c => !c.checked).map(c => c.value);
    const wasDisabled = (keyStatus.sources || []).filter(s => !s.enabled).map(s => s.id);
    if (disabled.join() !== wasDisabled.join()) body.disabledSources = disabled;
    const size = [+form.posterW.value, +form.posterH.value];
    if (size.every(n => n >= 100) && size.join() !== posterSize().join()) body.posterSize = size;
    if (Object.keys(body).length) {
      keyStatus = await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      route();
    }
  }
  form.reset();
});

function keyNotice() {
  if (keyStatus.hasTmdb && keyStatus.hasFanart) return '';
  const missing = [!keyStatus.hasTmdb && 'TMDB', !keyStatus.hasFanart && 'fanart.tv'].filter(Boolean).join(' and ');
  const extra = !keyStatus.hasTmdb ? ' Without TMDB, search covers TV shows only (via TVmaze).' : '';
  return `<div class="notice">Add a free ${missing} API key to unlock all artwork.${extra}
    <button class="btn" onclick="openSettings()">Add keys</button></div>`;
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
function renderHome() {
  document.title = 'Artwork Finder';
  app.innerHTML = `
    <section class="hero-home">
      <h1>Find artwork for your posters</h1>
      <p>Search any movie or TV show to pull posters, textless key art, backdrops, logos and stills from streaming services,
        Rotten Tomatoes, Plex, TMDB, fanart.tv and Google Images — in one gallery.</p>
    </section>
    ${keyNotice()}
    <div class="feature-grid">
      <div class="feature"><h3>Textless filter</h3><p>One click to show only posters and backdrops with no title text — ready for your own typography.</p></div>
      <div class="feature"><h3>Logos & ClearArt</h3><p>Transparent title logos, ClearArt and character art from fanart.tv for compositing.</p></div>
      <div class="feature"><h3>Straight from the streamers</h3><p>Hero art, logos and stills from Apple TV, Prime Video, Netflix, Disney+, Plex and Rotten Tomatoes — often in 4K.</p></div>
      <div class="feature"><h3>Google Images, inline</h3><p>Add a free SerpAPI key and large Google Images results appear right in the gallery.</p></div>
      <div class="feature"><h3>Find a bigger version</h3><p>Reverse-search any image on Google Lens, TinEye, Yandex and Bing to hunt down higher resolutions.</p></div>
    </div>`;
  $('#searchInput').focus();
  drawHomeHistory();
}

// ---------------------------------------------------------------------------
// History: recent searches and opened titles (saved by the server in data/history.json)
// ---------------------------------------------------------------------------
let historyData = { searches: [], titles: [] };

function remember(entry) {
  api('/api/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) })
    .then(h => { historyData = h; }).catch(() => {});
}

async function forget(params) {
  historyData = await api('/api/history' + (params ? '?' + new URLSearchParams(params) : ''), { method: 'DELETE' }).catch(() => historyData);
}

const titleHref = x => `#/title/${x.type}/${x.id}`;
const searchHref = x => '#/search?q=' + encodeURIComponent(x.q);

async function drawHomeHistory() {
  historyData = await api('/api/history').catch(() => historyData);
  const { searches, titles } = historyData;
  const old = $('#homeHistory');
  if (old) old.remove();
  if (!searches.length && !titles.length) return;
  const section = document.createElement('section');
  section.id = 'homeHistory';
  section.className = 'history';
  section.innerHTML = `
    <div class="section-title"><h2>Recently viewed</h2>
      <button class="btn ghost" id="clearHistory">Clear history</button></div>
    ${titles.length ? `<div class="history-titles">${titles.map(x => `
      <a class="history-title" href="${titleHref(x)}">
        <div class="poster">${x.poster ? `<img loading="lazy" src="${esc(x.poster)}" alt="">` : `<div class="ph">${esc(x.title)}</div>`}</div>
        <span>${esc(x.title)}${x.year ? ` <span class="muted">${esc(x.year)}</span>` : ''}</span>
        <button class="remove" title="Remove from history" data-type="${esc(x.type)}" data-id="${esc(x.id)}">×</button>
      </a>`).join('')}</div>` : ''}
    ${searches.length ? `<div class="history-searches"><span class="muted">Searches</span>${searches.map(x => `
      <span class="history-search"><a href="${searchHref(x)}">${esc(x.q)}</a><button class="remove" title="Remove from history" data-search="${esc(x.q)}">×</button></span>`).join('')}</div>` : ''}`;
  ($('.hero-home') || app.firstChild)?.after(section);
  bindHistoryButtons(section, drawHomeHistory);
}

function bindHistoryButtons(root, redraw) {
  root.querySelectorAll('.remove').forEach(b => b.onclick = async e => {
    e.preventDefault();
    e.stopPropagation();
    await forget(b.dataset.search ? { search: b.dataset.search } : { type: b.dataset.type, id: b.dataset.id });
    redraw();
  });
  const clear = root.querySelector('#clearHistory, .clear-history');
  if (clear) clear.onclick = async e => {
    e.preventDefault();
    if (!confirm('Clear your search history and recently viewed titles?')) return;
    await forget();
    redraw();
  };
}

// Dropdown under the search box with recent items, while the box is empty.
const searchInput = $('#searchInput');
const dropdown = document.createElement('div');
dropdown.className = 'history-dropdown';
dropdown.hidden = true;
$('#searchForm').appendChild(dropdown);

async function showDropdown() {
  if (searchInput.value.trim() || location.hash.replace('#', '') in { '': 1, '/': 1 }) { dropdown.hidden = true; return; }
  historyData = await api('/api/history').catch(() => historyData);
  const { searches, titles } = historyData;
  if (!searches.length && !titles.length) { dropdown.hidden = true; return; }
  dropdown.innerHTML = `
    ${titles.slice(0, 6).map(x => `<a class="dd-item" href="${titleHref(x)}">
      ${x.poster ? `<img src="${esc(x.poster.replace('/w500/', '/w92/'))}" alt="">` : '<span class="dd-icon">🎬</span>'}
      <span>${esc(x.title)} <span class="muted">${esc(x.year)}</span></span>
      <button class="remove" title="Remove" data-type="${esc(x.type)}" data-id="${esc(x.id)}">×</button></a>`).join('')}
    ${searches.slice(0, 6).map(x => `<a class="dd-item" href="${searchHref(x)}"><span class="dd-icon">⌕</span><span>${esc(x.q)}</span>
      <button class="remove" title="Remove" data-search="${esc(x.q)}">×</button></a>`).join('')}
    <button type="button" class="dd-clear clear-history">Clear history</button>`;
  dropdown.hidden = false;
  bindHistoryButtons(dropdown, showDropdown);
  dropdown.querySelectorAll('.dd-item').forEach(a => a.addEventListener('click', () => { dropdown.hidden = true; }));
}
searchInput.addEventListener('focus', showDropdown);
searchInput.addEventListener('click', showDropdown);
searchInput.addEventListener('input', () => { if (searchInput.value.trim()) dropdown.hidden = true; else showDropdown(); });
document.addEventListener('pointerdown', e => { if (!e.target.closest('#searchForm')) dropdown.hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') dropdown.hidden = true; });
$('#searchForm').addEventListener('submit', () => { dropdown.hidden = true; });

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
async function renderSearch(q) {
  document.title = `${q} — Artwork Finder`;
  $('#searchInput').value = q;
  app.innerHTML = '<div class="spinner"></div>';
  try {
    const { results, provider } = await api('/api/search?q=' + encodeURIComponent(q));
    remember({ search: q });
    app.innerHTML = `
      ${keyNotice()}
      <div class="section-title"><h2>Results for “${esc(q)}”</h2><span class="muted">${results.length} found via ${esc(provider)}</span></div>
      ${results.length ? `<div class="results">${results.map(r => `
        <a class="result" href="#/title/${r.type}/${r.id}">
          <div class="poster">${r.poster ? `<img loading="lazy" src="${esc(r.poster)}" alt="">` : `<div class="ph">${esc(r.title)}</div>`}</div>
          <h3>${esc(r.title)}</h3>
          <div class="sub">${r.type === 'movie' ? 'Movie' : 'TV'}${r.year ? ' · ' + r.year : ''}</div>
        </a>`).join('')}</div>` : '<div class="empty">Nothing found. Try another spelling or the original title.</div>'}`;
  } catch (e) {
    app.innerHTML = `<div class="empty">Search failed: ${esc(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Title page
// ---------------------------------------------------------------------------
const state = { title: null, images: [], filtered: [], kind: 'poster', textless: false, lang: 'all', source: 'all', minWidth: 0, sort: savedSort(), otherLangs: savedOtherLangs(), group: savedFlag('group', true), minSize: '0', expanded: new Set(), selected: new Map(), tab: 'art', providers: {}, googleQuery: '' };

// Language filter: a specific language from the dropdown, or by default English plus art with
// no language (usually textless). "Other languages" adds the rest.
function langOk(i) {
  if (state.lang !== 'all') return i.lang === state.lang;
  return state.otherLangs || !i.lang || i.lang === 'en';
}

function savedFlag(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : v === '1'; } catch { return fallback; } }
function saveFlag(key, on) { try { localStorage.setItem(key, on ? '1' : '0'); } catch {} }

function savedOtherLangs() { try { return localStorage.getItem('otherLangs') === '1'; } catch { return false; } }

function savedSort() {
  try { return ['official', 'votes', 'size'].find(s => s === localStorage.getItem('sort')) || 'official'; } catch { return 'official'; }
}

async function renderTitle(type, id) {
  app.innerHTML = '<div class="spinner"></div>';
  try {
    const region = (navigator.language.split('-')[1] || 'US');
    const t = await api(`/api/title?type=${type}&id=${id}&region=${region}`);
    Object.assign(state, { title: t, images: t.images, textless: false, lang: 'all', source: 'all', minSize: '0', tab: 'art', providers: {}, expanded: new Set(), selected: new Map() });
    state.kind = 'all';
    state.googleQuery = `${t.title} ${t.year || ''} poster`.replace(/\s+/g, ' ');
    document.title = `${t.title} — Artwork Finder`;
    $('#searchInput').value = t.title;
    remember({ title: { type, id, title: t.title, year: t.year, poster: t.poster } });
    drawTitle();
    loadProviders(t);
  } catch (e) {
    app.innerHTML = `${keyNotice()}<div class="empty">Couldn’t load this title: ${esc(e.message)}</div>`;
  }
}

function drawTitle() {
  const t = state.title;
  const metaRow = (label, list) => list.length ? `<div class="meta-row"><span class="label">${label}</span>${list.map(x => `<span class="tag">${esc(x)}</span>`).join('')}</div>` : '';

  app.innerHTML = `
    <section class="title-hero">
      ${t.backdrop ? `<div class="bg" style="background-image:url('${esc(t.backdrop)}')"></div>` : ''}
      <div class="inner">
        ${t.poster ? `<img class="cover" src="${esc(t.poster)}" alt="">` : ''}
        <div>
          <h1>${esc(t.title)} <span class="year">${esc(t.year)}</span></h1>
          ${t.tagline ? `<div class="tagline">${esc(t.tagline)}</div>` : ''}
          <p class="overview">${esc(t.overview)}</p>
          ${metaRow('Network', t.networks)}
          ${metaRow('Streaming on', t.providers.slice(0, 10))}
          ${metaRow('Studios', t.companies.slice(0, 8))}
        </div>
      </div>
    </section>
    ${(t.warnings || []).map(w => `<div class="notice">${esc(w)}</div>`).join('')}
    ${!keyStatus.hasFanart ? keyNotice() : ''}
    <div class="provider-bar" id="providerBar"></div>
    <div class="tabs">
      <button class="tab ${state.tab === 'art' ? 'active' : ''}" data-tab="art">Artwork <span class="muted" id="artCount">${state.images.length}</span></button>
      <button class="tab ${state.tab === 'sources' ? 'active' : ''}" data-tab="sources">Search elsewhere</button>
    </div>
    <div id="tabBody"></div>`;

  app.querySelectorAll('.tab').forEach(b => b.onclick = () => { state.tab = b.dataset.tab; drawTitle(); });
  drawProviderBar();
  if (state.tab === 'art') drawArtwork(); else drawTitleSources();
}

// ---------------------------------------------------------------------------
// Streaming services & review sites — each loads on its own so slow ones don't block
// ---------------------------------------------------------------------------
function providerParams(t) {
  const wr = Object.entries(t.watchRegions || {}).map(([s, r]) => `${s}:${[].concat(r).join('|')}`).join(',');
  return `type=${t.type === 'movie' ? 'movie' : 'tv'}&title=${encodeURIComponent(t.title)}&year=${t.year || ''}&imdb=${t.imdbId || ''}&tmdb=${t.id || ''}&tvdb=${t.tvdbId || ''}&wr=${wr}&orig=${encodeURIComponent(t.originalTitle || '')}`;
}

function loadProviders(t) {
  for (const p of keyStatus.providers || []) {
    if (p.onDemand || !p.enabled) continue;
    state.providers[p.id] = { name: p.name, status: 'loading' };
    api(`/api/provider?name=${p.id}&${providerParams(t)}`)
      .then(r => {
        if (state.title !== t) return;
        state.providers[p.id] = { name: p.name, status: r.images.length ? 'ok' : 'none', count: r.images.length, link: r.link, note: r.note };
        if (r.images.length) addImages(r.images);
        else drawProviderBar();
      })
      .catch(e => {
        if (state.title !== t) return;
        state.providers[p.id] = { name: p.name, status: 'error', note: e.message };
        drawProviderBar();
      });
  }
  drawProviderBar();
}

function drawProviderBar() {
  const bar = $('#providerBar');
  if (!bar) return;
  const base = {};
  // Sources that came with the title itself (TMDB, fanart.tv, TVmaze); the rest have their own status.
  const loaded = new Set(Object.values(state.providers).map(p => p.name));
  for (const i of state.images) if (!loaded.has(i.source)) base[i.source] = (base[i.source] || 0) + 1;
  const pill = (name, status, count, link, note) => {
    const label = status === 'loading' ? '<span class="dot-spin"></span>' : status === 'ok' ? count : '–';
    const tag = link ? 'a' : 'span';
    return `<${tag} class="pill ${status}" ${link ? `href="${esc(link)}" target="_blank" rel="noopener noreferrer"` : ''} title="${esc(note || (link ? 'Open on ' + name : ''))}">${esc(name)} <b>${label}</b></${tag}>`;
  };
  bar.innerHTML = Object.entries(base).map(([n, c]) => pill(n, 'ok', c)).join('') +
    Object.values(state.providers).map(p => pill(p.name, p.status, p.count, p.link, p.note)).join('');
  const count = $('#artCount');
  if (count) count.textContent = state.images.length;
}

async function searchGoogle(query) {
  const t = state.title;
  state.googleQuery = query;
  state.providers.google = { name: 'Google', status: 'loading' };
  drawProviderBar();
  try {
    const r = await api(`/api/provider?name=google&${providerParams(t)}&q=${encodeURIComponent(query)}`);
    state.providers.google = { name: 'Google', status: r.images.length ? 'ok' : 'none', count: r.images.length, note: r.note };
    state.kind = 'web';
    addImages(r.images, null, true);
  } catch (e) {
    state.providers.google = { name: 'Google', status: 'error', note: e.message };
    drawProviderBar();
    alert(e.message);
  }
}

function drawArtwork() {
  if (pendingRedraw === 'artwork') pendingRedraw = null;
  const body = $('#tabBody');
  // Rebuilding briefly empties the section; keeping its height stops the browser from pulling
  // the page up while that happens.
  const keepY = scrollY;
  body.style.minHeight = body.offsetHeight + 'px';
  const t = state.title;
  // Type buttons count images from the selected source, and source buttons count images of the
  // selected type, so the numbers always match what clicking will show.
  const counts = {}, sourceCounts = { all: 0 };
  const ofKind = i => state.kind === 'all' ? i.kind !== 'web' : i.kind === state.kind;
  // How many images the default language filter is hiding, for the checkbox label.
  const hiddenLangs = state.images.filter(i => ofKind(i) && (state.source === 'all' || i.source === state.source) && i.lang && i.lang !== 'en').length;
  for (const i of state.images) {
    if (!langOk(i)) continue;
    if (state.source === 'all' || i.source === state.source) {
      counts[i.kind] = (counts[i.kind] || 0) + 1;
      if (i.kind !== 'web') counts.all = (counts.all || 0) + 1;
    }
    if (ofKind(i)) {
      sourceCounts[i.source] = (sourceCounts[i.source] || 0) + 1;
      sourceCounts.all++;
    }
  }
  const kinds = Object.keys(KIND_LABELS).filter(k => counts[k] || k === state.kind);
  const sources = ['all', ...sourceOrder().filter(s => sourceCounts[s] || s === state.source)];
  const langs = [...new Set(state.images.filter(ofKind).map(i => i.lang).filter(Boolean))].sort();

  body.innerHTML = `
    <div class="toolbar chip-row">
      <span class="chips-label">Type</span>
      <div class="chips">${kinds.map(k => `<button class="chip ${k === state.kind ? 'active' : ''}" data-kind="${k}">${KIND_LABELS[k]}<span class="n">${counts[k] || 0}</span></button>`).join('')}</div>
    </div>
    <div class="toolbar chip-row">
      <span class="chips-label">Source</span>
      <div class="chips">${sources.map(s => `<button class="chip ${s === state.source ? 'active' : ''}" data-source="${esc(s)}">${s === 'all' ? 'All' : esc(s)}<span class="n">${sourceCounts[s] || 0}</span></button>`).join('')}</div>
    </div>
    <div class="toolbar">
      <label ${TEXTLESS_KINDS.has(state.kind) || state.kind === 'all' ? '' : 'hidden'}><input type="checkbox" id="fTextless" ${state.textless ? 'checked' : ''}> Textless only</label>
      <label ${state.lang === 'all' && (hiddenLangs || state.otherLangs) ? '' : 'hidden'}><input type="checkbox" id="fOtherLangs" ${state.otherLangs ? 'checked' : ''}> Other languages <span class="muted">(${hiddenLangs})</span></label>
      <label>Language <select id="fLang">
        <option value="all">${state.otherLangs ? 'All' : 'English & no language'}</option>
        ${langs.map(l => `<option value="${l}" ${state.lang === l ? 'selected' : ''}>${esc(langName(l))}</option>`).join('')}
      </select></label>
      <label>Size <select id="fSize">
        <option value="0">Any</option>
        <optgroup label="Longest side">${[1000, 2000, 3000, 4000].map(w => `<option value="${w}" ${state.minSize == w ? 'selected' : ''}>${w}px or more</option>`).join('')}</optgroup>
        <optgroup label="For your ${posterSize().join('×')} poster"><option value="good" ${state.minSize === 'good' ? 'selected' : ''}>Good or Great</option><option value="great" ${state.minSize === 'great' ? 'selected' : ''}>Great only</option></optgroup>
      </select></label>
      <label title="Show the same artwork from different sources as one card"><input type="checkbox" id="fGroup" ${state.group ? 'checked' : ''}> Group duplicates</label>
      <label>Sort <select id="fSort">
        <option value="official" ${state.sort === 'official' ? 'selected' : ''}>Streaming services first</option>
        <option value="votes" ${state.sort === 'votes' ? 'selected' : ''}>Most liked</option>
        <option value="size" ${state.sort === 'size' ? 'selected' : ''}>Largest first</option>
      </select></label>
    </div>
    ${sourceEnabled('google') ? `<form class="google-bar" id="googleForm">
      <span class="label">Google Images</span>
      <input id="googleQuery" value="${esc(state.googleQuery)}" aria-label="Google Images query">
      <button class="btn primary">Search</button>
      ${['poster', 'textless poster', 'key art', 'character poster', 'wallpaper 4k'].map(x => `<button type="button" class="chip" data-gq="${x}">${x}</button>`).join('')}
      ${keyStatus.hasSerp ? '' : '<span class="muted">Needs a free <a href="#" onclick="openSettings();return false">SerpAPI key</a> — or <a target="_blank" rel="noopener noreferrer" id="googleOut">open in Google</a></span>'}
    </form>` : ''}
    ${t.seasons?.length && keyStatus.hasTmdb && sourceEnabled('tmdb') ? `<div class="extra-loaders">Load season posters:
      ${t.seasons.map(s => `<button class="btn" data-season="${s.number}">${esc(s.name)}</button>`).join('')}</div>` : ''}
    ${t.collection && sourceEnabled('tmdb') ? `<div class="extra-loaders">Part of <strong>${esc(t.collection.name)}</strong> — <button class="btn" id="loadCollection">Load collection artwork</button></div>` : ''}
    <div class="gallery-head"><span id="progress" class="muted"></span>
      <button class="btn" id="selectAll">Select all in view</button></div>
    <div id="gallery"></div>`;

  const gForm = $('#googleForm') || document.createElement('form');
  const googleUrl = q => 'https://www.google.com/search?tbm=isch&tbs=isz:l&q=' + encodeURIComponent(q);
  const out = $('#googleOut');
  if (out) out.href = googleUrl(state.googleQuery);
  gForm.onsubmit = e => {
    e.preventDefault();
    const q = $('#googleQuery').value.trim();
    if (!q) return;
    if (keyStatus.hasSerp) searchGoogle(q); else window.open(googleUrl(q), '_blank', 'noopener');
  };
  gForm.querySelectorAll('[data-gq]').forEach(b => b.onclick = () => {
    $('#googleQuery').value = `${t.title} ${t.year || ''} ${b.dataset.gq}`.replace(/\s+/g, ' ');
    gForm.requestSubmit();
  });
  body.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => { state.kind = b.dataset.kind; state.lang = 'all'; drawArtwork(); });
  $('#fTextless').onchange = e => { state.textless = e.target.checked; drawGallery(); };
  $('#fLang').onchange = e => { state.lang = e.target.value; drawArtwork(); };
  $('#fOtherLangs').onchange = e => {
    state.otherLangs = e.target.checked;
    try { localStorage.setItem('otherLangs', state.otherLangs ? '1' : '0'); } catch {}
    drawArtwork();
  };
  body.querySelectorAll('[data-source]').forEach(b => b.onclick = () => { state.source = b.dataset.source; drawArtwork(); });
  $('#fSize').onchange = e => { state.minSize = e.target.value; drawGallery(); };
  $('#fGroup').onchange = e => { state.group = e.target.checked; saveFlag('group', state.group); drawGallery(); };
  $('#fSort').onchange = e => {
    state.sort = e.target.value;
    try { localStorage.setItem('sort', state.sort); } catch {}
    drawGallery();
  };

  body.querySelectorAll('[data-season]').forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent += ' …';
    const { images } = await api(`/api/season?id=${t.id}&season=${b.dataset.season}`);
    addImages(images, 'season');
  });
  const col = $('#loadCollection');
  if (col) col.onclick = async () => {
    col.disabled = true; col.textContent = 'Loading…';
    const { images } = await api(`/api/collection?id=${t.collection.id}`);
    addImages(images, null, true);
  };
  drawGallery();
  body.style.minHeight = '';
  if (scrollY !== keepY) scrollTo(0, keepY);
}

// now: the user asked for these (season posters, collection, Google), so show them right away.
function addImages(images, focusKind, now = !!focusKind) {
  const key = i => i.kind + i.url;
  const seen = new Set(state.images.map(key));
  state.images.push(...images.filter(i => !seen.has(key(i))));
  if (focusKind) state.kind = focusKind;
  drawProviderBar();
  if (now) { if (state.tab === 'art') drawArtwork(); } else requestRedraw('artwork');
}

// ---------------------------------------------------------------------------
// Background updates (new sources, sizes, duplicate groups) never move the gallery while you're
// scrolled into it or looking at an image: they wait behind an "Updates ready" button, and are
// applied when you click it, scroll back to the top, or change a filter.
// ---------------------------------------------------------------------------
let pendingRedraw = null; // 'artwork' (toolbar + gallery) or 'gallery'

let lastScrollAt = 0;

function viewingGallery() {
  if (!lb.hidden) return true;
  if (Date.now() - lastScrollAt < 1200) return true; // still scrolling: don't move things now
  const g = $('#gallery');
  return !!g && g.getBoundingClientRect().top < $('.topbar').offsetHeight - 20;
}

function requestRedraw(kind) {
  if (state.tab !== 'art' || !$('#tabBody')) return;
  pendingRedraw = pendingRedraw === 'artwork' || kind === 'artwork' ? 'artwork' : 'gallery';
  if (viewingGallery()) { showUpdatesButton(); return; }
  applyPendingRedraw();
}

function applyPendingRedraw() {
  const kind = pendingRedraw;
  pendingRedraw = null;
  showUpdatesButton();
  if (kind === 'artwork') drawArtwork(); else if (kind) drawGallery();
}

function showUpdatesButton() {
  let b = $('#updatesReady');
  if (!pendingRedraw || state.tab !== 'art') { b?.remove(); return; }
  if (b) return;
  b = document.createElement('button');
  b.id = 'updatesReady';
  b.className = 'updates-ready';
  b.textContent = 'Updates ready · Show';
  b.title = 'New images, sizes or grouped duplicates came in while you were scrolling';
  b.onclick = applyPendingRedraw;
  document.body.appendChild(b);
}

// Held updates are applied once scrolling has stopped for a moment, if you're above the gallery.
let scrollIdle = null;
window.addEventListener('scroll', () => {
  lastScrollAt = Date.now();
  clearTimeout(scrollIdle);
  scrollIdle = setTimeout(() => { if (pendingRedraw && !viewingGallery()) applyPendingRedraw(); }, 1300);
}, { passive: true });

// ---------------------------------------------------------------------------
// Quality for your poster size
// ---------------------------------------------------------------------------
const posterSize = () => keyStatus.posterSize || [1000, 1500];
const LOGO_KINDS = new Set(['logo', 'clearart', 'character']);

// How many times your poster the image covers. Backdrops and stills count the largest crop in your
// poster's shape that fits in them; logos and cut-outs need to span about 80% of the width.
function quality(i) {
  if (!i.width) return null;
  const [W, H] = posterSize();
  const factor = LOGO_KINDS.has(i.kind) ? i.width / (0.8 * W) : Math.min(i.width, i.height * W / H) / W;
  const x = `${factor.toFixed(1)}×`;
  if (LOGO_KINDS.has(i.kind)) {
    const level = factor < 1 ? 'low' : factor < 1.5 ? 'good' : 'great';
    const note = factor < 1 ? `too narrow to span your ${W}px poster, needs upscaling` : `${x} wide enough for your ${W}px poster`;
    return { level, label: level[0].toUpperCase() + level.slice(1), factor, note };
  }
  if (factor < 1) return { level: 'low', label: 'Low', factor, note: `${Math.round(factor * 100)}% of your ${W}×${H}, needs upscaling` };
  if (factor < 1.5) return { level: 'good', label: 'Good', factor, note: `${x} your ${W}×${H}` };
  return { level: 'great', label: 'Great', factor, note: `${x} your ${W}×${H}, room to crop` };
}
function sizeOk(i) {
  if (state.minSize === '0') return true;
  if (state.minSize === 'good') return ['good', 'great'].includes(quality(i)?.level);
  if (state.minSize === 'great') return quality(i)?.level === 'great';
  return Math.max(i.width || 0, i.height || 0) >= +state.minSize;
}
const sizeText = (i, w = i.width, h = i.height) => {
  const q = quality({ ...i, width: w, height: h });
  return `${w}×${h} · ${q.label} (${q.note})`;
};

// Fills in real sizes for images whose source doesn't report them (read from the file header).
const sizeRequested = new Set();
async function measure(list) {
  const todo = list.filter(i => !i.width && !sizeRequested.has(i.url));
  todo.forEach(i => sizeRequested.add(i.url));
  if (!todo.length) return;
  // ThePosterDB only allows a few requests a minute, so it runs in small batches of its own
  // instead of holding up the other sources.
  const slow = todo.filter(i => i.source === 'ThePosterDB'), fast = todo.filter(i => i.source !== 'ThePosterDB');
  let done = 0;
  const run = async (list, size) => {
    for (let n = 0; n < list.length; n += size) {
      const batch = list.slice(n, n + size);
      const sizes = await api('/api/sizes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls: batch.map(i => i.url) }) }).catch(() => ({}));
      for (const i of batch) if (sizes[i.url]) { [i.width, i.height] = sizes[i.url]; i.measured = true; }
      refreshCards();
      if (state.sort === 'size' || state.minSize !== '0') redrawSoon();
      done += batch.length;
      progress('sizes', done < todo.length ? `Measuring sizes ${done}/${todo.length}…` : '');
    }
  };
  progress('sizes', `Measuring sizes 0/${todo.length}…`);
  await Promise.all([run(fast, 50), run(slow, 6)]);
  progress('sizes', '');
}

// ---------------------------------------------------------------------------
// Duplicate grouping: a 64-bit "difference hash" of each thumbnail. Images that look the same
// (resized, recompressed, from another source) get nearly identical hashes.
// ---------------------------------------------------------------------------
const hashes = new Map();
const hashRequested = new Set();
const HASH_THRESHOLD = 6; // max differing bits (of 64) to count as the same artwork

// Smallest useful thumbnail, loaded through our server so the canvas may read its pixels.
function hashSrc(i) {
  if (CACHED_THUMBS.has(i.source)) return show(i, i.thumb);
  const u = i.source === 'TMDB' ? i.thumb.replace(/\/t\/p\/\w+\//, '/t/p/w185/') : i.thumb;
  return `/api/download?inline=1&url=${encodeURIComponent(u)}`;
}

// A cached thumbnail can fail while the site is briefly blocking us; try again a few times.
function retryThumb(img) {
  const n = +(img.dataset.retries || 0);
  if (n >= 3) return;
  img.dataset.retries = n + 1;
  setTimeout(() => { img.src = img.src.replace(/&r=\d+$/, '') + '&r=' + (n + 1); }, 4000 * (n + 1));
}

function computeHash(i) {
  const key = 'h:' + i.thumb;
  try { const v = localStorage.getItem(key); if (v) return Promise.resolve(v); } catch {}
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = 9; c.height = 8;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, 9, 8);
      const px = ctx.getImageData(0, 0, 9, 8).data;
      const gray = n => px[n * 4] * 0.299 + px[n * 4 + 1] * 0.587 + px[n * 4 + 2] * 0.114;
      let bits = '';
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += gray(y * 9 + x) > gray(y * 9 + x + 1) ? '1' : '0';
      const hex = BigInt('0b' + bits).toString(16).padStart(16, '0');
      const value = `${hex}|${(img.naturalWidth / img.naturalHeight).toFixed(3)}`;
      try { localStorage.setItem(key, value); } catch {}
      resolve(value);
    };
    img.onerror = () => resolve(null);
    img.src = hashSrc(i);
  });
}

async function hashAll(list) {
  const todo = list.filter(i => !hashes.has(i.thumb) && !hashRequested.has(i.thumb));
  todo.forEach(i => hashRequested.add(i.thumb));
  let done = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (todo.length) {
      const i = todo.shift();
      const h = await computeHash(i);
      if (h) hashes.set(i.thumb, h);
      if (++done % 25 === 0) progress('hash', `Comparing images ${done}/${done + todo.length}…`);
    }
  }));
  progress('hash', '');
  if (done) redrawSoon();
}

function sameArt(a, b) {
  const [ha, ra] = a.split('|'), [hb, rb] = b.split('|');
  if (Math.abs(ra / rb - 1) > 0.08) return false;
  let x = BigInt('0x' + ha) ^ BigInt('0x' + hb), bits = 0;
  while (x) { bits += Number(x & 1n); x >>= 1n; }
  return bits <= HASH_THRESHOLD;
}

// Groups look-alikes. Each group is shown as its largest version, where the first member sat.
function groupList(list) {
  const groups = [];
  for (const i of list) {
    const h = hashes.get(i.thumb);
    const g = h && groups.find(g => g.hash && sameArt(g.hash, h));
    if (g) g.items.push(i); else groups.push({ hash: h, items: [i] });
  }
  const area = i => (i.width || 0) * (i.height || 0);
  return groups.map(g => {
    const best = g.items.reduce((a, b) => (area(b) > area(a) ? b : a));
    return { id: best.url, best, others: g.items.filter(i => i !== best) };
  });
}

// Progress text above the gallery, and debounced redraws as sizes and hashes come in.
const progressText = {};
function progress(key, text) {
  progressText[key] = text;
  const el = $('#progress');
  if (el) el.textContent = Object.values(progressText).filter(Boolean).join(' · ');
}
let redrawTimer = null;
function redrawSoon() {
  clearTimeout(redrawTimer);
  redrawTimer = setTimeout(() => requestRedraw('gallery'), 700);
}

// Fills newly measured sizes into the cards on screen without re-laying out the gallery.
function refreshCards() {
  const g = $('#gallery');
  if (!g || !state.shown) return;
  for (const el of g.querySelectorAll('.card[data-key]')) {
    const box = el.querySelector('.img');
    const s = state.shown[+box.dataset.n];
    if (!s || s.i.url !== el.dataset.key || !s.i.width) continue;
    const i = s.i, q = quality(i);
    const badge = box.querySelector('.badge.quality');
    const html = `<span class="badge quality ${q.level}" title="${esc(q.note)}">${q.label}</span>`;
    if (badge) badge.outerHTML = html; else box.insertAdjacentHTML('beforeend', html);
    el.querySelector('.dims').textContent = `${i.width}×${i.height}${i.votes ? ` · ♥ ${i.votes}` : ''}`;
    const dl = el.querySelector('a[title="Download original"]');
    if (dl) dl.href = downloadUrl(i);
  }
}

function drawGallery() {
  const g = $('#gallery');
  const t = state.title;
  // Everything except the size filter, which needs sizes we may still be measuring.
  const base = state.images.filter(i =>
    (state.kind === 'all' ? i.kind !== 'web' : i.kind === state.kind) &&
    (!state.textless || !TEXTLESS_KINDS.has(i.kind) || i.textless) &&
    langOk(i) &&
    (state.source === 'all' || i.source === state.source));
  measure(base);
  if (state.group) hashAll(base);

  let list = base.filter(sizeOk);
  const area = i => (i.width || 0) * (i.height || 0);
  // Sizes measured after loading only count for "Largest first", so they don't reshuffle the other sorts.
  const reported = i => i.measured ? 0 : area(i);
  const byVotes = (a, b) => (b.votes || 0) - (a.votes || 0) || reported(b) - reported(a);
  const bySort = state.sort === 'size' ? (a, b) => area(b) - area(a)
    : state.sort === 'votes' ? byVotes
    : (a, b) => OFFICIAL.has(b.source) - OFFICIAL.has(a.source) || byVotes(a, b);
  // Thumbnails from rate-limited sites load slowly, so they always come last.
  list.sort((a, b) => CACHED_THUMBS.has(a.source) - CACHED_THUMBS.has(b.source) || bySort(a, b));

  const groups = state.group ? groupList(list) : list.map(i => ({ id: i.url, best: i, others: [] }));
  // What's on screen, in order: each group's best version, plus its other versions when expanded.
  const shown = [];
  for (const gr of groups) {
    shown.push({ i: gr.best, group: gr });
    if (state.expanded.has(gr.id)) for (const o of gr.others) shown.push({ i: o, member: true });
  }
  state.filtered = shown.map(s => s.i);
  state.groups = groups;
  state.shown = shown;
  if (pendingRedraw === 'gallery') pendingRedraw = null;
  showUpdatesButton();

  const btn = $('#selectAll');
  if (btn) {
    btn.textContent = `Select all in view (${groups.length})`;
    btn.onclick = () => { for (const gr of groups) state.selected.set(gr.best.url, gr.best); drawGallery(); };
  }
  drawSelectionBar();

  g.className = 'gallery' + (WIDE_KINDS.has(state.kind) || state.kind === 'still' ? ' wide' : '');
  if (!shown.length) {
    g.className = '';
    const waiting = state.minSize !== '0' && base.some(i => !i.width);
    g.innerHTML = `<div class="empty">${waiting ? 'Measuring image sizes…' : 'No artwork matches these filters.'}<br>Try <a href="#" onclick="state.tab='sources';drawTitle();return false">Search elsewhere</a> for more places to look.</div>`;
    return;
  }
  // Keep the first card on screen in the same spot, since a refresh can add, remove or merge cards above it.
  const top = $('.topbar').offsetHeight;
  const anchor = [...g.querySelectorAll('.card')].find(c => c.getBoundingClientRect().bottom > top);
  const anchorKey = anchor?.dataset.key, anchorY = anchor?.getBoundingClientRect().top;
  const y = scrollY;
  g.style.minHeight = g.offsetHeight + 'px';
  // The slow-loading sources start on a row of their own, under a heading.
  const firstSlow = shown.findIndex(s => CACHED_THUMBS.has(s.i.source));
  g.innerHTML = shown.map(({ i, group, member }, n) =>
    (n === firstSlow && n > 0 ? `<div class="gallery-divider">${esc(i.source)} <span class="muted">· loads a little slower</span></div>` : '') +
    card(i, n, group, member)).join('');
  g.style.minHeight = '';
  const again = anchorKey && [...g.querySelectorAll('.card')].find(c => c.dataset.key === anchorKey);
  if (again) scrollBy(0, again.getBoundingClientRect().top - anchorY); else scrollTo(0, y);
  bindCards(g);
}

function bindCards(g) {
  g.querySelectorAll('.img').forEach(el => el.onclick = e => {
    if (e.target.closest('.pick, .versions')) return;
    openLightbox(+el.dataset.n);
  });
  g.querySelectorAll('[data-pick]').forEach(cb => cb.onchange = () => {
    const i = state.filtered.find(x => x.url === cb.dataset.pick);
    if (!i) return;
    if (cb.checked) state.selected.set(i.url, i); else state.selected.delete(i.url);
    cb.closest('.card').classList.toggle('picked', cb.checked);
    drawSelectionBar();
  });
  g.querySelectorAll('[data-versions]').forEach(b => b.onclick = () => {
    const id = b.dataset.versions;
    if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
    drawGallery();
  });
}

// Sticky bar with the selection count and the ZIP download.
function drawSelectionBar() {
  let bar = $('#selectionBar');
  const n = state.selected.size;
  if (!n) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'selectionBar';
    bar.className = 'selection-bar';
    document.body.appendChild(bar);
  }
  bar.innerHTML = `<strong>${n} selected</strong>
    <button class="btn" id="clearSel">Clear</button>
    <button class="btn primary" id="zipSel">Download ZIP</button>`;
  $('#clearSel').onclick = () => { state.selected.clear(); drawGallery(); };
  $('#zipSel').onclick = downloadZip;
}

function downloadZip() {
  const t = state.title;
  const files = [...state.selected.values()].map(i => ({ url: i.url, name: fileName(i) }));
  // A real form post, so the browser streams the ZIP to disk instead of holding it in memory.
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/api/zip';
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'payload';
  input.value = JSON.stringify({ name: `${t.title}${t.year ? ` (${t.year})` : ''} artwork`, files });
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
  form.remove();
}

// Order sources are listed in: the ones that come with the title, then each service as in the status bar.
function sourceOrder() {
  const base = [...new Set(state.images.map(i => i.source))].filter(s => !Object.values(state.providers).some(p => p.name === s));
  return [...base, ...(keyStatus.providers || []).map(p => p.name)];
}

// Image box shape per type; the whole image is fitted inside, so loading never resizes a card.
const KIND_ASPECT = { poster: '2 / 3', season: '2 / 3', character: '1 / 1', disc: '1 / 1', other: '1 / 1', web: '1 / 1', banner: '1000 / 185' };

function card(i, n, group, member) {
  const q = quality(i);
  const picked = state.selected.has(i.url);
  const others = group?.others || [];
  return `
    <figure class="card ${member ? 'member' : ''} ${picked ? 'picked' : ''}" style="margin:0" data-key="${esc(i.url)}">
      <div class="img" data-n="${n}" style="--ar: ${KIND_ASPECT[i.kind] || '16 / 9'}">
        <label class="pick" title="Select for ZIP download"><input type="checkbox" data-pick="${esc(i.url)}" ${picked ? 'checked' : ''}></label>
        ${q ? `<span class="badge quality ${q.level}" title="${esc(q.note)}">${q.label}</span>` : ''}
        ${others.length ? `<button class="versions" data-versions="${esc(group.id)}" title="${esc(others.map(o => `${o.source}${o.width ? ` ${o.width}×${o.height}` : ''}`).join(', '))}">${state.expanded.has(group.id) ? 'Hide' : '+' + others.length} version${others.length > 1 ? 's' : ''}</button>` : ''}
        <img loading="lazy" src="${esc(show(i, i.thumb))}" alt="" onerror="${CACHED_THUMBS.has(i.source) ? 'retryThumb(this)' : `this.onerror=null;this.src='${esc(show(i, i.url))}'`}">
        <div class="badges">
          <span class="badge src-${esc(i.source.replace(/\W/g, ''))}">${esc(i.source)}</span>
          ${i.lang ? `<span class="badge">${esc(i.lang.toUpperCase())}</span>` : ''}
          ${i.textless && TEXTLESS_KINDS.has(i.kind) ? '<span class="badge textless">Textless</span>' : ''}
          ${i.region ? `<span class="badge" title="From the ${esc(i.source)} catalog in this country">${esc(i.region === 'GB' ? 'UK' : i.region)}</span>` : ''}
          ${FAN_ART.has(i.source) ? '<span class="badge fan" title="Made by an independent artist, not official artwork">Fan art</span>' : ''}
          ${i.season ? `<span class="badge">S${esc(i.season)}</span>` : ''}
          ${i.collection ? '<span class="badge">Collection</span>' : ''}
        </div>
      </div>
      <figcaption class="info">
        <span class="dims" title="${esc(i.sub || '')}">${i.width ? `${i.width}×${i.height}` : esc(i.sub || '…')}${i.votes ? ` · ♥ ${i.votes}` : ''}</span>
        ${i.page ? `<a class="btn" href="${esc(i.page)}" target="_blank" rel="noopener noreferrer" title="${esc(i.title || 'Page the image is on')}">Page</a>` : ''}
        <a class="btn" href="${esc(i.url)}" target="_blank" rel="noopener noreferrer" title="Open full size">Open</a>
        <a class="btn" href="${downloadUrl(i)}" title="Download original">↓</a>
      </figcaption>
    </figure>`;
}

// Images from sites that block hotlinking are shown through our own server, and thumbnails from
// rate-limited sites through its disk cache (fetched once, at a pace the site accepts).
const CACHED_THUMBS = new Set(['ThePosterDB']);
const show = (i, u) => CACHED_THUMBS.has(i.source) && u === i.thumb ? `/api/thumb?url=${encodeURIComponent(u)}`
  : i.proxy ? `/api/download?inline=1&url=${encodeURIComponent(u)}` : u;

function fileName(i) {
  const t = state.title;
  const u = new URL(i.url);
  const ext = u.searchParams.get('format') || (u.pathname.match(/\.(jpe?g|png|webp)$/i) || [, i.kind === 'logo' ? 'png' : 'jpg'])[1];
  return `${t.title}${t.year ? ` (${t.year})` : ''} - ${i.kind} - ${i.source}${i.season ? ' S' + i.season : ''}${i.lang ? ' ' + i.lang : i.textless ? ' textless' : ''}${i.width ? ` ${i.width}x${i.height}` : ''}.${ext}`;
}

function downloadUrl(i) {
  return `/api/download?url=${encodeURIComponent(i.url)}&name=${encodeURIComponent(fileName(i))}`;
}

// ---------------------------------------------------------------------------
// Sources (per title + full directory)
// ---------------------------------------------------------------------------
function fillTemplate(tpl, t) {
  const kind = t.type === 'movie' ? 'movie' : 'tv';
  const vals = {
    q: t.title, qy: t.title + (t.year ? ' ' + t.year : ''), tmdb: t.id, imdb: t.imdbId, tvdb: t.tvdbId, kind,
    mediux: kind === 'movie' ? 'movies' : 'shows',
    fanartkind: kind === 'movie' ? 'movie' : 'series',
    fanartid: kind === 'movie' ? t.id : t.tvdbId,
  };
  let missing = false;
  const out = tpl.replace(/\{(\w+)\}/g, (_, k) => {
    if (vals[k] == null || vals[k] === '') missing = true;
    return encodeURIComponent(vals[k] ?? '').replace(/%20/g, '+');
  });
  return missing ? null : out;
}

function sourceLinks(s, t) {
  if (!t) return s.url ? `<a class="btn" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">Visit</a>` : '';
  const links = [];
  const direct = s.search && fillTemplate(s.search, t);
  if (direct) links.push(`<a class="btn primary" href="${esc(direct)}" target="_blank" rel="noopener noreferrer">Search “${esc(t.title)}”</a>`);
  const host = s.site || (s.url && new URL(s.url).host);
  if (!direct && host && s.group === 'db') {
    const q = `site:${host} "${t.title}"`;
    links.push(`<a class="btn primary" href="https://www.google.com/search?q=${encodeURIComponent(q)}" target="_blank" rel="noopener noreferrer">Find “${esc(t.title)}” here</a>`);
  }
  if (s.url) links.push(`<a class="btn" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">Open site</a>`);
  return links.join('');
}

function sourceCard(s, t) {
  return `<div class="src">
    <div class="head">${esc(s.name)}</div>
    <p>${esc(s.note || '')}</p>
    <div class="links">${sourceLinks(s, t)}</div>
  </div>`;
}

function sourceGroups(t, groups = Object.keys(SOURCE_GROUPS)) {
  return groups.map(g => [g, SOURCE_GROUPS[g]]).map(([g, label]) => {
    const list = SOURCES.filter(s => s.group === g);
    return `<div class="src-group"><h3>${label}</h3><div class="src-grid">${list.map(s => sourceCard(s, t)).join('')}</div></div>`;
  }).join('');
}

function reverseSearchBox() {
  return `<div class="src-group"><h3>Find a larger version of an image</h3>
    <p class="muted" style="margin:0">Paste an image URL (right-click → Copy image address) and reverse-search it.</p>
    <form class="reverse" id="reverseForm">
      <input id="reverseUrl" type="url" placeholder="https://…/poster.jpg" required>
      ${REVERSE_SEARCH.map((r, n) => `<button class="btn" data-n="${n}">${r.name}</button>`).join('')}
    </form></div>`;
}

function bindReverseSearch() {
  const form = $('#reverseForm');
  if (!form) return;
  form.querySelectorAll('button').forEach(b => b.onclick = e => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    window.open(REVERSE_SEARCH[b.dataset.n].url.replace('{url}', encodeURIComponent($('#reverseUrl').value)), '_blank', 'noopener');
  });
}

function drawTitleSources() {
  const t = state.title;
  $('#tabBody').innerHTML = `${sourceGroups(t, ['search', 'db'])}${reverseSearchBox()}`;
  bindReverseSearch();
}

function renderSources() {
  document.title = 'Sources — Artwork Finder';
  app.innerHTML = `
    <div class="section-title"><h2>Where to find artwork</h2><span class="muted">${SOURCES.length} sources</span></div>
    <p class="muted" style="max-width:800px;margin-top:-6px">Search a title to get these links pre-filled. Press sites usually need a free media account — they hold the
      highest-resolution official key art, character posters and logos, often before they hit any database.</p>
    ${reverseSearchBox()}
    ${sourceGroups(null)}`;
  bindReverseSearch();
}

// ---------------------------------------------------------------------------
// Lightbox
// ---------------------------------------------------------------------------
let lbIndex = 0;

function openLightbox(n) {
  lbIndex = n;
  const i = state.filtered[n];
  if (!i) return;
  lb.hidden = false;
  lb.innerHTML = `
    <div class="stage"><img src="${esc(show(i, i.url))}" alt=""></div>
    <button class="nav-btn prev" aria-label="Previous">‹</button>
    <button class="nav-btn next" aria-label="Next">›</button>
    <button class="btn close" aria-label="Close">✕ Close</button>
    <div class="bar">
      <div class="meta"><strong>${esc(i.source)}</strong> · ${esc(KIND_LABELS[i.kind] || i.kind)}${i.sub ? ' (' + esc(i.sub) + ')' : ''} ·
        <span class="dims-live">${i.width ? esc(sizeText(i)) : 'measuring…'}</span> · ${i.lang ? esc(langName(i.lang)) : i.textless ? 'textless' : 'language unknown'} · ${n + 1} of ${state.filtered.length}</div>
      <span class="muted zoom-hint">Click image for 100%</span>
      <a class="btn" href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">Open original</a>
      <a class="btn primary" href="${downloadUrl(i)}">Download</a>
      ${REVERSE_SEARCH.map(r => `<a class="btn" href="${esc(r.url.replace('{url}', encodeURIComponent(i.url)))}" target="_blank" rel="noopener noreferrer" title="Find larger versions">${r.name}</a>`).join('')}
    </div>`;
  const full = $('.stage img', lb);
  // Show the real size of the file; some sites report a different size than they serve.
  full.onload = () => {
    $('.dims-live', lb).textContent = sizeText(i, full.naturalWidth, full.naturalHeight);
  };
  $('.prev', lb).onclick = () => openLightbox((lbIndex - 1 + state.filtered.length) % state.filtered.length);
  $('.next', lb).onclick = () => openLightbox((lbIndex + 1) % state.filtered.length);
  $('.close', lb).onclick = closeLightbox;
  $('.stage', lb).onclick = e => { if (e.target.tagName !== 'IMG') closeLightbox(); };
  bindZoom($('.stage', lb), full);
  document.body.classList.add('no-scroll');
}
function closeLightbox() {
  lb.hidden = true; lb.innerHTML = ''; document.body.classList.remove('no-scroll');
  if (pendingRedraw && !viewingGallery()) applyPendingRedraw();
}

// Click the image to toggle between fit-to-screen and 100%; at 100% scroll or drag to pan.
function bindZoom(stage, img) {
  let drag = null;
  img.addEventListener('pointerdown', e => {
    if (!stage.classList.contains('zoomed')) return;
    drag = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop, moved: false };
    img.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  img.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    stage.scrollLeft = drag.left - dx;
    stage.scrollTop = drag.top - dy;
  });
  img.addEventListener('pointerup', () => { setTimeout(() => { drag = null; }); });
  img.addEventListener('click', e => {
    if (drag?.moved) return;
    if (stage.classList.contains('zoomed')) { stage.classList.remove('zoomed'); return; }
    // Zoom in on the spot that was clicked.
    const r = img.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    stage.classList.add('zoomed');
    stage.scrollLeft = fx * img.offsetWidth - stage.clientWidth / 2;
    stage.scrollTop = fy * img.offsetHeight - stage.clientHeight / 2;
  });
}
document.addEventListener('keydown', e => {
  if (lb.hidden) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') $('.prev', lb).click();
  if (e.key === 'ArrowRight') $('.next', lb).click();
});

// ---------------------------------------------------------------------------
api('/api/config').then(s => { keyStatus = s; }).catch(() => {}).finally(route);
