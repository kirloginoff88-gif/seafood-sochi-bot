/*
 * Напоминания о брошенной корзине.
 * Когда покупатель меняет корзину и не оформляет заказ — через N часов (настройка, по умолчанию 3)
 * бот пишет «🛒 У вас 2 товара в корзине!», через сутки — ещё раз, и больше не беспокоит.
 * Ночью (21:00–9:00 по Сочи) не пишем — отправим утром.
 *
 * Кто запускает проверку:
 *  - на своём сервере — таймер раз в 5 минут (src/start.js);
 *  - на Vercel — любой входящий запрос бота не чаще раза в 10 минут,
 *    плюс можно подключить бесплатный планировщик (cron-job.org) на адрес /cron/reminders?key=… из админки.
 */
const config = require('./config');
const db = require('./db');
const store = require('./store');
const catalog = require('./catalog');
const hub = require('./hub');
const P = require('./shared/pricing');

const QUEUE = 'carts';
const SECOND_AFTER = 24 * 3600e3;
const DEFAULT_TEXT = '🛒 У вас {count} в корзине!\n\nОформите заказ, чтобы менеджер закрепил партию и окно доставки.';

// Корзина изменилась — ставим покупателя в очередь проверки
async function touch(u) {
  if (u.platform === 'web') return;
  u.cartAt = Date.now();
  u.remindN = 0;
  if (Object.keys(u.cart || {}).length) await db.lpush(QUEUE, `${u.platform}:${u.userId}`);
}

function cfg() {
  const s = catalog.get().settings;
  return {
    enabled: s.remind_enabled !== '0',
    hours: Math.max(1, Math.min(72, +s.remind_hours || 3)),
    text: (s.remind_text && String(s.remind_text).trim()) || DEFAULT_TEXT,
  };
}

const sochiHour = now => new Date(now + 3 * 3600e3).getUTCHours();
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function view(u, second) {
  const orders = require('./orders');
  const s = orders.summarize(u.cart);
  const n = s.lines.length;
  const count = `${n} ${P.plural(n, 'товар', 'товара', 'товаров')}`;
  const head = esc(cfg().text.replace(/\{count\}/g, count)).replace(/^(.+)$/m, '<b>$1</b>');
  const list = s.lines.slice(0, 5).map(l => `• ${esc(l.name)} — ${l.qtyLabel}`).join('\n') + (n > 5 ? `\n• и ещё ${n - 5}` : '');
  const rows = [];
  if (config.publicUrl) rows.push([{ text: '🛍 Оформить в магазине', app: 'cart' }]);
  rows.push([{ text: `🛒 Корзина · ${P.rub(s.sum)}`, cb: 'cart' }]);
  return { text: `${second ? '⏰ ' : ''}${head}\n\n${list}\n\n<b>Примерно: ${P.rub(s.sum)}</b>`, buttons: rows };
}

// Проверить очередь и разослать напоминания. Возвращает число отправленных.
async function run({ now = Date.now(), force = false } = {}) {
  const c = cfg();
  if (!c.enabled) return { sent: 0, skipped: 'выключены' };
  const h = sochiHour(now);
  if (!force && (h < 9 || h >= 21)) return { sent: 0, skipped: 'ночь' };
  const keys = [...new Set(await db.lrange(QUEUE, 0, 1999))];
  if (!keys.length) return { sent: 0 };
  await db.del(QUEUE);
  await catalog.sync();
  let sent = 0;
  const keep = [];
  for (const key of keys) {
    const [platform, userId] = key.split(':');
    const u = await store.getUser(platform, userId);
    const items = require('./orders').summarize(u.cart).lines.length;
    if (!items || !u.cartAt) continue;              // корзина пуста или заказ оформлен
    const n = u.remindN || 0;
    if (n >= 2) continue;                            // уже напоминали дважды
    const due = u.cartAt + (n === 0 ? c.hours * 3600e3 : SECOND_AFTER);
    if (now < due) { keep.push(key); continue; }
    const r = await hub.send(platform, u.chatId ? { chatId: u.chatId } : { userId }, view(u, n === 1));
    // Сохраняем отметку, перечитав покупателя: за время рассылки он мог изменить корзину
    const fresh = await store.getUser(platform, userId);
    if (fresh.cartAt === u.cartAt) { fresh.remindN = n + 1; fresh.remindAt = now; await store.saveUser(fresh); }
    if (r) sent++;
    if (n === 0) keep.push(key);
  }
  for (const k of keep) await db.lpush(QUEUE, k);
  return { sent, waiting: keep.length };
}

// Запуск «заодно» с входящими запросами — не чаще раза в 10 минут
async function maybeRun() {
  const last = +(await db.get('remind:last')) || 0;
  if (Date.now() - last < 10 * 60e3) return null;
  await db.set('remind:last', Date.now());
  try { return await run(); } catch (e) { console.error('[reminders]', e.message); return null; }
}

module.exports = { touch, run, maybeRun, view, cfg, DEFAULT_TEXT };
