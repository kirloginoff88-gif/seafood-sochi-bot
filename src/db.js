/*
 * Хранилище «ключ → значение» с двумя вариантами:
 *  - redis: Upstash Redis по REST (для Vercel и любого serverless). Включается, если заданы
 *           KV_REST_API_URL/KV_REST_API_TOKEN (так их называет интеграция Vercel) или
 *           UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN;
 *  - file:  один JSON-файл storage/data.json (для обычного сервера/VPS).
 * Значения — JSON. Все методы асинхронные.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

const REDIS_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const kind = REDIS_URL && REDIS_TOKEN ? 'redis' : 'file';
const _fetch = globalThis.fetch; // запоминаем настоящий fetch: тесты подменяют глобальный

// ---------- Redis (Upstash REST) ----------
async function cmd(...args) {
  const res = await _fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args.map(String)),
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json().catch(() => ({ error: 'HTTP ' + res.status }));
  if (json.error) throw new Error(`redis ${args[0]}: ${json.error}`);
  return json.result;
}
const parse = v => { if (v === null || v === undefined) return null; try { return JSON.parse(v); } catch { return null; } };

const redis = {
  kind: 'redis',
  async get(key) { return parse(await cmd('GET', key)); },
  async set(key, value, { nx, ex } = {}) {
    const args = ['SET', key, JSON.stringify(value)];
    if (ex) args.push('EX', ex);
    if (nx) args.push('NX');
    return (await cmd(...args)) === 'OK';
  },
  async del(...keys) { if (keys.length) await cmd('DEL', ...keys); },
  async incr(key) { return +(await cmd('INCR', key)); },
  async lpush(key, value) { await cmd('LPUSH', key, JSON.stringify(value)); },
  async lrange(key, start, stop) { return (await cmd('LRANGE', key, start, stop)).map(parse); },
  async mget(keys) { return keys.length ? (await cmd('MGET', ...keys)).map(parse) : []; },
  async ping() { return (await cmd('PING')) === 'PONG'; },
};

// ---------- файл ----------
const dataFile = () => path.join(config.dataDir, 'data.json');
let mem = null, timer = null;
function load() {
  if (mem) return mem;
  try { mem = JSON.parse(fs.readFileSync(dataFile(), 'utf8')); } catch { mem = {}; }
  mem.kv ||= {}; mem.lists ||= {};
  return mem;
}
function write() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = dataFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(mem));
  fs.renameSync(tmp, dataFile());
}
function save() { if (!timer) timer = setTimeout(() => { timer = null; write(); }, 200); }
const clone = v => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));

const file = {
  kind: 'file',
  async get(key) { return clone(load().kv[key]); },
  async set(key, value, { nx } = {}) {
    const m = load();
    if (nx && key in m.kv) return false;
    m.kv[key] = clone(value); save(); return true;
  },
  async del(...keys) { const m = load(); keys.forEach(k => { delete m.kv[k]; delete m.lists[k]; }); save(); },
  async incr(key) { const m = load(); m.kv[key] = (+m.kv[key] || 0) + 1; save(); return m.kv[key]; },
  async lpush(key, value) { const m = load(); (m.lists[key] ||= []).unshift(clone(value)); save(); },
  async lrange(key, start, stop) { const l = load().lists[key] || []; return clone(l.slice(start, stop < 0 ? l.length + stop + 1 : stop + 1)) || []; },
  async mget(keys) { const m = load(); return keys.map(k => clone(m.kv[k])); },
  async ping() { return true; },
  flush() { if (mem) { clearTimeout(timer); timer = null; write(); } },
};

module.exports = kind === 'redis' ? redis : file;
module.exports.flush = kind === 'redis' ? () => {} : file.flush;
