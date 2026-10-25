// Artwork Finder — tiny zero-dependency server.
// Serves the frontend from ./public and proxies the artwork APIs (TMDB, fanart.tv, TVmaze)
// so API keys stay on your machine and the browser never hits CORS issues.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { PROVIDERS, runProvider } = require('./providers');
const { sizeCache, streamZip, thumbCache } = require('./images');

const PORT = process.env.PORT || 4321;
const PUBLIC = path.join(__dirname, 'public');
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(__dirname, 'config.json');

function loadConfig() {
  const cfg = { tmdbKey: process.env.TMDB_KEY || '', fanartKey: process.env.FANART_KEY || '', serpKey: process.env.SERPAPI_KEY || '', tvdbKey: process.env.TVDB_KEY || '', tvdbPin: process.env.TVDB_PIN || '' };
  try { Object.assign(cfg, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch {}
  return cfg;
}
let config = loadConfig();
const sizes = sizeCache(path.dirname(CONFIG_FILE));
const thumbs = thumbCache(path.dirname(CONFIG_FILE));

// --- History: recent searches and opened titles, kept in data/history.json ----------------
const HISTORY_FILE = path.join(path.dirname(CONFIG_FILE), 'history.json');
const HISTORY_MAX = 30;
let history = { searches: [], titles: [] };
try { history = { ...history, ...JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) }; } catch {}
function saveHistory() {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  return history;
}
// Newest first, without duplicates (searching or opening something again moves it to the top).
function remember(list, item, same) {
  return [item, ...list.filter(x => !same(x))].slice(0, HISTORY_MAX);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };


const cache = new Map();
async function getJSON(url, headers = {}) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < 30 * 60 * 1000) return hit.v;
  const res = await fetch(url, { headers: { Accept: 'application/json', ...headers } });
  if (res.status === 404) return null;
  if (!res.ok) throw Object.assign(new Error(`${new URL(url).host} responded ${res.status}`), { status: res.status });
  const v = await res.json();
  cache.set(url, { t: Date.now(), v });
  return v;
}

// --- TMDB -----------------------------------------------------------------
// Accepts either a v3 API key or a v4 "API Read Access Token".
function tmdb(p, params = {}) {
  const key = config.tmdbKey;
  if (!key) throw Object.assign(new Error('No TMDB key configured'), { status: 412 });
  const url = new URL('https://api.themoviedb.org/3' + p);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers = {};
  if (key.length > 40) headers.Authorization = 'Bearer ' + key;
  else url.searchParams.set('api_key', key);
  return getJSON(url.toString(), headers);
}

const TMDB_IMG = 'https://image.tmdb.org/t/p/';

function tmdbImages(list, kind) {
  return (list || []).map(i => ({
    source: 'TMDB', kind,
    url: TMDB_IMG + 'original' + i.file_path,
    thumb: TMDB_IMG + (kind === 'poster' ? 'w342' : 'w780') + i.file_path,
    width: i.width, height: i.height,
    lang: i.iso_639_1 || null,
    textless: !i.iso_639_1, // TMDB marks art without title text as "no language"
    votes: i.vote_count, score: i.vote_average,
  }));
}

async function tmdbTitle(type, id, region = 'US') {
  const append = type === 'movie'
    ? 'external_ids,images,watch/providers,release_dates'
    : 'external_ids,images,watch/providers';
  const d = await tmdb(`/${type}/${id}`, { append_to_response: append });
  if (!d) return null;
  const img = d.images || {};
  const images = [
    ...tmdbImages(img.posters, 'poster'),
    ...tmdbImages(img.backdrops, 'backdrop'),
    ...tmdbImages(img.logos, 'logo'),
  ];
  const providers = new Set();
  // Only the US (where most press sites live) and the viewer's own region, not every country.
  const regions = d['watch/providers']?.results || {};
  for (const c of [regions.US, regions[region]].filter(Boolean))
    for (const g of ['flatrate', 'free', 'ads'])
      for (const p of c[g] || [])
        // Skip resellers like "HBO Max Amazon Channel": they don't make the show.
        if (!/(amazon|apple tv|roku premium) channel/i.test(p.provider_name)) providers.add(p.provider_name);

  return {
    type, id: d.id,
    watchRegions: watchRegions(regions, region, [...(d.production_countries || []).map(c => c.iso_3166_1), ...(d.origin_country || [])]),
    title: d.title || d.name,
    originalTitle: d.original_title || d.original_name,
    year: (d.release_date || d.first_air_date || '').slice(0, 4),
    overview: d.overview,
    tagline: d.tagline,
    poster: d.poster_path ? TMDB_IMG + 'w500' + d.poster_path : null,
    backdrop: d.backdrop_path ? TMDB_IMG + 'w1280' + d.backdrop_path : null,
    imdbId: d.external_ids?.imdb_id || d.imdb_id || null,
    tvdbId: d.external_ids?.tvdb_id || null,
    companies: (d.production_companies || []).map(c => c.name),
    networks: (d.networks || []).map(n => n.name),
    providers: [...providers],
    seasons: (d.seasons || []).map(s => ({ number: s.season_number, name: s.name, poster: s.poster_path ? TMDB_IMG + 'w185' + s.poster_path : null })),
    collection: d.belongs_to_collection ? { id: d.belongs_to_collection.id, name: d.belongs_to_collection.name } : null,
    images,
  };
}

// For each service we read artwork from, countries where TMDB lists the title on it (rent and
// buy included: those pages have the same artwork). Prefers the US, the viewer's country, the UK,
// then the country the title is from.
const WATCH_SERVICES = { prime: /amazon|prime video/i, netflix: /^netflix/i, apple: /^apple tv/i, plex: /^plex/i };
// Prime Video artwork can differ per country, so it's collected from each of these (Dutch and
// English-language catalogs). A title on Prime only elsewhere gets one other country instead.
const PRIME_COUNTRIES = ['NL', 'US', 'GB', 'AU', 'NZ', 'CA'];

function watchRegions(regions, viewer, home = []) {
  const order = [...new Set(['US', viewer, 'GB', ...home, ...Object.keys(regions)])].filter(r => regions[r]);
  const out = {};
  for (const [service, re] of Object.entries(WATCH_SERVICES)) {
    const hits = order.filter(r => ['flatrate', 'free', 'ads', 'rent', 'buy'].some(g => (regions[r][g] || []).some(p => re.test(p.provider_name))));
    if (!hits.length) continue;
    const preferred = service === 'prime' ? PRIME_COUNTRIES.filter(r => hits.includes(r)) : [];
    out[service] = preferred.length ? preferred : hits.slice(0, 1);
  }
  return out;
}

// --- fanart.tv ------------------------------------------------------------
const FANART_KINDS = {
  movieposter: 'poster', moviebackground: 'backdrop', moviethumb: 'thumb', moviebanner: 'banner',
  hdmovielogo: 'logo', movielogo: 'logo', hdmovieclearart: 'clearart', movieart: 'clearart', moviedisc: 'disc',
  tvposter: 'poster', showbackground: 'backdrop', tvthumb: 'thumb', tvbanner: 'banner',
  hdtvlogo: 'logo', clearlogo: 'logo', hdclearart: 'clearart', clearart: 'clearart', characterart: 'character',
  seasonposter: 'season', seasonthumb: 'season', seasonbanner: 'season',
};

async function fanart(type, id) {
  if (!config.fanartKey || !id) return [];
  const d = await getJSON(`https://webservice.fanart.tv/v3/${type === 'movie' ? 'movies' : 'tv'}/${id}?api_key=${config.fanartKey}`);
  if (!d) return [];
  const out = [];
  for (const [field, kind] of Object.entries(FANART_KINDS)) {
    for (const i of d[field] || []) {
      out.push({
        source: 'fanart.tv', kind, sub: field,
        url: i.url,
        thumb: i.url.replace('/fanart/', '/preview/'),
        lang: i.lang && i.lang !== '00' ? i.lang : null,
        textless: i.lang === '00',
        votes: Number(i.likes) || 0,
        season: i.season && i.season !== 'all' ? i.season : undefined,
      });
    }
  }
  return out;
}

// --- TVmaze (free, no key) ------------------------------------------------
async function tvmazeLookup({ imdbId, tvdbId }) {
  let show = null;
  if (tvdbId) show = await getJSON(`https://api.tvmaze.com/lookup/shows?thetvdb=${tvdbId}`).catch(() => null);
  if (!show && imdbId) show = await getJSON(`https://api.tvmaze.com/lookup/shows?imdb=${imdbId}`).catch(() => null);
  return show;
}

async function tvmazeImages(showId) {
  const list = await getJSON(`https://api.tvmaze.com/shows/${showId}/images`);
  const kinds = { poster: 'poster', background: 'backdrop', banner: 'banner', typography: 'logo' };
  return (list || []).filter(i => i.resolutions?.original).map(i => ({
    source: 'TVmaze', kind: kinds[i.type] || i.type,
    url: i.resolutions.original.url,
    thumb: i.resolutions.original.url, // TVmaze only offers tiny 210px previews
    width: i.resolutions.original.width, height: i.resolutions.original.height,
    lang: null, textless: null, // TVmaze doesn't say whether art has text
    votes: i.main ? 1 : 0,
  }));
}

// --- API routes -----------------------------------------------------------
const routes = {
  async 'GET /api/config'() {
    return keyStatus();
  },

  async 'POST /api/config'(_q, body) {
    const next = { ...config };
    if (typeof body.tmdbKey === 'string') next.tmdbKey = body.tmdbKey.trim();
    if (typeof body.fanartKey === 'string') next.fanartKey = body.fanartKey.trim();
    if (typeof body.serpKey === 'string') next.serpKey = body.serpKey.trim();
    if (typeof body.tvdbKey === 'string') next.tvdbKey = body.tvdbKey.trim();
    if (typeof body.tvdbPin === 'string') next.tvdbPin = body.tvdbPin.trim();
    if (Array.isArray(body.disabledSources)) next.disabledSources = body.disabledSources.filter(s => typeof s === 'string');
    if (Array.isArray(body.posterSize) && body.posterSize.length === 2 && body.posterSize.every(n => Number.isInteger(n) && n >= 100 && n <= 20000)) next.posterSize = body.posterSize;
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
    config = next;
    cache.clear();
    return keyStatus();
  },

  async 'GET /api/search'(q) {
    const query = (q.get('q') || '').trim();
    if (!query) return { results: [] };
    if (config.tmdbKey) {
      const d = await tmdb('/search/multi', { query, include_adult: 'false' });
      return {
        provider: 'TMDB',
        results: (d?.results || []).filter(r => r.media_type === 'movie' || r.media_type === 'tv').map(r => ({
          type: r.media_type, id: r.id,
          title: r.title || r.name,
          year: (r.release_date || r.first_air_date || '').slice(0, 4),
          poster: r.poster_path ? TMDB_IMG + 'w342' + r.poster_path : null,
          overview: r.overview, popularity: r.popularity,
        })),
      };
    }
    // Without a TMDB key we can still search TV shows through TVmaze.
    const d = await getJSON(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`);
    return {
      provider: 'TVmaze',
      results: (d || []).map(({ show: s }) => ({
        type: 'tvmaze', id: s.id, title: s.name,
        year: (s.premiered || '').slice(0, 4),
        poster: s.image?.medium || null,
        overview: (s.summary || '').replace(/<[^>]+>/g, ''),
      })),
    };
  },

  async 'GET /api/title'(q) {
    const type = q.get('type'), id = q.get('id');
    const warnings = [];

    if (type === 'tvmaze') {
      const s = await getJSON(`https://api.tvmaze.com/shows/${id}`);
      if (!s) return null;
      const tvdbId = s.externals?.thetvdb;
      const [maze, fa] = await Promise.all([
        enabled('tvmaze') ? tvmazeImages(id) : [],
        enabled('fanart') ? fanart('tv', tvdbId).catch(e => (warnings.push('fanart.tv: ' + e.message), [])) : [],
      ]);
      return {
        type: 'tv', id: null, title: s.name, year: (s.premiered || '').slice(0, 4),
        overview: (s.summary || '').replace(/<[^>]+>/g, ''),
        poster: s.image?.original, backdrop: null,
        imdbId: s.externals?.imdb, tvdbId,
        companies: [], networks: [s.network?.name, s.webChannel?.name].filter(Boolean), providers: [],
        seasons: [], images: [...maze, ...fa], warnings,
      };
    }

    const t = await tmdbTitle(type, id, (q.get('region') || 'US').toUpperCase());
    if (!t) return null;
    const [fa, maze] = await Promise.all([
      enabled('fanart') ? fanart(type, type === 'movie' ? t.id : t.tvdbId).catch(e => (warnings.push('fanart.tv: ' + e.message), [])) : [],
      type === 'tv' && enabled('tvmaze')
        ? tvmazeLookup(t).then(s => (s ? tvmazeImages(s.id) : [])).catch(e => (warnings.push('TVmaze: ' + e.message), []))
        : [],
    ]);
    // TMDB still supplies the title details; turning it off only drops its artwork.
    if (!enabled('tmdb')) t.images = [];
    t.images.push(...fa, ...maze);
    t.warnings = warnings;
    return t;
  },

  // Streaming services & review sites, loaded one by one by the client.
  async 'GET /api/provider'(q) {
    if (!q.get('title')) throw Object.assign(new Error('title is required'), { status: 400 });
    const t = { type: q.get('type'), title: q.get('title'), originalTitle: q.get('orig'), year: q.get('year'), imdbId: q.get('imdb'), tmdbId: q.get('tmdb'), tvdbId: q.get('tvdb') };
    // "prime:US|PL,netflix:US" -> { prime: ['US', 'PL'], netflix: ['US'] }
    t.watchRegions = Object.fromEntries((q.get('wr') || '').split(',').filter(Boolean).map(x => { const [s, r] = x.split(':'); return [s, r.split('|')]; }));
    return runProvider(q.get('name'), t, { serpKey: config.serpKey, tvdbKey: config.tvdbKey, tvdbPin: config.tvdbPin, q: q.get('q') });
  },

  async 'GET /api/history'() { return history; },

  async 'POST /api/history'(_q, body) {
    const at = Date.now();
    if (typeof body.search === 'string' && body.search.trim()) {
      const q = body.search.trim().slice(0, 200);
      history.searches = remember(history.searches, { q, at }, x => x.q.toLowerCase() === q.toLowerCase());
    }
    const t = body.title;
    if (t && typeof t.type === 'string' && t.id != null && typeof t.title === 'string') {
      const item = { type: t.type, id: String(t.id), title: t.title.slice(0, 200), year: String(t.year || ''), poster: typeof t.poster === 'string' ? t.poster : null, at };
      history.titles = remember(history.titles, item, x => x.type === item.type && x.id === item.id);
    }
    return saveHistory();
  },

  // Removes one entry (?search=… or ?type=…&id=…), or everything without parameters.
  async 'DELETE /api/history'(q) {
    if (q.get('search')) history.searches = history.searches.filter(x => x.q !== q.get('search'));
    else if (q.get('id')) history.titles = history.titles.filter(x => !(x.type === q.get('type') && x.id === q.get('id')));
    else history = { searches: [], titles: [] };
    return saveHistory();
  },

  // Real pixel sizes for images whose source doesn't report them.
  async 'POST /api/sizes'(_q, body) {
    const urls = (Array.isArray(body.urls) ? body.urls : []).filter(u => /^https?:\/\//.test(u)).slice(0, 200);
    return sizes.getMany(urls);
  },

  async 'GET /api/season'(q) {
    const d = await tmdb(`/tv/${q.get('id')}/season/${q.get('season')}/images`);
    return { images: tmdbImages(d?.posters, 'season').map(i => ({ ...i, season: q.get('season') })) };
  },

  async 'GET /api/collection'(q) {
    const d = await tmdb(`/collection/${q.get('id')}/images`);
    return { images: [...tmdbImages(d?.posters, 'poster'), ...tmdbImages(d?.backdrops, 'backdrop')].map(i => ({ ...i, collection: true })) };
  },
};

// Sources that come with the title itself, before the per-service providers.
const BUILTIN_SOURCES = { tmdb: 'TMDB', fanart: 'fanart.tv', tvmaze: 'TVmaze' };
const enabled = id => !(config.disabledSources || []).includes(id);

function keyStatus() {
  return {
    hasTmdb: !!config.tmdbKey, hasFanart: !!config.fanartKey, hasSerp: !!config.serpKey, hasTvdb: !!config.tvdbKey,
    posterSize: config.posterSize || [1000, 1500],
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.name, onDemand: !!p.onDemand, enabled: enabled(id) })),
    sources: [
      ...Object.entries(BUILTIN_SOURCES).map(([id, name]) => ({ id, name })),
      ...Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.name })),
    ].map(s => ({ ...s, enabled: enabled(s.id) })),
  };
}

// Streams a remote image back as an attachment so the browser saves it with a sensible name.
// Only images are passed through, so this can't be used to fetch arbitrary pages.
async function download(q, res) {
  const url = new URL(q.get('url'));
  if (!/^https?:$/.test(url.protocol)) { res.writeHead(400).end('Only web images'); return; }
  const upstream = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 ArtworkFinder' } });
  if (!upstream.ok) { res.writeHead(upstream.status).end(); return; }
  if (!(upstream.headers.get('content-type') || '').startsWith('image/')) { res.writeHead(415).end('Not an image'); return; }
  const name = (q.get('name') || path.basename(url.pathname)).replace(/[^\w.\- ()]+/g, '_');
  res.writeHead(200, {
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    // inline=1 is for displaying images from sites that block hotlinking.
    ...(q.get('inline') ? { 'Cache-Control': 'max-age=86400' } : { 'Content-Disposition': `attachment; filename="${name}"` }),
  });
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

// JSON bodies, or a form post with a JSON "payload" field (used for ZIP downloads, so the
// browser streams the response straight to a file).
function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => {
      try {
        const form = (req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded');
        resolve(JSON.parse((form ? new URLSearchParams(data).get('payload') : data) || '{}'));
      } catch { resolve({}); }
    });
  });
}

async function zip(req, res) {
  const body = await readBody(req);
  const files = (Array.isArray(body.files) ? body.files : [])
    .filter(f => f && /^https?:\/\//.test(f.url) && typeof f.name === 'string').slice(0, 500);
  if (!files.length) { res.writeHead(400).end('No files'); return; }
  const name = (body.name || 'artwork').replace(/[^\w.\- ()]+/g, '_') + '.zip';
  await streamZip(res, files, name);
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (u.pathname === '/api/download') return await download(u.searchParams, res);
    if (u.pathname === '/api/zip' && req.method === 'POST') return await zip(req, res);
    if (u.pathname === '/api/thumb') {
      const url = u.searchParams.get('url') || '';
      const t = /^https?:\/\//.test(url) ? await thumbs.get(url).catch(() => null) : null;
      if (!t) { res.writeHead(502).end(); return; }
      res.writeHead(200, { 'Content-Type': t.type, 'Cache-Control': 'max-age=604800' });
      return res.end(t.body);
    }
    const handler = routes[`${req.method} ${u.pathname}`];
    if (handler) {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const out = await handler(u.searchParams, body);
      res.writeHead(out ? 200 : 404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out || { error: 'Not found' }));
    }
    // Static files
    const file = path.join(PUBLIC, u.pathname === '/' ? 'index.html' : path.normalize(u.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('Not found');
      return;
    }
    // no-cache: the browser revalidates, so app updates show up without a hard refresh.
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    res.writeHead(e.status || 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}).listen(PORT, () => console.log(`Artwork Finder running at http://localhost:${PORT}`));
