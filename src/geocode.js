// Поиск адреса на карте и адрес по точке — OpenStreetMap Nominatim, ищем только в районе Сочи.
// Результаты кэшируем в хранилище на 30 дней: Nominatim просит не чаще 1 запроса в секунду.
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');

const VIEWBOX = '38.9,44.2,40.6,43.2'; // запад,север,восток,юг
const UA = 'SeafoodSochiShop/1.0 (delivery zones)';
const TTL = 30 * 24 * 3600;
let last = 0;

async function call(url) {
  const wait = last + 1100 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  last = Date.now();
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ru' }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error('geocode ' + r.status);
  return r.json();
}

// Короткая подпись адреса: улица, дом, район
function label(a, fallback) {
  if (!a) return fallback || '';
  const street = [a.road || a.pedestrian || a.footway, a.house_number].filter(Boolean).join(', ');
  const area = a.suburb || a.city_district || a.village || a.town || a.city || '';
  return [street, area].filter(Boolean).join(', ') || fallback || '';
}

async function search(q) {
  q = String(q || '').trim().slice(0, 200);
  if (!config.geocode || q.length < 4) return null;
  const key = 'geo:q:' + crypto.createHash('sha1').update(q.toLowerCase()).digest('hex').slice(0, 20);
  const hit = await db.get(key);
  if (hit) return hit.found ? hit : null;
  let res = null;
  try {
    const query = /сочи|адлер|хоста|лоо|дагомыс|поляна|сириус/i.test(q) ? q : q + ', Сочи';
    const list = await call(`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1&bounded=1&viewbox=${VIEWBOX}&q=${encodeURIComponent(query)}`);
    if (list && list[0]) res = { found: true, lat: +list[0].lat, lon: +list[0].lon, label: label(list[0].address, list[0].display_name) };
  } catch (e) { console.warn('[geocode]', e.message); return null; }
  await db.set(key, res || { found: false }, { ex: TTL }).catch(() => {});
  return res;
}

async function reverse(lat, lon) {
  if (!config.geocode) return null;
  lat = Math.round(+lat * 1e4) / 1e4; lon = Math.round(+lon * 1e4) / 1e4;
  const key = `geo:r:${lat}:${lon}`;
  const hit = await db.get(key);
  if (hit) return hit;
  try {
    const r = await call(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=${lat}&lon=${lon}`);
    const res = { lat, lon, label: label(r && r.address, r && r.display_name) };
    await db.set(key, res, { ex: TTL }).catch(() => {});
    return res;
  } catch (e) { console.warn('[geocode]', e.message); return null; }
}

module.exports = { search, reverse, label };
