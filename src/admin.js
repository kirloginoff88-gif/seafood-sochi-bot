// Админ-панель: вход по паролю и API для каталога, настроек и заказов.
const crypto = require('crypto');
const config = require('./config');
const catalog = require('./catalog');
const store = require('./store');
const orders = require('./orders');
const media = require('./media');
const { json, readBody, clientIp, limiter } = require('./web');
const hub = require('./hub');
const db = require('./db');
const loyalty = require('./loyalty');

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

// Менеджер ли этот покупатель: в личке Telegram чат = пользователь, в MAX ищем чат в карточке покупателя
async function isAppManager(platform, userId) {
  const u = await store.getUser(platform, userId);
  return (await store.isManager(platform, u.chatId || userId)) || (await store.isManager(platform, userId));
}

function adminState() {
  const c = catalog.get();
  return {
    cats: c.cats.map(({ cid, name, emoji, image, count, total, sort }) => ({ cid, name, emoji, image, count, total, sort })),
    products: c.products.map(({ thumb, imageAbs, ...p }) => ({ ...p, thumb })),
    settings: c.settings,
    promos: c.promos.map(({ imageAbs, ...x }) => x),
    zones: c.zones,
    defaults: { ...require('./branding').DEFAULTS, remind_text: require('./reminders').DEFAULT_TEXT },
  };
}

// Покупатели из мессенджеров: заказы, бонусы, приглашения
async function customerList() {
  const rows = await store.listUsers(1000);
  return rows.map(({ u, l }) => ({
    key: `${u.platform}:${u.userId}`, platform: u.platform, userId: u.userId,
    name: u.profile.name || u.name || '', username: u.username || '', phone: u.profile.phone || '',
    orders: (u.orderIds || []).length, lastOrder: (u.orderIds || [])[0] || null, createdAt: u.createdAt || null,
    balance: l.balance || 0, refCount: l.refCount || 0, referred: !!l.referredBy, refCode: l.refCode || '',
  }));
}

async function orderList(filter) {
  const all = await store.listOrders(200);
  const list = filter === 'all' ? all : all.filter(o => !['done', 'canceled'].includes(o.status));
  return list.slice(0, 200).map(o => ({
    id: o.id, status: o.status, createdAt: o.createdAt, platform: o.platform, source: o.source, verified: o.verified,
    customer: o.customer, address: o.address, time: o.time, pay: o.pay, comment: o.comment,
    lines: o.lines.map(l => ({ name: l.name, qtyLabel: l.qtyLabel, sum: l.sum, approx: l.approx, ask: l.ask })),
    sum: o.sum, finalSum: o.finalSum || null, bonusUsed: o.bonusUsed || 0, bonusEarned: o.bonusEarned || 0,
  }));
}

// Состояние подключения ботов — для блока «Подключение» в настройках
async function botsStatus() {
  const external = catalog.get().products.filter(p => /^https?:\/\//.test(p.image || '')).length;
  const out = { cronUrl: config.publicUrl ? `${config.publicUrl}/cron/reminders?key=${config.cronSecret}` : '', brand: await db.get('brand:applied'), avatar: await db.get('brand:avatar'), publicUrl: config.publicUrl, storage: db.kind, serverless: config.serverless, externalImages: external, tg: { enabled: false }, max: { enabled: false } };
  for (const pl of ['tg', 'max']) {
    if (!hub.adapters[pl]) continue;
    try { out[pl] = await hub.adapters[pl].status(); } catch (e) { out[pl] = { enabled: true, error: e.message }; }
  }
  return out;
}

// Возвращает true, если запрос обработан
async function handle(req, res, url) {
  const p = url.pathname;
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
  // Вход из мини-приложения: менеджер (подключённый командой /manager) входит без пароля — по подписи мессенджера
  if (action === 'login-app' && req.method === 'POST') {
    if (loginLimit(clientIp(req))) { json(res, 429, { ok: false, error: 'Слишком много попыток. Подождите 15 минут.' }); return true; }
    const body = await readBody(req).catch(() => ({}));
    const platform = body.platform === 'max' ? 'max' : body.platform === 'tg' ? 'tg' : null;
    const data = platform && require('./initdata').validate(body.initData, platform === 'tg' ? config.telegram.token : config.max.token);
    if (!data || !data.user || !data.user.id) { json(res, 401, { ok: false, error: 'Откройте приложение из бота заново' }); return true; }
    if (!(await isAppManager(platform, String(data.user.id)))) { json(res, 403, { ok: false, error: 'Вход только для менеджеров. Подключитесь в боте командой /manager КОД' }); return true; }
    json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(token(), TTL / 1000) });
    return true;
  }
  if (action === 'logout') { json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0) }); return true; }
  if (!authed(req)) { json(res, 401, { ok: false, error: 'Нужно войти' }); return true; }

  try {
    if (req.method === 'GET' && action === 'state') return json(res, 200, { ok: true, ...adminState() }), true;
    if (req.method === 'GET' && action === 'orders') return json(res, 200, { ok: true, orders: await orderList(url.searchParams.get('filter')), statuses: orders.STATUS }), true;
    if (req.method === 'GET' && action === 'customers') return json(res, 200, { ok: true, customers: await customerList() }), true;
    if (req.method === 'GET' && action === 'customer') {
      const [pl, id] = String(url.searchParams.get('key') || '').split(':');
      if (!['tg', 'max'].includes(pl) || !id) return json(res, 400, { ok: false, error: 'Неизвестный покупатель' }), true;
      const d = await loyalty.get(pl, id);
      return json(res, 200, { ok: true, history: d.history }), true;
    }
    if (req.method === 'GET' && action === 'bots') return json(res, 200, { ok: true, ...(await botsStatus()) }), true;
    if (req.method !== 'POST') return json(res, 405, { ok: false }), true;

    const body = await readBody(req, action === 'upload' ? 12 * 1024 * 1024 : 200 * 1024).catch(() => null);
    if (!body) return json(res, 400, { ok: false, error: 'Слишком большой или некорректный запрос' }), true;

    switch (action) {
      case 'product/save': { const product = await catalog.saveProduct(body.product || {}); return json(res, 200, { ok: true, product, ...adminState() }), true; }
      case 'product/quick': { await catalog.quickProduct(body.id, { price: body.price, out: body.out }); return json(res, 200, { ok: true, ...adminState() }), true; }
      case 'product/delete': await catalog.deleteProduct(body.id); return json(res, 200, { ok: true, ...adminState() }), true;
      case 'product/move': await catalog.moveProduct(body.id, body.dir); return json(res, 200, { ok: true, ...adminState() }), true;
      case 'category/save': await catalog.saveCategory(body.category || {}); return json(res, 200, { ok: true, ...adminState() }), true;
      case 'category/delete': await catalog.deleteCategory(body.cid); return json(res, 200, { ok: true, ...adminState() }), true;
      case 'category/move': await catalog.moveCategory(body.cid, body.dir); return json(res, 200, { ok: true, ...adminState() }), true;
      case 'promo/save': { const promo = await catalog.savePromo(body.promo || {}); return json(res, 200, { ok: true, promo, ...adminState() }), true; }
      case 'promo/delete': await catalog.deletePromo(body.id); return json(res, 200, { ok: true, ...adminState() }), true;
      case 'promo/move': await catalog.movePromo(body.id, body.dir); return json(res, 200, { ok: true, ...adminState() }), true;
      case 'customer/bonus': {
        const [pl, id] = String(body.key || '').split(':');
        const amount = Math.round(+body.amount || 0);
        if (!['tg', 'max'].includes(pl) || !id || !(await db.get(`user:${pl}:${id}`))) return json(res, 404, { ok: false, error: 'Покупатель не найден' }), true;
        if (!amount || Math.abs(amount) > 1_000_000) return json(res, 400, { ok: false, error: 'Введите количество бонусов, например 200 или -200' }), true;
        const reason = String(body.reason || '').trim().slice(0, 120) || (amount > 0 ? 'Начислено магазином' : 'Списано магазином');
        const d = await loyalty.credit(pl, id, amount, reason);
        if (body.notify !== false) await hub.send(pl, { userId: id }, { text: amount > 0 ? `🎁 Вам начислено <b>${amount} бонусов</b>: ${orders.esc(reason)}.\nНа счёте: <b>${d.balance}</b>.` : `💎 Списано ${-amount} бонусов: ${orders.esc(reason)}. На счёте: <b>${d.balance}</b>.` });
        return json(res, 200, { ok: true, balance: d.balance, customers: await customerList() }), true;
      }
      case 'zone/save': { const zone = await catalog.saveZone(body.zone || {}); return json(res, 200, { ok: true, zone, ...adminState() }), true; }
      case 'zone/delete': await catalog.deleteZone(body.id); return json(res, 200, { ok: true, ...adminState() }), true;
      case 'zone/move': await catalog.moveZone(body.id, body.dir); return json(res, 200, { ok: true, ...adminState() }), true;
      case 'bot/brand': {
        if (body.avatar !== undefined) {
          if (body.avatar && !/^\/media\/[a-z0-9_-]+\.(jpg|png|webp)$/.test(body.avatar)) return json(res, 400, { ok: false, error: 'Некорректный аватар' }), true;
          if (body.avatar) await db.set('brand:avatar', body.avatar); else await db.del('brand:avatar');
        }
        const result = await require('./branding').apply({ photo: !!body.photo });
        return json(res, 200, { ok: true, result, ...(await botsStatus()) }), true;
      }
      case 'reminders/run': return json(res, 200, { ok: true, ...(await require('./reminders').run({ force: !!body.force })) }), true;
      case 'settings/save': await catalog.saveSettings(body.settings || {}); return json(res, 200, { ok: true, ...adminState() }), true;
      case 'upload': {
        const full = media.fromDataUrl(body.full);
        if (!full) return json(res, 400, { ok: false, error: 'Не удалось прочитать фото' }), true;
        const image = await media.saveImage(full, media.fromDataUrl(body.thumb));
        return json(res, 200, { ok: true, image, thumb: catalog.thumbOf(image) }), true;
      }
      case 'bots/connect': {
        const out = {};
        for (const pl of ['tg', 'max']) {
          if (!hub.adapters[pl]) continue;
          try { await hub.adapters[pl].connect(); } catch (e) { out[pl] = e.message; }
        }
        // Заодно оформляем бота: тексты всегда, аватар — только в первый раз
        const applied = await db.get('brand:applied');
        await require('./branding').apply({ photo: !applied || !applied.photo }).catch(e => console.warn('[brand]', e.message));
        return json(res, 200, { ok: true, errors: out, ...(await botsStatus()) }), true;
      }
      case 'images/import': {
        const { importImages } = require('../scripts/import-images');
        const errors = [];
        const r = await importImages({ log: m => errors.push(m), budgetMs: 40000 });
        return json(res, 200, { ok: true, ...r, errors: errors.slice(0, 10), ...adminState() }), true;
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

module.exports = { handle, authed, isAppManager };
