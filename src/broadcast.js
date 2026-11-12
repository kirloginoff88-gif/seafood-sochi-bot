/*
 * Рассылки из админки: по всей базе или по сегменту.
 *
 * Сегмент — набор условий (все должны выполняться):
 *   platform: 'all' | 'tg' | 'max'
 *   kind:     'all' | 'buyers' (был заказ) | 'nobuy' (ни одного заказа) | 'repeat' (2+ заказа)
 *             | 'sleeping' (последний заказ давнее N дней) | 'cart' (товары в корзине без заказа)
 *             | 'bonus' (на счету от N бонусов) | 'new' (открыли бота за последние N дней) | 'referred' (пришли по приглашению)
 *             | 'manual' (выбранные вручную в списке)
 *   days, minBonus, minOrders, keys — параметры условий
 *
 * Отправка идёт порциями (Telegram пропускает ~30 сообщений в секунду): задание хранится в базе,
 * на своём сервере его дорабатывает фоновый цикл, на serverless — запросы статуса из открытой админки.
 * Покупатель может отписаться кнопкой под сообщением; отписавшимся и заблокировавшим бота не пишем.
 */
const config = require('./config');
const db = require('./db');
const store = require('./store');
const catalog = require('./catalog');
const hub = require('./hub');
const P = require('./shared/pricing');

const DAY = 864e5;
const STEP_MS = 45;         // пауза между сообщениями: ~22 в секунду, с запасом до лимита Telegram
const LIST = 'broadcasts';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const KINDS = {
  all: 'Вся база',
  buyers: 'Делали заказ',
  nobuy: 'Ни разу не заказывали',
  repeat: 'Постоянные (от N заказов)',
  sleeping: 'Давно не заказывали (N дней)',
  cart: 'Брошенная корзина',
  bonus: 'Есть бонусы (от N)',
  new: 'Новые (за N дней)',
  referred: 'Пришли по приглашению',
  manual: 'Выбрать вручную',
};

// Покупатели с данными для сегментации
async function audience() {
  const [rows, orders] = await Promise.all([store.listUsers(5000), store.listOrders(5000)]);
  const stat = {};
  for (const o of orders) {
    if (!o.userId || o.status === 'canceled') continue;
    const k = `${o.platform}:${o.userId}`;
    const s = (stat[k] ||= { n: 0, sum: 0, last: 0 });
    s.n++; s.sum += +(o.finalSum || o.sum) || 0; s.last = Math.max(s.last, o.createdAt || 0);
  }
  return rows.filter(({ u }) => u.platform === 'tg' || u.platform === 'max').map(({ u, l }) => {
    const key = `${u.platform}:${u.userId}`, s = stat[key] || { n: 0, sum: 0, last: 0 };
    return {
      key, platform: u.platform, userId: u.userId, chatId: u.chatId || null,
      name: u.profile.name || u.name || '', username: u.username || '',
      orders: Math.max(s.n, (u.orderIds || []).length), spent: Math.round(s.sum), lastOrder: s.last || null,
      createdAt: u.createdAt || null, balance: l.balance || 0, referred: !!l.referredBy,
      cart: Object.keys(u.cart || {}).length, noNews: !!u.noNews, blocked: !!u.blocked,
    };
  });
}

function matches(c, seg, now) {
  if (seg.platform && seg.platform !== 'all' && c.platform !== seg.platform) return false;
  const days = Math.max(1, +seg.days || 30);
  switch (seg.kind || 'all') {
    case 'buyers': return c.orders > 0;
    case 'nobuy': return c.orders === 0;
    case 'repeat': return c.orders >= Math.max(2, +seg.minOrders || 2);
    case 'sleeping': return c.orders > 0 && c.lastOrder && now - c.lastOrder >= days * DAY;
    case 'cart': return c.cart > 0;
    case 'bonus': return c.balance >= Math.max(1, +seg.minBonus || 1);
    case 'new': return c.createdAt && now - c.createdAt <= days * DAY;
    case 'referred': return c.referred;
    case 'manual': return (seg.keys || []).includes(c.key);
    default: return true;
  }
}

// Кому уйдёт рассылка + сколько исключено и почему
async function resolve(seg, now = Date.now()) {
  const all = await audience();
  const hit = all.filter(c => matches(c, seg || {}, now));
  const ok = hit.filter(c => !c.noNews && !c.blocked && hub.has(c.platform));
  return {
    total: all.length, matched: hit.length, count: ok.length,
    unsub: hit.filter(c => c.noNews).length, blocked: hit.filter(c => c.blocked).length,
    byPlatform: { tg: ok.filter(c => c.platform === 'tg').length, max: ok.filter(c => c.platform === 'max').length },
    list: ok,
  };
}

const BUTTONS = {
  none: null,
  shop: { text: '🛍 Открыть магазин', app: true },
  sale: { text: '🔥 Смотреть акции', app: 'sale' },
  fit: { text: '💪 Подборка для ЗОЖ', app: 'fit' },
  cart: { text: '🛒 Моя корзина', app: 'cart' },
  account: { text: '💎 Мои бонусы', app: 'account' },
};

// Сообщение для одного покупателя: {name} и {bonus} подставляются
function render(msg, c) {
  const first = String(c.name || '').trim().split(/\s+/)[0] || '';
  let text = esc(msg.text)
    .replace(/\{name\}/g, esc(first) || 'друзья')
    .replace(/\{bonus\}/g, P.ru(c.balance || 0))
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/^друзья/, 'Друзья'); // **жирный**; «друзья» в начале — с большой
  const rows = [];
  const b = BUTTONS[msg.button] || null;
  if (b && (config.publicUrl || !b.app)) rows.push([{ text: (msg.buttonText || '').trim().slice(0, 40) || b.text, app: b.app }]);
  if (msg.button === 'product' && msg.productId && catalog.get().byId[msg.productId]) rows.push([{ text: (msg.buttonText || '').trim().slice(0, 40) || '🐟 Посмотреть товар', cb: `p:${msg.productId}` }]);
  rows.push([{ text: '🔕 Не присылать рассылки', cb: 'unsub' }]);
  const photo = msg.image ? (/^https?:/.test(msg.image) ? msg.image : config.publicUrl ? config.publicUrl + msg.image : '') : '';
  return photo ? { text, photo, buttons: rows } : { text, buttons: rows };
}

function clean(msg) {
  const text = String(msg.text || '').trim().slice(0, 3500);
  if (!text) throw new catalog.InputError('Напишите текст рассылки');
  if (msg.image && text.length > 1000) throw new catalog.InputError('С картинкой текст до 1000 символов — так требует Telegram');
  return {
    text, image: String(msg.image || '').slice(0, 500),
    button: Object.keys(BUTTONS).concat('product').includes(msg.button) ? msg.button : 'shop',
    buttonText: String(msg.buttonText || '').slice(0, 40), productId: +msg.productId || 0,
  };
}

// Пробная отправка — менеджерам (подключённым командой /manager)
async function test(msgIn) {
  const msg = clean(msgIn);
  const mans = await store.managers();
  let sent = 0;
  for (const m of mans) if (await hub.send(m.platform, { chatId: m.chatId }, render(msg, { name: m.name || '', balance: 0 }))) sent++;
  return { sent, managers: mans.length };
}

async function create(msgIn, seg) {
  const msg = clean(msgIn);
  const segment = { platform: seg.platform || 'all', kind: KINDS[seg.kind] ? seg.kind : 'all', days: +seg.days || 0, minBonus: +seg.minBonus || 0, minOrders: +seg.minOrders || 0, keys: (seg.keys || []).slice(0, 5000).map(String) };
  const r = await resolve(segment);
  if (!r.count) throw new catalog.InputError('В сегменте никого нет');
  const id = 'b' + (await db.incr('seq:broadcast'));
  const job = {
    id, at: Date.now(), status: 'sending', msg, segment, label: segLabel(segment),
    queue: r.list.map(c => c.key), total: r.count, sent: 0, failed: 0, pos: 0,
  };
  await db.set(`broadcast:${id}`, job);
  await db.lpush(LIST, id);
  kick(id);
  return publicJob(job);
}

function segLabel(s) {
  const n = { repeat: s.minOrders || 2, sleeping: s.days || 30, bonus: s.minBonus || 1, new: s.days || 30 }[s.kind];
  const base = (KINDS[s.kind] || KINDS.all).replace(/\bN\b/, n || '').replace(/ \(\)/, '');
  const pl = s.platform === 'tg' ? ' · Telegram' : s.platform === 'max' ? ' · MAX' : '';
  return (s.kind === 'manual' ? `Выбранные (${(s.keys || []).length})` : base) + pl;
}

const publicJob = j => j && ({ id: j.id, at: j.at, status: j.status, label: j.label, total: j.total, sent: j.sent, failed: j.failed, left: Math.max(0, j.total - j.pos), blocked: j.blockedNow || 0, text: j.msg.text, image: j.msg.image, doneAt: j.doneAt || null });

// Отправить следующую порцию. Одновременно работает только один обработчик задания.
async function step(id, budgetMs = 8000) {
  const lock = `broadcast:lock:${id}`;
  if (!(await db.set(lock, 1, { nx: true, ex: Math.ceil(budgetMs / 1000) + 20 }))) return publicJob(await db.get(`broadcast:${id}`));
  try {
    const job = await db.get(`broadcast:${id}`);
    if (!job || job.status !== 'sending') return publicJob(job);
    const until = Date.now() + budgetMs;
    while (job.pos < job.queue.length && Date.now() < until) {
      const key = job.queue[job.pos++];
      const [platform, userId] = key.split(':');
      const u = await store.getUser(platform, userId);
      if (u.noNews || u.blocked || !hub.adapters[platform]) { job.failed++; continue; }
      const l = (await db.get(`loyal:${key}`)) || {};
      try {
        await hub.adapters[platform].send(u.chatId ? { chatId: u.chatId } : { userId }, render(job.msg, { name: u.profile.name || u.name, balance: l.balance || 0 }));
        job.sent++;
      } catch (e) {
        job.failed++;
        // Заблокировал бота или удалил аккаунт — больше не пишем, пока сам не вернётся в бота
        if (/blocked|deactivated|chat not found|user not found|forbidden|403/i.test(e.message)) { u.blocked = 1; await store.saveUser(u); job.blockedNow = (job.blockedNow || 0) + 1; }
        else console.error(`[broadcast] ${key}:`, e.message);
      }
      if (job.pos % 20 === 0) await db.set(`broadcast:${id}`, job);
      await sleep(STEP_MS);
    }
    if (job.pos >= job.queue.length) { job.status = 'done'; job.doneAt = Date.now(); }
    await db.set(`broadcast:${id}`, job);
    return publicJob(job);
  } finally { await db.del(lock); }
}

async function stop(id) {
  const job = await db.get(`broadcast:${id}`);
  if (job && job.status === 'sending') { job.status = 'stopped'; job.doneAt = Date.now(); await db.set(`broadcast:${id}`, job); }
  return publicJob(job);
}

// На своём сервере дорабатываем задание в фоне; на serverless его двигают запросы статуса из админки
function kick(id) {
  if (config.serverless || process.env.BROADCAST_INLINE === '0') return;
  setImmediate(async () => {
    try { for (let i = 0; i < 10000; i++) { const j = await step(id, 20000); if (!j || j.status !== 'sending') break; await sleep(300); } }
    catch (e) { console.error('[broadcast]', e.message); }
  });
}

async function list(n = 20) {
  const ids = [...new Set(await db.lrange(LIST, 0, n - 1))];
  return (await db.mget(ids.map(i => `broadcast:${i}`))).filter(Boolean).map(publicJob);
}

// После перезапуска сервера — продолжить незаконченные
async function resume() {
  for (const j of await list(10)) if (j.status === 'sending') kick(j.id);
}

module.exports = { KINDS, BUTTONS, audience, resolve, render, test, create, step, stop, list, resume, segLabel };
