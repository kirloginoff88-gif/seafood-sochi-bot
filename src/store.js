// Покупатели, корзины, заказы, менеджеры, вопросы — поверх db (файл или Redis).
// Ключи: user:<платформа>:<id>, order:<№>, orders (список №), seq:order, managers, q:<id>, seq:q
const db = require('./db');
const config = require('./config');

const ORDER_BASE = 1000; // номера заказов начинаются с 1001

async function getUser(platform, userId) {
  const key = `user:${platform}:${userId}`;
  const u = (await db.get(key)) || { platform, userId: String(userId), cart: {}, step: null, draft: {}, profile: {}, orderIds: [], createdAt: Date.now() };
  u.cart ||= {}; u.draft ||= {}; u.profile ||= {}; u.orderIds ||= [];
  return u;
}
async function saveUser(u) {
  // Новых покупателей добавляем в общий список — для вкладки «Покупатели» в админке
  if (!u.indexed) { u.indexed = 1; await db.lpush('users', `${u.platform}:${u.userId}`); }
  await db.set(`user:${u.platform}:${u.userId}`, u);
}
async function listUsers(limit = 500) {
  const keys = [...new Set(await db.lrange('users', 0, limit - 1))];
  const users = await db.mget(keys.map(k => `user:${k}`));
  const loyal = await db.mget(keys.map(k => `loyal:${k}`));
  return users.map((u, i) => (u ? { u, l: loyal[i] || {} } : null)).filter(Boolean);
}

async function newOrder(data) {
  const id = ORDER_BASE + (await db.incr('seq:order'));
  const o = { id, status: 'new', createdAt: Date.now(), history: [{ at: Date.now(), status: 'new' }], ...data };
  await db.set(`order:${id}`, o);
  await db.lpush('orders', id);
  return o;
}
const order = id => db.get(`order:${+id}`);
async function setOrder(id, patch) {
  const o = await order(id);
  if (!o) return null;
  if (patch.status && patch.status !== o.status) o.history.push({ at: Date.now(), status: patch.status, by: patch.by });
  Object.assign(o, patch);
  await db.set(`order:${o.id}`, o);
  return o;
}
async function listOrders(limit = 200) {
  const ids = await db.lrange('orders', 0, limit - 1);
  return (await db.mget(ids.map(id => `order:${id}`))).filter(Boolean);
}
async function ordersByIds(ids) {
  return (await db.mget(ids.map(id => `order:${id}`))).filter(Boolean);
}

// Менеджеры: подключённые командой /manager плюс заданные в .env
async function managers() {
  const fromEnv = [
    ...config.telegram.managers.map(chatId => ({ platform: 'tg', chatId })),
    ...config.max.managers.map(chatId => ({ platform: 'max', chatId })),
  ];
  const all = [...fromEnv, ...((await db.get('managers')) || [])];
  const seen = new Set();
  return all.filter(m => { const k = m.platform + ':' + m.chatId; if (seen.has(k)) return false; seen.add(k); return true; });
}
async function addManager(platform, chatId, name) {
  const list = (await db.get('managers')) || [];
  if (!list.find(m => m.platform === platform && String(m.chatId) === String(chatId))) {
    list.push({ platform, chatId: String(chatId), name, at: Date.now() });
    await db.set('managers', list);
  }
}
async function removeManager(platform, chatId) {
  const list = (await db.get('managers')) || [];
  await db.set('managers', list.filter(m => !(m.platform === platform && String(m.chatId) === String(chatId))));
}
async function isManager(platform, chatId) {
  return (await managers()).some(m => m.platform === platform && String(m.chatId) === String(chatId));
}

async function newQuestion(data) {
  const id = 'q' + (await db.incr('seq:q'));
  const q = { id, at: Date.now(), answered: false, ...data };
  await db.set(`q:${id}`, q);
  return q;
}
const question = id => db.get(`q:${id}`);
const saveQuestion = q => db.set(`q:${q.id}`, q);

module.exports = { getUser, saveUser, listUsers, newOrder, order, setOrder, listOrders, ordersByIds, managers, addManager, removeManager, isManager, newQuestion, question, saveQuestion, flush: db.flush };
