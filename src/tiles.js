// Плитки карты через свой сервер: покупателю не нужен доступ к сторонним картографическим сервисам,
// а CDN хостинга кэширует картинки. Отдаём только район Сочи — чтобы сервер не стал открытым прокси.
// OpenStreetMap — бесплатно, без ключа (CARTO стал требовать ключ и рисует водяной знак)
const SOURCES = [
  (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
];
// Сочи и окрестности с запасом: от Туапсе до Абхазии, с Красной Поляной
const AREA = { south: 43.0, north: 44.4, west: 38.6, east: 40.8 };
const cache = new Map(); // небольшой кэш в памяти экземпляра
const MAX_CACHE = 400;

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); };

function allowed(z, x, y) {
  if (!(z >= 3 && z <= 18)) return false;
  if (z <= 7) return true; // обзорные — весь мир можно
  return x >= lon2x(AREA.west, z) && x <= lon2x(AREA.east, z) && y >= lat2y(AREA.north, z) && y <= lat2y(AREA.south, z);
}

async function fetchTile(z, x, y) {
  for (const src of SOURCES) {
    try {
      const r = await fetch(src(z, x, y), { headers: { 'User-Agent': 'SeafoodSochiShop/1.0 (delivery map; +https://seafood-sochi.ru)', Referer: 'https://seafood-sochi.ru/' }, signal: AbortSignal.timeout(8000) });
      if (r.ok) return Buffer.from(await r.arrayBuffer());
    } catch {}
  }
  return null;
}

async function serve(req, res, p) {
  const m = p.match(/^\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/);
  if (!m) { res.writeHead(404); return res.end(); }
  const [z, x, y] = m.slice(1).map(Number);
  if (!allowed(z, x, y)) { res.writeHead(404); return res.end(); }
  const key = `${z}/${x}/${y}`;
  let buf = cache.get(key);
  if (!buf) {
    buf = await fetchTile(z, x, y);
    if (!buf) { res.writeHead(502, { 'Cache-Control': 'no-store' }); return res.end(); }
    cache.set(key, buf);
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  }
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800, s-maxage=2592000', 'X-Content-Type-Options': 'nosniff' });
  res.end(buf);
}

module.exports = { serve, allowed };
