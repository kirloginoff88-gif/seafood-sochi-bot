// HTTP-обработчик: мини-приложение, админ-панель, фото, API, вебхуки Telegram и MAX.
// Один и тот же обработчик работает на обычном сервере (start) и на Vercel (api/index.js).
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const catalog = require('./catalog');
const store = require('./store');
const orders = require('./orders');
const hub = require('./hub');
const admin = require('./admin');
const media = require('./media');
const db = require('./db');
const loyalty = require('./loyalty');
const P = require('./shared/pricing');
const { validate } = require('./initdata');
const { json, readBody, clientIp, limiter } = require('./web');

// Статика читается явными путями — так её находит сборщик Vercel
const STATIC = {
  'index.html': ['text/html; charset=utf-8', () => fs.readFileSync(path.join(__dirname, '..', 'webapp', 'index.html'))],
  'admin.html': ['text/html; charset=utf-8', () => fs.readFileSync(path.join(__dirname, '..', 'webapp', 'admin.html'))],
  'pricing.js': ['text/javascript; charset=utf-8', () => fs.readFileSync(path.join(__dirname, 'shared', 'pricing.js'))],
  'zones.js': ['text/javascript; charset=utf-8', () => fs.readFileSync(path.join(__dirname, 'shared', 'zones.js'))],
  'leaflet.js': ['text/javascript; charset=utf-8', () => fs.readFileSync(path.join(__dirname, '..', 'webapp', 'vendor', 'leaflet.js'))],
  'leaflet.css': ['text/css; charset=utf-8', () => fs.readFileSync(path.join(__dirname, '..', 'webapp', 'vendor', 'leaflet.css'))],
  'avatar.jpg': ['image/jpeg', () => fs.readFileSync(path.join(__dirname, '..', 'webapp', 'assets', 'avatar.jpg'))],
  'welcome.jpg': ['image/jpeg', () => fs.readFileSync(path.join(__dirname, '..', 'webapp', 'assets', 'welcome.jpg'))],
};
const cache = {};
function sendStatic(res, name, cacheControl = 'no-cache') {
  const [type, load] = STATIC[name];
  cache[name] ||= load();
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cacheControl, 'X-Content-Type-Options': 'nosniff' });
  res.end(cache[name]);
}

// Кто открыл приложение: проверяем подпись initData токеном нужной платформы
function auth(body) {
  const platform = body.platform === 'max' ? 'max' : body.platform === 'tg' ? 'tg' : 'web';
  if (platform === 'web') return { platform, user: null, verified: false };
  const token = platform === 'tg' ? config.telegram.token : config.max.token;
  const data = validate(body.initData, token);
  if (!data || !data.user || !data.user.id) return null;
  return { platform, user: { id: String(data.user.id), name: [data.user.first_name, data.user.last_name].filter(Boolean).join(' '), username: data.user.username || '' }, verified: true, startParam: data.startParam || '' };
}

// Не больше 15 заказов в час с одного IP
const limited = limiter(15, 3600e3);
const geoLimited = limiter(40, 600e3);

function publicCatalog() {
  const c = catalog.get();
  const s = c.settings;
  return {
    cats: c.cats.filter(x => x.count > 0).map(({ cid, name, emoji, image, count }) => ({ cid, name, emoji, image, count })),
    products: c.products.filter(p => !p.out).map(p => ({ id: p.id, cid: p.cid, name: p.name, fullName: catalog.fullName(p), note: p.note, price: p.price, unit: p.unit, piece_g: p.piece_g, min_g: p.min_g, sale_price: p.sale_price, sale_from: p.sale_from, sale_to: p.sale_to, image: p.image, thumb: p.thumb })),
    settings: { brand: s.brand, phone_tel: s.phone_tel, phone_wa: s.phone_wa, hours: s.hours, delivery: s.delivery, payment: s.payment, price_date: s.price_date, min_order: +s.min_order || 0 },
    promos: catalog.livePromos().map(x => ({ id: x.id, title: x.title, text: x.text, badge: x.badge, image: x.image, btn: x.btn, link_type: x.link_type, link_id: x.link_id, color: x.color, to: x.to, popup: x.popup })),
    bonus: loyalty.cfg(),
    zones: (c.zones || []).filter(z => z.active !== 0).map(({ id, name, color, price, free_from, min_order, eta, polygon }) => ({ id, name, color, price, free_from, min_order, eta, polygon })),
    zoneStrict: s.zone_strict === '1',
    timeSlots: config.timeSlots,
    payments: config.payments,
  };
}

function cleanCart(raw) {
  const c = catalog.get(), out = {};
  for (const [id, q] of Object.entries(raw || {})) {
    const p = c.byId[id];
    if (!p || p.out || P.isAsk(p)) continue;
    const n = P.normQty(p, q);
    if (n) out[id] = n;
  }
  return out;
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // Главная страница — сразу магазин: эту ссылку можно отправлять покупателям
  if (req.method === 'GET' && (p === '/' || p === '/shop')) {
    res.writeHead(302, { Location: '/app/' + url.search, 'Cache-Control': 'no-cache' });
    return res.end();
  }

  if (req.method === 'GET' && p === '/health') {
    await catalog.sync();
    return json(res, 200, { ok: true, products: catalog.get().products.length, storage: db.kind, admin: !!config.admin.password });
  }

  // --- вебхуки: обрабатываем полностью до ответа ---
  if (req.method === 'POST' && (p === '/webhook/tg' || p === '/webhook/max')) {
    const body = await readBody(req, 1024 * 1024).catch(() => null);
    const a = hub.adapters[p.endsWith('tg') ? 'tg' : 'max'];
    if (!body || !a) return json(res, 403, { ok: false });
    const ok = await a.webhook(req.headers, body);
    if (ok) await require('./reminders').maybeRun(); // напоминания о корзине «заодно», не чаще раза в 10 минут
    return json(res, ok ? 200 : 403, { ok });
  }

  // --- напоминания о брошенных корзинах: внешний планировщик (cron-job.org) или Vercel Cron ---
  if (p === '/cron/reminders') {
    const key = url.searchParams.get('key') || String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (key !== config.cronSecret) return json(res, 403, { ok: false });
    await catalog.sync();
    return json(res, 200, { ok: true, ...(await require('./reminders').run()) });
  }

  // --- фото товаров ---
  if (req.method === 'GET' && p.startsWith('/media/')) {
    const buf = await media.read(p);
    if (!buf) return json(res, 404, { ok: false });
    const type = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[media.sniff(buf)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, s-maxage=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
    return res.end(buf);
  }

  // --- общая статика: карта, фирменные картинки ---
  if (req.method === 'GET' && p.startsWith('/static/')) {
    const name = p.slice(8);
    if (STATIC[name] && !name.endsWith('.html')) return sendStatic(res, name, 'public, max-age=86400');
    return json(res, 404, { ok: false });
  }
  // --- плитки карты: отдаём через свой адрес и кэшируем (так карта открывается и там, где внешние сервисы недоступны) ---
  if (req.method === 'GET' && p.startsWith('/tiles/')) return require('./tiles').serve(req, res, p);

  // --- статика мини-приложения ---
  if (req.method === 'GET' && (p === '/app' || p.startsWith('/app/'))) {
    if (p === '/app') { res.writeHead(302, { Location: '/app/' + url.search }); return res.end(); }
    const rel = p.slice(5) || 'index.html';
    if (rel === 'index.html') return sendStatic(res, 'index.html');
    if (rel === 'pricing.js') return sendStatic(res, 'pricing.js', 'public, max-age=300');
    return json(res, 404, { ok: false });
  }

  await catalog.sync();

  // --- админ-панель ---
  if (p === '/admin' || p === '/admin/') {
    if (req.method === 'GET') return sendStatic(res, 'admin.html');
  }
  if (p.startsWith('/admin/api/')) {
    if (await admin.handle(req, res, url)) return;
  }

  // --- API мини-приложения ---
  if (req.method === 'GET' && p === '/api/catalog') {
    const tg = hub.adapters.tg ? await loyalty.botName('tg') : '';
    return json(res, 200, { ...publicCatalog(), bots: { tg: tg ? `https://t.me/${tg}` : '' } });
  }

  // Поиск адреса на карте и адрес по точке
  if (req.method === 'GET' && p === '/api/geocode') {
    if (geoLimited(clientIp(req))) return json(res, 429, { ok: false, error: 'Слишком много запросов, попробуйте через минуту' });
    const geo = require('./geocode');
    const lat = url.searchParams.get('lat'), lon = url.searchParams.get('lon');
    const r = lat && lon ? await geo.reverse(lat, lon) : await geo.search(url.searchParams.get('q'));
    return json(res, 200, r ? { ok: true, ...r } : { ok: false });
  }

  if (req.method === 'POST' && p === '/api/session') {
    const body = await readBody(req).catch(() => ({}));
    const who = auth(body);
    if (!who) return json(res, 401, { ok: false, error: 'Откройте магазин из бота заново' });
    if (who.platform === 'web') return json(res, 200, { ok: true, platform: 'web', cart: {}, profile: {} });
    const u = await store.getUser(who.platform, who.user.id);
    u.name = u.name || who.user.name; u.username = who.user.username;
    // Открыли приложение по ссылке друга (startapp=ref_КОД)
    let gift = null;
    if (/^ref_[A-Za-z0-9]{4,12}$/.test(who.startParam)) gift = await loyalty.applyReferral(who.platform, who.user.id, who.startParam, { hasOrders: u.orderIds.length > 0 });
    await store.saveUser(u);
    const account = await loyalty.account(who.platform, who.user.id, u);
    const manager = await admin.isAppManager(who.platform, who.user.id);
    return json(res, 200, { ok: true, platform: who.platform, user: who.user, cart: cleanCart(u.cart), profile: { name: u.profile.name || who.user.name, phone: u.profile.phone || '', address: u.profile.address || '' }, account, gift, manager });
  }

  if (req.method === 'POST' && p === '/api/account') {
    const body = await readBody(req).catch(() => ({}));
    const who = auth(body);
    if (!who || who.platform === 'web') return json(res, 401, { ok: false });
    const u = await store.getUser(who.platform, who.user.id);
    return json(res, 200, { ok: true, account: await loyalty.account(who.platform, who.user.id, u) });
  }

  if (req.method === 'PUT' && p === '/api/cart') {
    const body = await readBody(req).catch(() => ({}));
    const who = auth(body);
    if (!who) return json(res, 401, { ok: false });
    if (who.platform === 'web') return json(res, 200, { ok: true });
    const u = await store.getUser(who.platform, who.user.id);
    const before = JSON.stringify(u.cart);
    u.cart = cleanCart(body.cart); u.pick = {};
    if (JSON.stringify(u.cart) !== before) await require('./reminders').touch(u);
    await store.saveUser(u);
    return json(res, 200, { ok: true, cart: u.cart });
  }

  if (req.method === 'POST' && p === '/api/order') {
    if (limited(clientIp(req))) return json(res, 429, { ok: false, errors: ['Слишком много заказов подряд. Позвоните нам, пожалуйста.'] });
    const body = await readBody(req).catch(() => null);
    if (!body) return json(res, 400, { ok: false, errors: ['Некорректный запрос'] });
    const who = auth(body);
    if (!who) return json(res, 401, { ok: false, errors: ['Сессия устарела. Закройте и снова откройте магазин из бота.'] });
    if (who.platform === 'web' && !config.allowWebOrders) return json(res, 403, { ok: false, errors: ['Оформление доступно только в Telegram или MAX'] });
    const f = body.order || {};
    const u = who.user ? await store.getUser(who.platform, who.user.id) : null;
    const r = await orders.create({
      user: u, platform: who.platform, userId: who.user?.id, chatId: u?.chatId, username: who.user?.username,
      source: who.platform === 'web' ? 'web' : 'app', verified: who.verified,
      cart: cleanCart(body.cart), name: f.name, phone: f.phone, address: f.address, time: f.time, pay: f.pay, comment: f.comment,
      useBonus: !!f.useBonus, geo: f.geo,
    });
    if (u) await store.saveUser(u);
    if (!r.ok) return json(res, 422, r);
    // Дублируем подтверждение в чат с ботом — там же покупатель увидит статусы
    if (who.platform !== 'web') await hub.send(who.platform, u?.chatId ? { chatId: u.chatId } : { userId: who.user.id }, { text: orders.customerText(r.order), buttons: [[{ text: '📦 Мои заказы', cb: 'my' }]] });
    return json(res, 200, { ok: true, id: r.order.id, sum: r.order.sum, bonusUsed: r.order.bonusUsed || 0, toPay: r.order.toPay, delivery: r.order.delivery || null });
  }

  json(res, 404, { ok: false });
}

// Обработчик с перехватом ошибок — для Vercel и для обычного сервера
async function handle(req, res) {
  try { await route(req, res); }
  catch (e) { console.error('[http]', e); if (!res.headersSent) json(res, 500, { ok: false, errors: ['Ошибка сервера'] }); }
}

function start() {
  const srv = http.createServer(handle);
  return new Promise(r => srv.listen(config.port, () => { console.log(`[http] слушаю :${config.port}`); r(srv); }));
}

// Экспорт по умолчанию — сам обработчик: так файл годится и как точка входа Vercel
require('./setup');
module.exports = handle;
Object.assign(module.exports, { start, route, handle, publicCatalog });
