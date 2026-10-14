// Админ-панель: вход по паролю и API для каталога, настроек и заказов.
const crypto = require('crypto');
const path = require('path');
const config = require('./config');
const catalog = require('./catalog');
const store = require('./store');
const orders = require('./orders');
const media = require('./media');
const { json, readBody, sendFile, clientIp, limiter } = require('./web');

const COOKIE = 'sf_admin';
const TTL = 30 * 24 * 3600 * 1000;
const loginLimit = limiter(10, 15 * 60 * 1000);

function sign(exp) { return crypto.createHmac('sha256', config.admin.secret).update(String(exp)).digest('hex'); }
function token() { const exp = Date.now() + TTL; return `${exp}.${sign(exp)}`; }
function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(x => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
function authed(req) {
  if (!config.admin.password) return false;
  const [exp, sig] = String(cookies(req)[COOKIE] || '').split('.');
  if (!exp || !sig || +exp < Date.now()) return false;
  const a = Buffer.from(sign(exp)), b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cookieHeader(value, maxAgeSec) {
  const secure = /^https:/.test(config.publicUrl) ? '; Secure' : '';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
}
// Запросы, меняющие данные, принимаем только со своей страницы
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // не браузерный запрос или тот же сайт без Origin
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

const STATUSES = Object.keys(orders.STATUS);

function adminState() {
  const c = catalog.get();
  return {
    cats: c.cats.map(({ cid, name, emoji, image, count, total, sort }) => ({ cid, name, emoji, image, count, total, sort })),
    products: c.products.map(({ thumb, imageAbs, ...p }) => ({ ...p, thumb })),
    settings: c.settings,
  };
}

function orderList(filter) {
  const all = Object.values(store._db().orders).sort((a, b) => b.id - a.id);
  const list = filter === 'all' ? all : all.filter(o => !['done', 'canceled'].includes(o.status));
  return list.slice(0, 200).map(o => ({
    id: o.id, status: o.status, createdAt: o.createdAt, platform: o.platform, source: o.source, verified: o.verified,
    customer: o.customer, address: o.address, time: o.time, pay: o.pay, comment: o.comment,
    lines: o.lines.map(l => ({ name: l.name, qtyLabel: l.qtyLabel, sum: l.sum, approx: l.approx, ask: l.ask })),
    sum: o.sum, finalSum: o.finalSum || null,
  }));
}

// Возвращает true, если запрос обработан
async function handle(req, res, url) {
  const p = url.pathname;
  if (p === '/admin' || p === '/admin/') {
    if (req.method !== 'GET') return false;
    sendFile(res, path.join(config.root, 'webapp', 'admin.html'), 'no-cache');
    return true;
  }
  if (!p.startsWith('/admin/api/')) return false;
  const action = p.slice('/admin/api/'.length);

  if (!config.admin.password) { json(res, 503, { ok: false, error: 'Админ-панель выключена: задайте ADMIN_PASSWORD в .env' }); return true; }
  if (req.method !== 'GET' && !sameOrigin(req)) { json(res, 403, { ok: false, error: 'Запрос с чужого сайта' }); return true; }

  if (action === 'login' && req.method === 'POST') {
    if (loginLimit(clientIp(req))) { json(res, 429, { ok: false, error: 'Слишком много попыток. Подождите 15 минут.' }); return true; }
    const body = await readBody(req).catch(() => ({}));
    const a = crypto.createHash('sha256').update(String(body.password || '')).digest();
    const b = crypto.createHash('sha256').update(config.admin.password).digest();
    if (!crypto.timingSafeEqual(a, b)) { json(res, 401, { ok: false, error: 'Неверный пароль' }); return true; }
    json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(token(), TTL / 1000) });
    return true;
  }
  if (action === 'logout') { json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0) }); return true; }
  if (!authed(req)) { json(res, 401, { ok: false, error: 'Нужно войти' }); return true; }

  try {
    if (req.method === 'GET' && action === 'state') return json(res, 200, { ok: true, ...adminState() }), true;
    if (req.method === 'GET' && action === 'orders') return json(res, 200, { ok: true, orders: orderList(url.searchParams.get('filter')), statuses: orders.STATUS }), true;
    if (req.method !== 'POST') return json(res, 405, { ok: false }), true;

    const body = await readBody(req, action === 'upload' ? 12 * 1024 * 1024 : 200 * 1024).catch(() => null);
    if (!body) return json(res, 400, { ok: false, error: 'Слишком большой или некорректный запрос' }), true;

    switch (action) {
      case 'product/save': { const product = catalog.saveProduct(body.product || {}); return json(res, 200, { ok: true, product, ...adminState() }), true; }
      case 'product/quick': { catalog.quickProduct(body.id, { price: body.price, out: body.out }); return json(res, 200, { ok: true, ...adminState() }), true; }
      case 'product/delete': catalog.deleteProduct(body.id); return json(res, 200, { ok: true, ...adminState() }), true;
      case 'product/move': catalog.moveProduct(body.id, body.dir); return json(res, 200, { ok: true, ...adminState() }), true;
      case 'category/save': catalog.saveCategory(body.category || {}); return json(res, 200, { ok: true, ...adminState() }), true;
      case 'category/delete': catalog.deleteCategory(body.cid); return json(res, 200, { ok: true, ...adminState() }), true;
      case 'category/move': catalog.moveCategory(body.cid, body.dir); return json(res, 200, { ok: true, ...adminState() }), true;
      case 'settings/save': catalog.saveSettings(body.settings || {}); return json(res, 200, { ok: true, ...adminState() }), true;
      case 'upload': {
        const full = media.fromDataUrl(body.full);
        if (!full) return json(res, 400, { ok: false, error: 'Не удалось прочитать фото' }), true;
        const image = media.saveImage(full, media.fromDataUrl(body.thumb));
        return json(res, 200, { ok: true, image, thumb: catalog.thumbOf(image) }), true;
      }
      case 'order/status': {
        if (!STATUSES.includes(body.status)) return json(res, 400, { ok: false, error: 'Неизвестный статус' }), true;
        const o = await orders.setStatus(+body.id, body.status, 'админ-панель');
        if (!o) return json(res, 404, { ok: false, error: 'Заказ не найден' }), true;
        await orders.refreshManagerCards(o);
        return json(res, 200, { ok: true }), true;
      }
      case 'order/sum': {
        const sum = Math.round(+body.sum || 0);
        if (sum <= 0) return json(res, 400, { ok: false, error: 'Введите сумму' }), true;
        const o = await orders.setFinalSum(+body.id, sum, 'админ-панель');
        if (!o) return json(res, 404, { ok: false, error: 'Заказ не найден' }), true;
        await orders.refreshManagerCards(o);
        return json(res, 200, { ok: true }), true;
      }
    }
    json(res, 404, { ok: false, error: 'Неизвестное действие' });
  } catch (e) {
    if (e instanceof catalog.InputError || /^(Поддерживаются|Фото)/.test(e.message)) json(res, 422, { ok: false, error: e.message });
    else { console.error('[admin]', e); json(res, 500, { ok: false, error: 'Ошибка сервера' }); }
  }
  return true;
}

module.exports = { handle, authed };
