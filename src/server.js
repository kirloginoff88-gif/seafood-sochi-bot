// HTTP-сервер: мини-приложение, админ-панель, фото, API, вебхуки Telegram и MAX.
const http = require('http');
const path = require('path');
const config = require('./config');
const catalog = require('./catalog');
const store = require('./store');
const orders = require('./orders');
const hub = require('./hub');
const admin = require('./admin');
const media = require('./media');
const P = require('./shared/pricing');
const { validate } = require('./initdata');
const { json, readBody, sendFile, clientIp, limiter } = require('./web');

const WEB = path.join(config.root, 'webapp');

// Кто открыл приложение: проверяем подпись initData токеном нужной платформы
function auth(body) {
  const platform = body.platform === 'max' ? 'max' : body.platform === 'tg' ? 'tg' : 'web';
  if (platform === 'web') return { platform, user: null, verified: false };
  const token = platform === 'tg' ? config.telegram.token : config.max.token;
  const data = validate(body.initData, token);
  if (!data || !data.user || !data.user.id) return null;
  return { platform, user: { id: String(data.user.id), name: [data.user.first_name, data.user.last_name].filter(Boolean).join(' '), username: data.user.username || '' }, verified: true };
}

// Не больше 15 заказов в час с одного IP
const limited = limiter(15, 3600e3);

function publicCatalog() {
  const c = catalog.get();
  const s = c.settings;
  return {
    cats: c.cats.filter(x => x.count > 0).map(({ cid, name, emoji, image, count }) => ({ cid, name, emoji, image, count })),
    products: c.products.filter(p => !p.out).map(p => ({ id: p.id, cid: p.cid, name: p.name, fullName: catalog.fullName(p), note: p.note, price: p.price, unit: p.unit, piece_g: p.piece_g, min_g: p.min_g, sale_price: p.sale_price, sale_from: p.sale_from, sale_to: p.sale_to, image: p.image, thumb: p.thumb })),
    settings: { brand: s.brand, phone_tel: s.phone_tel, phone_wa: s.phone_wa, hours: s.hours, delivery: s.delivery, payment: s.payment, price_date: s.price_date, min_order: +s.min_order || 0 },
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

  if (req.method === 'GET' && (p === '/' || p === '/health')) return json(res, 200, { ok: true, products: catalog.get().products.length, admin: !!config.admin.password });

  // --- вебхуки ---
  if (req.method === 'POST' && (p === '/webhook/tg' || p === '/webhook/max')) {
    const body = await readBody(req, 1024 * 1024).catch(() => null);
    const a = hub.adapters[p.endsWith('tg') ? 'tg' : 'max'];
    if (!body || !a || !a.webhook(req.headers, body)) return json(res, 403, { ok: false });
    return json(res, 200, { ok: true });
  }

  // --- API мини-приложения ---
  if (req.method === 'GET' && p === '/api/catalog') return json(res, 200, publicCatalog());

  if (req.method === 'POST' && p === '/api/session') {
    const body = await readBody(req).catch(() => ({}));
    const who = auth(body);
    if (!who) return json(res, 401, { ok: false, error: 'Откройте магазин из бота заново' });
    if (who.platform === 'web') return json(res, 200, { ok: true, platform: 'web', cart: {}, profile: {} });
    const u = store.user(who.platform, who.user.id);
    u.name = u.name || who.user.name; u.username = who.user.username;
    store.touch();
    return json(res, 200, { ok: true, platform: who.platform, user: who.user, cart: cleanCart(u.cart), profile: { name: u.profile.name || who.user.name, phone: u.profile.phone || '', address: u.profile.address || '' } });
  }

  if (req.method === 'PUT' && p === '/api/cart') {
    const body = await readBody(req).catch(() => ({}));
    const who = auth(body);
    if (!who) return json(res, 401, { ok: false });
    if (who.platform === 'web') return json(res, 200, { ok: true });
    const u = store.user(who.platform, who.user.id);
    u.cart = cleanCart(body.cart); u.pick = {};
    store.touch();
    return json(res, 200, { ok: true, cart: u.cart });
  }

  if (req.method === 'POST' && p === '/api/order') {
    const ip = clientIp(req);
    if (limited(ip)) return json(res, 429, { ok: false, errors: ['Слишком много заказов подряд. Позвоните нам, пожалуйста.'] });
    const body = await readBody(req).catch(() => null);
    if (!body) return json(res, 400, { ok: false, errors: ['Некорректный запрос'] });
    const who = auth(body);
    if (!who) return json(res, 401, { ok: false, errors: ['Сессия устарела. Закройте и снова откройте магазин из бота.'] });
    if (who.platform === 'web' && !config.allowWebOrders) return json(res, 403, { ok: false, errors: ['Оформление доступно только в Telegram или MAX'] });
    const f = body.order || {};
    const u = who.user ? store.user(who.platform, who.user.id) : null;
    const r = await orders.create({
      platform: who.platform, userId: who.user?.id, chatId: u?.chatId, username: who.user?.username,
      source: who.platform === 'web' ? 'web' : 'app', verified: who.verified,
      cart: cleanCart(body.cart), name: f.name, phone: f.phone, address: f.address, time: f.time, pay: f.pay, comment: f.comment,
    });
    if (!r.ok) return json(res, 422, r);
    // Дублируем подтверждение в чат с ботом — там же покупатель увидит статусы
    if (who.platform !== 'web') hub.send(who.platform, u?.chatId ? { chatId: u.chatId } : { userId: who.user.id }, { text: orders.customerText(r.order), buttons: [[{ text: '📦 Мои заказы', cb: 'my' }]] });
    return json(res, 200, { ok: true, id: r.order.id, sum: r.order.sum });
  }

  // --- админ-панель ---
  if (p === '/admin' || p.startsWith('/admin/')) {
    if (await admin.handle(req, res, url)) return;
  }

  // --- фото товаров ---
  if (req.method === 'GET' && p.startsWith('/media/')) {
    const file = media.filePath(p);
    if (!file) return json(res, 404, { ok: false });
    return sendFile(res, file, 'public, max-age=2592000, immutable');
  }

  // --- статика мини-приложения ---
  if (req.method === 'GET' && (p === '/app' || p.startsWith('/app/'))) {
    if (p === '/app') { res.writeHead(302, { Location: '/app/' + url.search }); return res.end(); }
    const rel = p.slice(5) || 'index.html';
    if (rel === 'pricing.js') return sendFile(res, path.join(config.root, 'src', 'shared', 'pricing.js'), 'public, max-age=300');
    if (!/^[a-z0-9_-]+\.(html|js|css|svg|png|ico)$/i.test(rel) || rel === 'admin.html') return json(res, 404, { ok: false });
    return sendFile(res, path.join(WEB, rel), rel === 'index.html' ? 'no-cache' : 'public, max-age=300');
  }
  json(res, 404, { ok: false });
}

function start() {
  const srv = http.createServer((req, res) => {
    route(req, res).catch(e => { console.error('[http]', e); if (!res.headersSent) json(res, 500, { ok: false, errors: ['Ошибка сервера'] }); });
  });
  return new Promise(r => srv.listen(config.port, () => { console.log(`[http] слушаю :${config.port}`); r(srv); }));
}

module.exports = { start, route, publicCatalog };
