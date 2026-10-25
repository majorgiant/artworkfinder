// Artwork pulled straight from streaming services and review sites.
//
// Wikidata maps a title's IMDb id to its ids on Apple TV, Netflix, Disney+, Rotten Tomatoes
// and Plex. We then read the artwork those services embed in their public title pages.
// Every provider returns the same image shape as the API sources in server.js.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const cache = new Map();
function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < 30 * 60 * 1000) return hit.p;
  const p = fn();
  cache.set(key, { t: Date.now(), p });
  p.catch(() => cache.delete(key));
  return p;
}

async function page(url) {
  return cached('page:' + url, async () => {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
    return { url: res.url, html: await res.text() };
  });
}

const slugify = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const norm = s => slugify(s).replace(/-/g, ' ');
// Like norm, but "Part Two", "Part 2" and "Part II" compare equal.
const NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6 };
const loose = s => norm(s).split(' ').map(w => NUMBERS[w] ?? w).join(' ');
const unescapeJs = s => s.replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
const ogImage = html => (html.match(/property="og:image" content="([^"]+)"/) || [])[1];

// --- Wikidata: IMDb id -> ids on other services ------------------------------------------
const WIKIDATA_PROPS = {
  P9586: 'appleMovie', P9751: 'appleShow', P1874: 'netflix', P7595: 'disneyMovie', P7596: 'disneySeries',
  P1258: 'rottenTomatoes', P11460: 'plex', P8055: 'primeVideo', P4835: 'tvdbSeries', P12196: 'tvdbMovie',
};

function wikidataIds(imdbId) {
  if (!imdbId) return Promise.resolve({});
  return cached('wd:' + imdbId, async () => {
    const props = Object.keys(WIKIDATA_PROPS).map(p => 'wdt:' + p).join(' ');
    const query = `SELECT ?p ?val WHERE { ?item wdt:P345 "${imdbId.replace(/[^\w]/g, '')}" . VALUES ?p { ${props} } ?item ?p ?val . }`;
    const res = await fetch('https://query.wikidata.org/sparql?query=' + encodeURIComponent(query), {
      headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'ArtworkFinder/1.0 (personal poster tool)' },
    });
    if (!res.ok) throw new Error('Wikidata responded ' + res.status);
    const ids = {};
    for (const b of (await res.json()).results.bindings) ids[WIKIDATA_PROPS[b.p.value.split('/').pop()]] = b.val.value;
    return ids;
  });
}

// --- JustWatch: service links per country ------------------------------------------------
// Streaming catalogs differ per country and the services' own search only sees the country this
// server is in. JustWatch's title page for a country where the title streams links straight to
// it on each service (Prime Video ids, Netflix ids, Apple TV, Plex), and those pages open from anywhere.
function watchLinks(t) {
  const wr = t.watchRegions || {};
  const regions = [...new Set(Object.values(wr).flat())].slice(0, 7);
  if (!regions.length) return Promise.resolve({});
  return cached(`watch:${t.type}:${t.tmdbId}:${regions}`, async () => {
    // primeGtis: [{ gti, region }], one per country, since each country's listing can have its own art.
    const out = { primeGtis: [] };
    for (const region of regions) {
      const p = await justWatchTitle(t, region === 'GB' ? 'uk' : region.toLowerCase()).catch(() => null);
      if (!p) continue;
      for (const [, r] of p.html.matchAll(/justwatch\.com\/a\?[^"]*?[?&;]r=([^&"]+)/g)) {
        const target = decodeURIComponent(r);
        const gti = (target.match(/gti=(amzn1\.dv\.gti\.[0-9a-f-]+)/) || [])[1];
        if (gti && (wr.prime || []).includes(region) && !out.primeGtis.some(x => x.gti === gti)) out.primeGtis.push({ gti, region });
        out.netflix ||= (target.match(/netflix\.com\/(?:\w+\/)?title\/(\d+)/) || [])[1];
        // Movies link to the movie; shows link to an episode with the show id as a parameter.
        const apple = target.match(/tv\.apple\.com\/(\w+)\/(?:movie|show)\/[^/]+\/(umc\.cmc\.[a-z0-9]+)/) ||
          target.match(/tv\.apple\.com\/(\w+)\/episode\/.*?showId=(umc\.cmc\.[a-z0-9]+)/);
        if (apple && !out.appleId) Object.assign(out, { appleCountry: apple[1], appleId: apple[2] });
        out.plexUrl ||= (target.match(/^https:\/\/watch\.plex\.tv\/(?:movie|show)\/[^?#]+/) || [])[0];
      }
    }
    return out;
  });
}

// Finds the title on JustWatch for one country. Its search results are drawn in the browser, so
// we go straight to the title URL; the path word for movies and shows differs per country.
const JW_SEGMENTS = { movie: ['movie', 'film', 'pelicula', 'filme'], tv: ['tv-show', 'tv-series', 'serie', 'serial', 'series'] };

async function justWatchTitle(t, cc) {
  const slugs = [...new Set([slugify(t.title), t.year && `${slugify(t.title)}-${t.year}`, t.originalTitle && slugify(t.originalTitle)].filter(Boolean))];
  for (const segment of JW_SEGMENTS[t.type === 'movie' ? 'movie' : 'tv']) {
    for (const slug of slugs) {
      const p = await page(`https://www.justwatch.com/${cc}/${segment}/${slug}`).catch(() => null);
      if (!p) continue;
      // Same-named titles share slugs, so check the IMDb id, or the heading's title and year.
      const h1 = ((p.html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '').replace(/<[^>]+>/g, ' ');
      if (t.imdbId && p.html.includes(`"${t.imdbId}"`)) return p;
      if (norm(h1).includes(norm(t.title)) && (!t.year || h1.includes(`(${t.year})`))) return p;
    }
  }
  return null;
}

// --- Apple TV -----------------------------------------------------------------------------
// Sections of the title page worth keeping; skips "related titles" and cast photos.
const APPLE_SHELVES = { EpisodeList: 'still', Trailers: 'still', BonusContent: 'still' };

function appleImage(a, kind, extra = {}) {
  const fmt = kind === 'logo' ? 'png' : 'jpg';
  const fill = (w, h) => a.template.replace('{w}', w).replace('{h}', h).replace('{c}', '').replace('{f}', fmt);
  const tw = 600, th = Math.round(600 * a.height / a.width);
  return { source: 'Apple TV', kind, url: fill(a.width, a.height), thumb: fill(tw, th), width: a.width, height: a.height, lang: null, ...extra };
}

async function appleTv(t, ids, { links = {} } = {}) {
  const id = (t.type === 'movie' ? ids.appleMovie : ids.appleShow) || links.appleId;
  if (!id) return { images: [], note: 'Not found on Apple TV' };
  // The US storefront usually lists the most extras; titles not sold there fall back to the linked country.
  let p = null;
  for (const country of [...new Set(['us', links.appleCountry].filter(Boolean))]) {
    p = await page(`https://tv.apple.com/${country}/${t.type === 'movie' ? 'movie' : 'show'}/${id}`).catch(() => null);
    if (p) break;
  }
  if (!p) return { images: [] };
  const json = p.html.match(/<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/);
  if (!json) return { images: [] };
  const shelves = findKey(JSON.parse(json[1]), 'shelves') || [];
  const images = [];
  for (const shelf of shelves) {
    const sid = shelf.id || '';
    if (sid.startsWith('canonical-header')) {
      for (const item of shelf.items || []) {
        // "Superhero" art is Apple's textless hero image; the title logo is a separate layer.
        if (item.artwork?.wide) images.push(appleImage(item.artwork.wide, 'backdrop', { textless: true, sub: 'hero (wide)' }));
        if (item.artwork?.tall) images.push(appleImage(item.artwork.tall, 'poster', { textless: true, sub: 'hero (tall)' }));
        if (item.contentLogo?.template) images.push(appleImage(item.contentLogo, 'logo'));
      }
      continue;
    }
    const kind = Object.entries(APPLE_SHELVES).find(([k]) => sid.includes(k))?.[1];
    if (!kind) continue;
    for (const item of shelf.items || []) {
      if (item.artwork?.template && item.artwork.width >= 1280) images.push(appleImage(item.artwork, kind, { sub: item.title }));
    }
  }
  return { images, link: p.url };
}

function findKey(o, key) {
  if (!o || typeof o !== 'object') return null;
  if (key in o) return o[key];
  for (const v of Object.values(o)) { const r = findKey(v, key); if (r) return r; }
  return null;
}

// --- Rotten Tomatoes ---------------------------------------------------------------------
// RT image URLs wrap the original in resizer layers; the innermost URL is the full-size file.
const rtOriginal = u => { const parts = unescapeJs(u).split('/v2/'); return parts[parts.length - 1]; };

async function rtFindPath(t) {
  const p = await page('https://www.rottentomatoes.com/search?search=' + encodeURIComponent(t.title));
  if (!p) return null;
  const want = t.type === 'movie' ? '/m/' : '/tv/';
  const rows = p.html.split('<search-page-media-row').slice(1);
  for (const row of rows) {
    const href = (row.match(/href="https:\/\/www\.rottentomatoes\.com(\/(?:m|tv)\/[^"]+)"/) || [])[1];
    const year = (row.match(/(?:release-year|start-year)="(\d{4})"/) || [])[1];
    const name = (row.match(/data-qa="info-name"[^>]*>\s*([^<]+)/) || [])[1];
    if (href?.startsWith(want) && (!t.year || year === t.year) && (!name || norm(name) === norm(t.title))) return href.slice(1);
  }
  return null;
}

async function rottenTomatoes(t, ids) {
  const path = ids.rottenTomatoes || await rtFindPath(t);
  if (!path) return { images: [], note: 'No Rotten Tomatoes match' };
  const [main, pics] = await Promise.all([
    page('https://www.rottentomatoes.com/' + path),
    page(`https://www.rottentomatoes.com/${path}/pictures`).catch(() => null),
  ]);
  const images = [];
  const poster = main && ogImage(main.html);
  if (poster) images.push({ source: 'Rotten Tomatoes', kind: 'poster', url: rtOriginal(poster), thumb: unescapeJs(poster), lang: null, sub: 'main poster' });
  const carousel = pics?.html.match(/<script id="photosCarousel"[^>]*>([\s\S]*?)<\/script>/);
  if (carousel) {
    for (const i of JSON.parse(carousel[1]).images || []) {
      const w = +i.width, h = +i.height;
      images.push({
        source: 'Rotten Tomatoes', kind: h > w * 1.2 ? 'poster' : 'still',
        url: rtOriginal(i.imageUrl), thumb: unescapeJs(i.imageUrl), width: w || undefined, height: h || undefined, lang: null, sub: 'photo',
      });
    }
  }
  return { images, link: 'https://www.rottentomatoes.com/' + path };
}

// --- Netflix -------------------------------------------------------------------------------
async function netflix(t, ids, { links = {} } = {}) {
  const id = ids.netflix || links.netflix;
  if (!id) return { images: [], note: 'Not found on Netflix' };
  const p = await page('https://www.netflix.com/title/' + id);
  if (!p) return { images: [] };
  const html = unescapeJs(p.html);
  // The title's own data; the rest of the page is "popular on Netflix" rows for other titles.
  const block = html.slice(html.indexOf('"nmTitleGQL"'), html.indexOf('"trifectaRows"'));
  if (!block || /"isAvailable":false/.test(block.slice(0, 6000))) return { images: [], note: 'No longer on Netflix' };
  const images = [];
  const billboard = (block.match(/"billboard":\{[^}]*?"small":"([^"]+)"/) || [])[1];
  if (billboard) images.push({ source: 'Netflix', kind: 'backdrop', url: billboard, thumb: billboard, width: 1920, height: 1080, lang: null, sub: 'billboard' });
  return { images, link: p.url };
}

// --- Disney+ -------------------------------------------------------------------------------
async function disneyPlus(t, ids) {
  const id = t.type === 'movie' ? ids.disneyMovie : ids.disneySeries;
  if (!id) return { images: [], note: 'Not on Disney+ (per Wikidata)' };
  const p = await page(`https://www.disneyplus.com/${t.type === 'movie' ? 'movies' : 'series'}/_/${id}`);
  if (!p) return { images: [] };
  const hero = p.html.slice(p.html.indexOf('data-testid="hero"'), p.html.indexOf('data-testid="hero"') + 40000);
  const seen = new Set(), images = [];
  const base = 'https://disney.images.edge.bamgrid.com/ripcut-delivery/v2/variant/disney/';
  for (const m of hero.matchAll(/ripcut-delivery\/v2\/variant\/disney\/([0-9a-f-]{36})\/(compose|trim)/g)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    // "compose" is the textless background, "trim" the transparent title treatment.
    images.push(m[2] === 'trim'
      ? { source: 'Disney+', kind: 'logo', url: `${base}${m[1]}/trim?format=png&width=2400`, thumb: `${base}${m[1]}/trim?format=png&width=600`, lang: null }
      : { source: 'Disney+', kind: 'backdrop', url: `${base}${m[1]}/compose?format=jpeg&width=3840`, thumb: `${base}${m[1]}/compose?format=jpeg&width=700`, width: 3840, height: 2160, lang: null, textless: true });
  }
  return { images, link: p.url };
}

// --- Plex ----------------------------------------------------------------------------------
async function plex(t, ids, { links = {} } = {}) {
  const kind = t.type === 'movie' ? 'movie' : 'show';
  const slug = slugify(t.title);
  let found = links.plexUrl ? await page(links.plexUrl).catch(() => null) : null;
  for (const s of found ? [] : [slug, t.year && `${slug}-${t.year}`].filter(Boolean)) {
    const p = await page(`https://watch.plex.tv/${kind}/${s}`).catch(() => null);
    if (!p) continue;
    // With a Plex id from Wikidata we can be sure; otherwise require the year on the page.
    if (ids.plex ? p.html.includes(ids.plex) : (!t.year || p.html.includes(t.year))) { found = p; break; }
  }
  if (!found) return { images: [], note: 'No Plex match' };
  const urls = new Set();
  for (const m of found.html.matchAll(/metadata-static\.plex\.tv%2F([^"&\\ ]+)/g)) urls.add('https://metadata-static.plex.tv/' + decodeURIComponent(m[1]));
  const bg = decodeURIComponent((ogImage(found.html) || '').split('url=')[1] || '');
  const images = [...urls].filter(u => !/\/people\/|\/extras\//.test(u)).map(u => {
    const isLogo = u.endsWith('.png');
    const isBg = u === bg;
    return {
      source: 'Plex', kind: isLogo ? 'logo' : isBg ? 'backdrop' : 'other', url: u,
      thumb: `https://images.plex.tv/photo?size=medium-360&scale=2&url=${encodeURIComponent(u)}`,
      lang: null, sub: isLogo ? 'title logo' : isBg ? 'background' : 'artwork',
    };
  });
  return { images, link: found.url };
}

// --- Prime Video -------------------------------------------------------------------------
async function primeVideo(t, _ids, { links = {} } = {}) {
  // Straight to the title via its Prime id in each country's catalog. Countries often share
  // images (same file), which are skipped; localized versions are kept, tagged with the country.
  const images = [], seen = new Set();
  let link = null;
  for (const { gti, region } of (links.primeGtis || []).slice(0, 6)) {
    const p = await page('https://www.primevideo.com/detail/' + gti).catch(() => null);
    if (!p || !p.html.includes('"headerDetail"')) continue;
    for (const i of primeImages(p.html.slice(p.html.indexOf('"headerDetail"')))) {
      if (seen.has(i.url)) continue;
      seen.add(i.url);
      images.push({ ...i, region, sub: `${i.sub} · ${region === 'GB' ? 'UK' : region}` });
    }
    link ||= p.url;
  }
  if (images.length) return { images, link };
  return primeSearch(t);
}

async function primeSearch(t) {
  const s = await page('https://www.primevideo.com/search/?phrase=' + encodeURIComponent(t.title));
  if (!s) return { images: [] };
  const target = norm(t.title);
  const candidates = [];
  for (const m of s.html.matchAll(/aria-label="([^"]+)"[^>]*><\/button><a href="(\/detail\/[A-Z0-9]+)/g)) {
    const label = norm(m[1].replace(/&amp;/g, '&'));
    if ((label === target || label.startsWith(target + ' season')) && !candidates.includes(m[2])) candidates.push(m[2]);
  }
  // Same-named titles are common (Severance the show vs. the 2006 film), so check type and year.
  let p = null, header = '';
  for (const detail of candidates.slice(0, 3)) {
    const d = await page('https://www.primevideo.com' + detail).catch(() => null);
    if (!d) continue;
    const h = d.html.slice(d.html.indexOf('"headerDetail"'));
    const entity = (h.match(/"entityType":"([^"]+)"/) || [])[1] || '';
    const year = +(h.match(/"releaseYear":"?(\d{4})/) || [])[1];
    const typeOk = t.type === 'movie' ? /movie/i.test(entity) : /tv|series|show/i.test(entity);
    const yearOk = t.type !== 'movie' || !t.year || !year || Math.abs(year - t.year) <= 1;
    if (typeOk && yearOk) { p = d; header = h; break; }
  }
  if (!p) return { images: [], note: 'Not found on Prime Video' };
  return { images: primeImages(header), link: p.url };
}

function primeImages(header) {
  // The title's own images sit in the page header; later "images" blocks are other titles.
  const block = (header.match(/"images":\{([^{}]*)\}/) || [])[1] || '';
  const kinds = { covershot: ['backdrop', 'cover (16:9)'], heroshot: ['backdrop', 'hero'], packshot: ['thumb', 'pack shot'], titleshot: ['thumb', 'title shot'], titleLogo: ['logo', 'title logo'] };
  const seen = new Set(), images = [];
  for (const [, key, url] of block.matchAll(/"(\w+)":"(https:[^"]+)"/g)) {
    if (!kinds[key] || seen.has(url)) continue;
    seen.add(url);
    const [kind, sub] = kinds[key];
    images.push({ source: 'Prime Video', kind, sub, url, thumb: url.replace(/\.(jpg|png)$/, '._SX700_.$1'), lang: null });
  }
  return images;
}

// --- MediUX --------------------------------------------------------------------------------
// Community poster sets keyed by TMDB id. The page embeds every set's files as JSON.
const MEDIUX_KINDS = { poster: 'poster', backdrop: 'backdrop', title_card: 'titlecard' };

async function mediux(t) {
  if (!t.tmdbId) return { images: [], note: 'Needs a TMDB match' };
  const link = `https://mediux.pro/${t.type === 'movie' ? 'movies' : 'shows'}/${t.tmdbId}`;
  const p = await page(link);
  if (!p) return { images: [], note: 'No MediUX sets yet' };
  const html = p.html.replace(/\\"/g, '"');
  // Set names and creators, so each image can say which set it belongs to.
  const sets = {};
  for (const m of html.matchAll(/\{"id":"(\d+)","set_name":"([^"]*)","language":[^,]*,"date_updated":"[^"]*","date_created":"[^"]*","user_created":\{"id":"[^"]*","username":"([^"]*)"/g)) {
    sets[m[1]] = `${m[2]} by ${m[3]}`;
  }
  // A page can also list other titles from the same box set (Dune vs. Dune: Prophecy),
  // so keep only files named "<Title> (<year>)".
  const prefix = norm(`${t.title} ${t.year || ''}`);
  const seen = new Set(), images = [];
  for (const m of html.matchAll(/"id":"([0-9a-f-]{36})","filename_disk":"[^"]*","title":"([^"]*)","fileType":"(\w+)"[^{}]*?"textless":(\w+)/g)) {
    const [, id, title, type, textless] = m;
    // Each file sits inside its set's JSON; the nearest preceding set id is the one it belongs to.
    const setId = (html.slice(Math.max(0, m.index - 600), m.index).match(/.*"set_id":\{"id":"(\d+)"/s) || [])[1];
    if (!MEDIUX_KINDS[type] || seen.has(id) || !norm(title).startsWith(prefix)) continue;
    seen.add(id);
    const season = (title.match(/Season (\d+)/i) || [])[1];
    const kind = type === 'poster' && season ? 'season' : MEDIUX_KINDS[type];
    images.push({
      source: 'MediUX', kind, url: `https://api.mediux.pro/assets/${id}`, thumb: `https://api.mediux.pro/assets/${id}?key=thumb`,
      lang: null, textless: textless === 'true' ? true : null, season,
      sub: [title.replace(/^.*? - /, ''), sets[setId]].filter(Boolean).join(' · '), page: setId ? `https://mediux.pro/sets/${setId}` : link,
    });
  }
  return { images, link };
}

// --- IMP Awards ----------------------------------------------------------------------------
// Every official theatrical poster variant. Pages live at /<year>/<slug>.html (/tv/ for shows),
// and each variant comes in up to three sizes: name.jpg, name_xlg.jpg and name_xxlg.jpg.
async function exists(url) {
  return cached('head:' + url, async () => {
    const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA } });
    return res.ok && (res.headers.get('content-type') || '').startsWith('image/');
  });
}

async function impAwards(t) {
  const slug = slugify(t.title.replace(/[:.,!?'’]/g, '')).replace(/-/g, '_');
  const folders = t.type === 'movie' ? [t.year, +t.year + 1, +t.year - 1].filter(Boolean) : ['tv'];
  let found = null, folder = null;
  for (const f of folders) {
    const p = await page(`http://www.impawards.com/${f}/${slug}.html`).catch(() => null);
    const title = p && (p.html.match(/<title>([^<]*)/) || [])[1];
    if (title && norm(title).startsWith(norm(t.title))) { found = p; folder = f; break; }
  }
  if (!found) return { images: [], note: 'No IMP Awards page found' };
  const base = `http://www.impawards.com/${folder}/posters/`;
  const names = [slug, ...new Set([...found.html.matchAll(new RegExp(`${slug}_(ver\\d+)\\.html`, 'g'))].map(m => `${slug}_${m[1]}`))];
  const images = [];
  // Check which big sizes exist, a few at a time to go easy on the site.
  for (let i = 0; i < names.length; i += 4) {
    const batch = await Promise.all(names.slice(i, i + 4).map(async name => {
      const size = await exists(base + name + '_xxlg.jpg') ? '_xxlg' : await exists(base + name + '_xlg.jpg') ? '_xlg' : '';
      return {
        source: 'IMP Awards', kind: 'poster', url: base + name + size + '.jpg', thumb: base + name + '.jpg', lang: null, proxy: true,
        sub: name === slug ? 'main poster' : name.replace(slug + '_', '').replace('ver', 'variant '),
        page: `http://www.impawards.com/${folder}/${name}.html`,
      };
    }));
    images.push(...batch);
  }
  return { images, link: `http://www.impawards.com/${folder}/${slug}.html` };
}

// --- ThePosterDB ---------------------------------------------------------------------------
// The poster grid shows 500×750 previews; /api/assets/<poster id> serves the full-size file.
async function thePosterDb(t) {
  // Search one section: without it the results can open on another tab (e.g. Collections).
  const section = t.type === 'movie' ? 'movies' : 'shows';
  const s = await page(`https://theposterdb.com/search?term=${encodeURIComponent(t.title)}&section=${section}`);
  if (!s) return { images: [] };
  const candidates = [];
  for (const m of s.html.matchAll(/href="(https:\/\/theposterdb\.com\/posters\/\d+)">\s*<strong>([^<]+)<\/strong>\s*\((\d{4})\)/g)) {
    if (norm(m[2].replace(/&amp;/g, '&')) === norm(t.title) && (!t.year || Math.abs(m[3] - t.year) <= 1)) candidates.push(m[1]);
  }
  // The same title can appear twice (e.g. an empty duplicate entry), so use the first with posters.
  for (const listUrl of candidates.slice(0, 3)) {
    const r = await tpdbPosters(listUrl);
    if (r.images.length) return r;
  }
  return { images: [], note: candidates.length ? 'No public posters on ThePosterDB' : 'No ThePosterDB match' };
}

async function tpdbPosters(listUrl) {
  const images = [];
  for (let n = 1; n <= 3; n++) {
    const p = await page(listUrl + (n > 1 ? '?page=' + n : '')).catch(() => null);
    if (!p) break;
    const tiles = p.html.split('<div class="hovereffect rounded-poster">').slice(1);
    for (const tile of tiles) {
      const img = (tile.match(/type="image\/jpeg" srcset="([^"]+)"/) || [])[1];
      const id = (tile.match(/data-poster-id='(\d+)'/) || [])[1];
      const type = (tile.match(/data-poster-type='(\w+)'/) || [])[1];
      const title = (tile.match(/<p class="p-0 mb-1 text-break">([^<]*)/) || [])[1] || '';
      const by = (tile.match(/uploaded-by[^>]*>by <a[^>]*>([^<]*)/) || [])[1];
      if (!img || !id) continue;
      const season = (title.match(/Season (\d+)/i) || [])[1];
      images.push({
        source: 'ThePosterDB', kind: type === 'season' || season ? 'season' : type === 'collection' ? 'other' : 'poster',
        url: `https://theposterdb.com/api/assets/${id}`, thumb: img, lang: null, season,
        sub: by ? 'by ' + by : '', page: `https://theposterdb.com/poster/${id}`,
      });
    }
    if (!p.html.includes(`page=${n + 1}`)) break;
  }
  return { images, link: listUrl };
}

// --- TheTVDB (API v4, needs your API key) -----------------------------------------------
const TVDB = 'https://api4.thetvdb.com/v4';
let tvdbToken = null; // { key, token, until }

async function tvdbLogin(key, pin) {
  if (tvdbToken && tvdbToken.key === key + pin && Date.now() < tvdbToken.until) return tvdbToken.token;
  const res = await fetch(TVDB + '/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(pin ? { apikey: key, pin } : { apikey: key }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.data?.token) throw new Error('TheTVDB login failed: ' + (body.message || res.status));
  // Tokens last a month; renew well before that.
  tvdbToken = { key: key + pin, token: body.data.token, until: Date.now() + 20 * 24 * 3600 * 1000 };
  return tvdbToken.token;
}

async function tvdbGet(path, key, pin) {
  return cached('tvdb:' + path, async () => {
    let res = await fetch(TVDB + path, { headers: { Authorization: 'Bearer ' + await tvdbLogin(key, pin), Accept: 'application/json' } });
    if (res.status === 401) { tvdbToken = null; res = await fetch(TVDB + path, { headers: { Authorization: 'Bearer ' + await tvdbLogin(key, pin), Accept: 'application/json' } }); }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('TheTVDB responded ' + res.status);
    return (await res.json()).data;
  });
}

// TheTVDB names languages with three letters; the rest of the app uses two.
const LANG3 = { eng: 'en', nld: 'nl', deu: 'de', fra: 'fr', spa: 'es', ita: 'it', por: 'pt', jpn: 'ja', kor: 'ko', zho: 'zh', rus: 'ru', pol: 'pl', swe: 'sv', dan: 'da', nor: 'no', fin: 'fi', tur: 'tr', ces: 'cs', hun: 'hu', heb: 'he', ara: 'ar', ell: 'el', tha: 'th', hin: 'hi', ukr: 'uk', ron: 'ro' };

// Artwork types have a name ("Poster") and what they belong to (series, season, movie, episode).
function tvdbKind(type = {}) {
  const n = (type.name || '').toLowerCase(), record = type.recordType;
  if (record === 'season') return n.includes('poster') ? 'season' : null;
  if (record !== 'series' && record !== 'movie') return null; // episodes, actors, companies, lists
  if (n.includes('poster')) return 'poster';
  if (n.includes('background') || n.includes('fanart')) return 'backdrop';
  if (n.includes('banner')) return 'banner';
  if (n.includes('clearlogo')) return 'logo';
  if (n.includes('clearart')) return 'clearart';
  if (n.includes('icon')) return 'other';
  return null; // episode stills, actor photos, cinemagraphs: not useful here
}

async function theTvdb(t, ids, { tvdbKey, tvdbPin }) {
  if (!tvdbKey) return { images: [], note: 'Add your TheTVDB API key in settings' };
  const movie = t.type === 'movie';
  let id = movie ? ids.tvdbMovie : (t.tvdbId || ids.tvdbSeries);
  if (!id && t.imdbId) {
    const hits = await tvdbGet('/search/remoteid/' + t.imdbId, tvdbKey, tvdbPin).catch(() => null);
    id = (hits || []).map(h => (movie ? h.movie : h.series)?.id).find(Boolean);
  }
  if (!id) return { images: [], note: 'Not found on TheTVDB' };
  const [types, record] = await Promise.all([
    tvdbGet('/artwork/types', tvdbKey, tvdbPin),
    tvdbGet(movie ? `/movies/${id}/extended` : `/series/${id}/artworks`, tvdbKey, tvdbPin),
  ]);
  const typeById = Object.fromEntries((types || []).map(x => [x.id, x]));
  const images = [];
  for (const a of record?.artworks || []) {
    const kind = tvdbKind(typeById[a.type]);
    if (!kind || !a.image) continue;
    const lang = a.language ? LANG3[a.language] || a.language.slice(0, 2) : null;
    images.push({
      source: 'TheTVDB', kind, url: a.image, thumb: a.thumbnail || a.image,
      width: a.width || undefined, height: a.height || undefined,
      lang, textless: a.includesText === false ? true : null, votes: a.score || 0,
      sub: `${typeById[a.type]?.recordType === 'season' ? 'Season ' : ''}${typeById[a.type]?.name || ''}`,
    });
  }
  return { images, link: `https://thetvdb.com/dereferrer/${movie ? 'movie' : 'series'}/${id}` };
}

// --- FILMGRAB ------------------------------------------------------------------------------
// High-quality frame grabs from the film itself, in the film's own aspect ratio.
async function filmGrab(t) {
  const s = await page('https://film-grab.com/?s=' + encodeURIComponent(t.title));
  if (!s) return { images: [] };
  // Results look like "Dune (2021)" or "Dune: Part 2"; prefer the one with the right year.
  const posts = [...s.html.matchAll(/<a href="(https:\/\/film-grab\.com\/\d{4}\/\d\d\/\d\d\/[^"]+)"[^>]*>\s*([^<]+?)\s*</g)]
    .map(m => ({ url: m[1], name: m[2].replace(/&#8211;/g, '–').replace(/&amp;/g, '&') }));
  const named = posts.filter(p => loose(p.name.replace(/\(\d{4}\)/, '')) === loose(t.title));
  let post = named.find(p => t.year && p.name.includes(`(${t.year})`)) || named.find(p => !/\(\d{4}\)/.test(p.name));
  if (!post) return { images: [], note: 'No FILMGRAB match' };
  const p = await page(post.url);
  // Without a year in the name, check the post's "Year:" line.
  const year = (p?.html.match(/Year:(?:&nbsp;|\s| )*<a[^>]*>(\d{4})</) || [])[1];
  if (!p || (t.year && year && Math.abs(year - t.year) > 1)) return { images: [], note: 'No FILMGRAB match' };
  const images = [];
  for (const m of p.html.matchAll(/class="bwg-a bwg_lightbox"\s+data-image-id="\d+" href="([^"]+)"[\s\S]*?src="([^"]+)"[\s\S]*?data-width="(\d+)"\s+data-height="(\d+)"/g)) {
    images.push({ source: 'FILMGRAB', kind: 'still', url: m[1], thumb: m[2], lang: null, sub: 'frame grab', page: post.url });
  }
  return { images, link: post.url };
}

// --- PosterSpy -----------------------------------------------------------------------------
// Alternative posters by independent artists: inspiration, and their work, not studio art.
const PS_FILLER = new Set(['poster', 'posters', 'alt', 'alternative', 'alternate', 'fan', 'made', 'fanmade', 'tribute', 'art', 'artwork', 'minimalist', 'minimal', 'character', 'official', 'teaser', 'version', 'redesign', 'concept', 'print', 'illustrated', 'illustration', 'design', 'movie', 'film', 'the']);

async function posterSpy(t) {
  const want = loose(t.title);
  const images = [];
  for (let n = 1; n <= 2; n++) {
    const s = await page(`https://posterspy.com/${n > 1 ? `page/${n}/` : ''}?s=${encodeURIComponent(t.title)}`).catch(() => null);
    if (!s) break;
    for (const card of s.html.split('wpps-poster-card').slice(1)) {
      const href = (card.match(/href="(https:\/\/posterspy\.com\/posters\/[^"]+)"/) || [])[1];
      const img = (card.match(/<img src="(https:\/\/media\.posterspy\.com\/[^"]+)"/) || [])[1];
      const title = (card.match(/class="imagetitle">([^<]*)/) || [])[1]?.replace(/&#8211;/g, '–').replace(/&amp;/g, '&') || '';
      const artist = (card.match(/profile\/[^"]+"[^>]*>([^<]+)</) || [])[1];
      if (!href || !img) continue;
      // Same film only: its title, then nothing but its year or words like "poster" / "alt".
      const name = loose(title);
      if (!name.startsWith(want)) continue;
      const rest = name.slice(want.length).trim().split(' ').filter(Boolean);
      const years = rest.filter(w => /^(19|20)\d\d$/.test(w));
      const ok = years.every(y => y === t.year) && rest.every(w => PS_FILLER.has(w) || w === t.year);
      if (!ok && !(t.year && years.includes(t.year))) continue;
      images.push({
        source: 'PosterSpy', kind: 'poster', url: img.replace(/-\d+x\d+(\.\w+)$/, '$1'), thumb: img, lang: null,
        sub: `${title}${artist ? ' · by ' + artist : ''} (fan art)`, page: href,
      });
    }
  }
  return { images, link: `https://posterspy.com/?s=${encodeURIComponent(t.title)}` };
}

// --- Google Images (via SerpAPI, needs a key) --------------------------------------------
async function google(t, _ids, { serpKey, q }) {
  if (!serpKey) return { images: [], note: 'Add a SerpAPI key in settings to include Google Images results' };
  const query = q || `${t.title} ${t.year || ''} poster`;
  const url = `https://serpapi.com/search.json?engine=google_images&q=${encodeURIComponent(query)}&tbs=isz:l&api_key=${serpKey}`;
  const d = await cached('serp:' + query, async () => {
    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok || body.error) throw new Error('SerpAPI: ' + (body.error || res.status));
    return body;
  });
  const images = (d.images_results || []).filter(i => i.original).map(i => ({
    source: 'Google', kind: 'web', url: i.original, thumb: i.thumbnail, width: i.original_width, height: i.original_height,
    lang: null, sub: i.source, page: i.link, title: i.title,
  }));
  return { images, query };
}

const PROVIDERS = {
  appletv: { name: 'Apple TV', fn: appleTv },
  prime: { name: 'Prime Video', fn: primeVideo },
  netflix: { name: 'Netflix', fn: netflix },
  disney: { name: 'Disney+', fn: disneyPlus },
  plex: { name: 'Plex', fn: plex },
  rt: { name: 'Rotten Tomatoes', fn: rottenTomatoes },
  mediux: { name: 'MediUX', fn: mediux },
  imp: { name: 'IMP Awards', fn: impAwards },
  tpdb: { name: 'ThePosterDB', fn: thePosterDb },
  tvdb: { name: 'TheTVDB', fn: theTvdb },
  filmgrab: { name: 'FILMGRAB', fn: filmGrab },
  posterspy: { name: 'PosterSpy', fn: posterSpy },
  google: { name: 'Google', fn: google, onDemand: true },
};

async function runProvider(name, t, opts = {}) {
  const p = PROVIDERS[name];
  if (!p) throw Object.assign(new Error('Unknown provider'), { status: 404 });
  const [ids, links] = await Promise.all([
    wikidataIds(t.imdbId).catch(() => ({})),
    watchLinks(t).catch(() => ({})),
  ]);
  return p.fn(t, ids, { ...opts, links });
}

module.exports = { PROVIDERS, runProvider };
