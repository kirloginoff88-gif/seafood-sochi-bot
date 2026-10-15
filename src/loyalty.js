/*
 * Бонусная и реферальная программа.
 * Баланс и история лежат отдельно от карточки покупателя (loyal:<платформа>:<id>),
 * чтобы начисления не перетирались, когда тот же человек одновременно менеджер.
 *
 *  - кешбэк: после статуса «Доставлен» начисляем N% от оплаченной суммы (итог по весу минус бонусы);
 *  - оплата бонусами: до M% суммы заказа, списываем при оформлении, возвращаем при отмене;
 *  - рефералы: у каждого покупателя код; друг по ссылке получает подарок,
 *    пригласивший — награду после первого доставленного заказа друга.
 * Настройки — в админке (Настройки → Бонусы), хранятся в settings каталога.
 */
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const catalog = require('./catalog');
const hub = require('./hub');
const P = require('./shared/pricing');

const KEY = (p, id) => `loyal:${p}:${id}`;
const HISTORY = 50;

function cfg() {
  const s = catalog.get().settings;
  const n = (v, d) => (v === undefined || v === '' ? d : Math.max(0, Math.round(+v || 0)));
  return {
    enabled: s.bonus_enabled !== '0',
    cashback: Math.min(50, n(s.bonus_cashback, 5)),
    maxPay: Math.min(100, n(s.bonus_max_pay, 30)),
    welcome: n(s.bonus_welcome, 300),
    referrer: n(s.bonus_referrer, 500),
  };
}

async function get(p, id) {
  const d = (await db.get(KEY(p, id))) || {};
  return { balance: 0, history: [], refCount: 0, ...d };
}
const save = (p, id, d) => db.set(KEY(p, id), d);

async function credit(p, id, amount, reason, orderId) {
  amount = Math.round(amount);
  if (!amount) return get(p, id);
  const d = await get(p, id);
  d.balance = Math.max(0, d.balance + amount);
  d.history = [{ at: Date.now(), amount, reason, orderId: orderId || null }, ...d.history].slice(0, HISTORY);
  await save(p, id, d);
  return d;
}

// Личный код приглашения: стабильный, короткий, без похожих символов
async function refCode(p, id) {
  const d = await get(p, id);
  if (d.refCode) return d.refCode;
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const h = crypto.createHash('sha256').update(`${p}:${id}`).digest();
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[h[i] % alphabet.length];
  d.refCode = code;
  await db.set(`ref:${code}`, { platform: p, userId: String(id) });
  await save(p, id, d);
  return code;
}

// Ссылки на бота: имя бота кэшируем, чтобы не спрашивать платформу каждый раз
const botNames = {};
async function botName(platform) {
  if (botNames[platform]) return botNames[platform];
  if (platform === 'max' && config.max.botName) return (botNames.max = config.max.botName);
  let name = await db.get(`bot:${platform}:username`);
  if (!name && hub.adapters[platform]) {
    try {
      const me = platform === 'tg' ? await hub.adapters.tg.api('getMe') : await hub.adapters.max.api('GET', '/me');
      name = me && me.username;
      if (name) await db.set(`bot:${platform}:username`, name);
    } catch (e) { console.warn(`[loyalty] имя бота ${platform}:`, e.message); }
  }
  if (name) botNames[platform] = name;
  return name || '';
}
async function refLink(p, code) {
  const name = await botName(p);
  if (!name) return '';
  return p === 'tg' ? `https://t.me/${name}?start=ref_${code}` : `https://max.ru/${name}?start=ref_${code}`;
}

// Применить приглашение: только новому покупателю, один раз, не самому себе
async function applyReferral(p, id, code, { hasOrders } = {}) {
  const c = cfg();
  if (!c.enabled || !code) return null;
  code = String(code).toUpperCase().replace(/^REF_/, '');
  const owner = await db.get(`ref:${code}`);
  if (!owner || (owner.platform === p && String(owner.userId) === String(id))) return null;
  const d = await get(p, id);
  if (d.referredBy || hasOrders) return null;
  d.referredBy = owner;
  await save(p, id, d);
  if (c.welcome) await credit(p, id, c.welcome, 'Подарок за приглашение');
  const o = await get(owner.platform, owner.userId);
  o.refCount = (o.refCount || 0) + 1;
  await save(owner.platform, owner.userId, o);
  await hub.send(owner.platform, { userId: owner.userId }, { text: `👋 По вашей ссылке пришёл друг! Когда он получит первый заказ, вам начислим <b>${c.referrer} бонусов</b>.` });
  return { welcome: c.welcome };
}

const maxSpend = (d, sum) => { const c = cfg(); return c.enabled ? Math.max(0, Math.min(d.balance, Math.floor((sum * c.maxPay) / 100))) : 0; };

// Списание при оформлении заказа
async function spend(p, id, amount, orderId) {
  if (!amount) return;
  await credit(p, id, -amount, `Оплата заказа №${orderId}`, orderId);
}

// Начисления и возвраты по смене статуса заказа (повторный вызов ничего не удвоит)
async function onStatus(order, status) {
  if (!order || order.platform === 'web' || !order.userId) return null;
  const store = require('./store');
  const c = cfg();
  const p = order.platform, id = order.userId;
  const notify = text => hub.send(p, order.chatId ? { chatId: order.chatId } : { userId: id }, { text });

  if (status === 'canceled' && order.bonusUsed && !order.bonusRefunded) {
    await store.setOrder(order.id, { bonusRefunded: true });
    await credit(p, id, order.bonusUsed, `Возврат: заказ №${order.id} отменён`, order.id);
    await notify(`↩️ Вернули <b>${order.bonusUsed} бонусов</b> за отменённый заказ №${order.id}.`);
    return { refunded: order.bonusUsed };
  }
  if (status !== 'done' || order.bonusAccrued) return null;

  const paid = Math.max(0, (order.finalSum || order.sum) - (order.bonusUsed || 0));
  const earned = c.enabled ? Math.floor((paid * c.cashback) / 100) : 0;
  await store.setOrder(order.id, { bonusAccrued: true, bonusEarned: earned });
  let d = earned ? await credit(p, id, earned, `Кешбэк ${c.cashback}% за заказ №${order.id}`, order.id) : await get(p, id);
  if (earned) await notify(`💎 Начислили <b>${earned} бонусов</b> за заказ №${order.id}. На счёте: <b>${d.balance}</b>.\nИми можно оплатить до ${c.maxPay}% следующего заказа.`);

  // Награда пригласившему — за первый доставленный заказ друга
  if (c.enabled && d.referredBy && !d.refRewarded) {
    d = await get(p, id);
    d.refRewarded = true;
    await save(p, id, d);
    const owner = d.referredBy;
    if (c.referrer) {
      const od = await credit(owner.platform, owner.userId, c.referrer, 'Друг сделал первый заказ', order.id);
      await hub.send(owner.platform, { userId: owner.userId }, { text: `🎉 Ваш друг получил первый заказ — начислили <b>${c.referrer} бонусов</b>! На счёте: <b>${od.balance}</b>.` });
    }
  }
  return { earned };
}

// Всё для личного кабинета
async function account(p, id, user) {
  const store = require('./store');
  const c = cfg();
  const d = await get(p, id);
  const code = await refCode(p, id);
  const orders = await store.ordersByIds((user && user.orderIds ? user.orderIds : []).slice(0, 10));
  const { STATUS } = require('./orders');
  return {
    bonus: { ...c, balance: d.balance },
    history: d.history.slice(0, 20),
    ref: { code, link: await refLink(p, code), count: d.refCount || 0, referred: !!d.referredBy },
    orders: orders.map(o => ({
      id: o.id, at: o.createdAt, status: o.status, statusLabel: (STATUS[o.status] || {}).label || o.status,
      sum: o.sum, finalSum: o.finalSum || null, bonusUsed: o.bonusUsed || 0, bonusEarned: o.bonusEarned || 0,
      items: o.lines.length, lines: o.lines.map(l => ({ id: l.id, name: l.name, qty: l.qty, qtyLabel: l.qtyLabel })),
    })),
  };
}

module.exports = { cfg, get, credit, refCode, refLink, botName, applyReferral, maxSpend, spend, onStatus, account, rub: P.rub };
