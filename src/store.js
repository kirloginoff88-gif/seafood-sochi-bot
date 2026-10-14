// Простое хранилище в JSON-файле: сессии покупателей, корзины, заказы, менеджеры.
// Для пилота на сотни заказов в месяц этого достаточно; при росте — заменить на SQLite/Postgres.
const fs = require('fs');
const path = require('path');
const config = require('./config');

const file = path.join(config.dataDir, 'store.json');
let db = { seq: 1000, users: {}, orders: {}, managers: [], questions: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}

let timer = null;
function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    fs.mkdirSync(config.dataDir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
    fs.renameSync(tmp, file);
  }, 300);
}
function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(db, null, 1));
}

const key = (platform, userId) => `${platform}:${userId}`;

// Пользователь один на платформу: корзина общая для чата и мини-приложения
function user(platform, userId, patch) {
  const k = key(platform, userId);
  if (!db.users[k]) db.users[k] = { platform, userId: String(userId), cart: {}, step: null, draft: {}, profile: {}, createdAt: Date.now() };
  if (patch) { Object.assign(db.users[k], patch); save(); }
  return db.users[k];
}
function touch() { save(); }

function newOrder(data) {
  db.seq += 1;
  const id = db.seq;
  db.orders[id] = { id, status: 'new', createdAt: Date.now(), history: [{ at: Date.now(), status: 'new' }], ...data };
  save();
  return db.orders[id];
}
const order = id => db.orders[id] || null;
function setOrder(id, patch) {
  const o = db.orders[id];
  if (!o) return null;
  if (patch.status && patch.status !== o.status) o.history.push({ at: Date.now(), status: patch.status, by: patch.by });
  Object.assign(o, patch);
  save();
  return o;
}
function lastOrders(platform, userId, n = 3) {
  return Object.values(db.orders).filter(o => o.platform === platform && String(o.userId) === String(userId))
    .sort((a, b) => b.id - a.id).slice(0, n);
}

// Менеджеры: те, кто ввёл /manager PIN, плюс заданные в .env
function managers() {
  const fromEnv = [
    ...config.telegram.managers.map(chatId => ({ platform: 'tg', chatId })),
    ...config.max.managers.map(chatId => ({ platform: 'max', chatId })),
  ];
  const all = [...fromEnv, ...db.managers];
  const seen = new Set();
  return all.filter(m => { const k = m.platform + ':' + m.chatId; if (seen.has(k)) return false; seen.add(k); return true; });
}
function addManager(platform, chatId, name) {
  if (!db.managers.find(m => m.platform === platform && String(m.chatId) === String(chatId))) {
    db.managers.push({ platform, chatId: String(chatId), name, at: Date.now() });
    save();
  }
}
function removeManager(platform, chatId) {
  db.managers = db.managers.filter(m => !(m.platform === platform && String(m.chatId) === String(chatId)));
  save();
}
const isManager = (platform, chatId) => managers().some(m => m.platform === platform && String(m.chatId) === String(chatId));

function newQuestion(data) {
  const id = 'q' + (Object.keys(db.questions).length + 1);
  db.questions[id] = { id, at: Date.now(), answered: false, ...data };
  save();
  return db.questions[id];
}
const question = id => db.questions[id] || null;

module.exports = { user, touch, newOrder, order, setOrder, lastOrders, managers, addManager, removeManager, isManager, newQuestion, question, flush, _db: () => db };
