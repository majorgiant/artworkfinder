// Image utilities that need no dependencies: reading an image's pixel size from the first bytes
// of the file, and streaming several images to the browser as one ZIP.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// --- Pixel size from the file header --------------------------------------------------------
// JPEG, PNG and WebP store their size near the start of the file, so we read only until we find
// it (usually a few KB) instead of downloading the whole image. Some JPEGs carry megabytes of
// editing metadata first, so reading continues up to 8 MB when needed.

function parseSize(b) {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') { const n = b.readUInt32LE(21); return { width: (n & 0x3fff) + 1, height: ((n >> 14) & 0x3fff) + 1 }; }
    if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      // Start-of-frame markers hold the size (C4, C8 and CC are other tables).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Sites with a request limit get their requests spaced out. ThePosterDB allows 30 a minute (for
// your whole connection, browser included), so we stay at 24 to leave room for normal browsing.
// Its image server blocks bursts for a while (403), so thumbnails are spaced out too.
const HOST_GAP = { 'theposterdb.com': 2500, 'images.theposterdb.com': 500 };
const hostQueue = {};
async function politeFetch(url, headers = {}) {
  const host = new URL(url).host, gap = HOST_GAP[host];
  if (gap) {
    const turn = (hostQueue[host] || Promise.resolve()).then(() => sleep(gap));
    hostQueue[host] = turn;
    await turn;
  }
  let res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
  // Rate limited anyway: wait as long as the site asks (max 30 s) and try once more.
  if (res.status === 429 || (res.status === 403 && gap)) {
    res.body?.cancel().catch(() => {});
    await sleep(Math.min(+res.headers.get('retry-after') || 5, 30) * 1000);
    res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
  }
  return res;
}

async function probeSize(url) {
  const res = await politeFetch(url, { Range: 'bytes=0-8388607' });
  if (!res.ok || !res.body) return null;
  const reader = res.body.getReader();
  let buf = Buffer.alloc(0), size = null;
  try {
    while (buf.length < 8 * 1024 * 1024) {
      const { value, done } = await reader.read();
      if (done) break;
      buf = Buffer.concat([buf, Buffer.from(value)]);
      if ((size = parseSize(buf))) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return size && size.width && size.height ? size : null;
}

// Sizes never change for a given URL, so they're kept on disk next to the config.
function sizeCache(dir) {
  const file = path.join(dir, 'sizes.json');
  let sizes = {};
  try { sizes = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(sizes)); } catch {} }, 2000);
  };
  const pending = new Map();

  async function get(url) {
    if (url in sizes) return sizes[url];
    if (!pending.has(url)) {
      pending.set(url, probeSize(url).catch(() => null).then(s => {
        pending.delete(url);
        if (s) { sizes[url] = [s.width, s.height]; save(); }
        return s ? sizes[url] : null;
      }));
    }
    return pending.get(url);
  }

  // Probes a batch a few at a time per site (rate-limited sites are spaced out by politeFetch).
  async function getMany(urls) {
    const out = {}, byHost = {};
    for (const u of new Set(urls)) (byHost[new URL(u).host] ||= []).push(u);
    await Promise.all(Object.values(byHost).map(queue =>
      Promise.all(Array.from({ length: 4 }, async () => {
        while (queue.length) { const u = queue.shift(); out[u] = await get(u); }
      }))));
    return out;
  }
  return { getMany };
}

// --- ZIP ------------------------------------------------------------------------------------
// Images are already compressed, so files are stored as-is ("stored" method), one at a time.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function streamZip(res, files, zipName) {
  res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${zipName}"` });
  const central = [];
  const used = new Set();
  // File date/time in DOS format, so the files don't show up as 1980.
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  let offset = 0;
  const write = b => new Promise(r => { offset += b.length; res.write(b) ? r() : res.once('drain', r); });

  for (const f of files) {
    let data;
    try {
      const r = await politeFetch(f.url);
      if (!r.ok || !(r.headers.get('content-type') || '').startsWith('image/')) continue;
      data = Buffer.from(await r.arrayBuffer());
    } catch { continue; }
    // Unique names inside the ZIP: "name.jpg", "name (2).jpg", ...
    let name = f.name.replace(/[\\/:*?"<>|]+/g, '_'), n = 2;
    while (used.has(name)) name = f.name.replace(/(\.\w+)?$/, ` (${n++})$1`);
    used.add(name);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const start = offset;
    await write(local); await write(nameBuf); await write(data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(dosTime, 12); entry.writeUInt16LE(dosDate, 14);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28); entry.writeUInt32LE(start, 42);
    central.push(Buffer.concat([entry, nameBuf]));
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  await write(dir); await write(end);
  res.end();
}

// --- Thumbnail cache ------------------------------------------------------------------------
// Thumbnails from rate-limited sites are fetched once (spaced out) and kept on disk, so the
// gallery and the duplicate check never hit the site in bursts.
function thumbCache(dir) {
  const root = path.join(dir, 'thumbs');
  // Without write access the cache is skipped: thumbnails are then fetched fresh each time.
  let writable = true;
  try { fs.mkdirSync(root, { recursive: true }); } catch { writable = false; }
  const pending = new Map();
  async function get(url) {
    const file = path.join(root, crypto.createHash('sha1').update(url).digest('hex'));
    try { return { body: await fs.promises.readFile(file), type: (await fs.promises.readFile(file + '.type', 'utf8')) }; } catch {}
    if (!pending.has(url)) {
      pending.set(url, (async () => {
        const res = await politeFetch(url);
        const type = res.headers.get('content-type') || '';
        if (!res.ok || !type.startsWith('image/')) { res.body?.cancel().catch(() => {}); return null; }
        const body = Buffer.from(await res.arrayBuffer());
        if (writable) {
          await fs.promises.writeFile(file, body).catch(() => {});
          await fs.promises.writeFile(file + '.type', type).catch(() => {});
        }
        return { body, type };
      })().finally(() => pending.delete(url)));
    }
    return pending.get(url);
  }
  return { get };
}

module.exports = { sizeCache, streamZip, parseSize, thumbCache };
