/*
 * Каталог — источник правды для бота и мини-приложения.
 * Хранится в storage/catalog.json. При первом запуске заполняется из data/catalog.seed.json.
 * Меняется из админ-панели; изменения сразу видны в боте и приложении.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const P = require('./shared/pricing');

const file = () => path.join(config.dataDir, 'catalog.json');
const seedFile = path.join(config.root, 'data', 'catalog.seed.json');
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

let raw = null;   // как лежит на диске
let state = null; // подготовленный для бота и приложения

// ---------- чтение ----------
const thumbOf = src => (src ? String(src).replace(/\.(jpg|jpeg|png|webp)(\?|$)/i, '_t.$1$2') : '');
const absUrl = src => (!src ? '' : /^https?:\/\//.test(src) ? src : config.publicUrl ? config.publicUrl + src : '');

function build() {
  const cats = [...raw.cats].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const order = Object.fromEntries(cats.map((c, i) => [c.cid, i]));
  const products = raw.products
    .map(p => ({ ...p, thumb: thumbOf(p.image), imageAbs: absUrl(p.image) }))
    .sort((a, b) => (order[a.cid] ?? 999) - (order[b.cid] ?? 999) || (a.sort ?? 0) - (b.sort ?? 0));
  state = {
    cats: cats.map(c => ({ ...c, count: products.filter(p => p.cid === c.cid && !p.out).length, total: products.filter(p => p.cid === c.cid).length, banner: absUrl(c.image) })),
    products,
    settings: { min_order: '0', ...raw.settings },
    byId: Object.fromEntries(products.map(p => [p.id, p])),
    source: 'local',
  };
  return state;
}

function load() {
  try {
    raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    raw = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
    persist();
    console.log('[catalog] создан каталог из стартового наполнения');
  }
  raw.cats ||= []; raw.products ||= []; raw.settings ||= {};
  return build();
}

function get() { return state || load(); }
function start() { load(); }

// ---------- запись ----------
function persist() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  // одна резервная копия в день — на случай случайного удаления
  const bdir = path.join(config.dataDir, 'backup');
  const bfile = path.join(bdir, `catalog-${new Date().toISOString().slice(0, 10)}.json`);
  if (fs.existsSync(file()) && !fs.existsSync(bfile)) { fs.mkdirSync(bdir, { recursive: true }); fs.copyFileSync(file(), bfile); }
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 1));
  fs.renameSync(tmp, file());
}
function commit({ prices } = {}) {
  if (prices) {
    const d = new Date(Date.now() + 3 * 3600e3);
    raw.settings.price_date = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  }
  persist();
  build();
}

class InputError extends Error {}
const fail = msg => { throw new InputError(msg); };
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const int = (v, min, max) => { const n = Math.round(+v || 0); return Math.min(max, Math.max(min, n)); };
const isDate = s => s === '' || /^\d{4}-\d{2}-\d{2}$/.test(s);
const isImage = s => s === '' || /^\/media\/[a-z0-9_-]+\.(jpg|png|webp)$/.test(s) || /^https:\/\/[^\s"'<>]+$/.test(s);

// Удаляем загруженное фото, если на него больше никто не ссылается
function dropImage(src) {
  if (!src || !src.startsWith('/media/')) return;
  const used = raw.products.some(p => p.image === src) || raw.cats.some(c => c.image === src);
  if (used) return;
  for (const f of [src, thumbOf(src)]) fs.rm(path.join(config.uploadsDir, path.basename(f)), { force: true }, () => {});
}

function saveProduct(input) {
  get();
  const isNew = !input.id;
  const old = isNew ? null : raw.products.find(p => p.id === +input.id);
  if (!isNew && !old) fail('Товар не найден — возможно, его уже удалили');
  const p = {
    id: old ? old.id : raw.products.reduce((m, x) => Math.max(m, x.id), 0) + 1,
    cid: str(input.cid, 40),
    name: str(input.name, 120),
    note: str(input.note, 200),
    price: int(input.price, 0, 10_000_000),
    unit: input.unit === 'кг' ? 'кг' : 'шт',
    out: input.out ? 1 : 0,
    sort: old ? old.sort : raw.products.filter(x => x.cid === input.cid).reduce((m, x) => Math.max(m, x.sort ?? 0), -1) + 1,
    image: str(input.image, 500),
    piece_g: int(input.piece_g, 0, 100_000),
    min_g: int(input.min_g, 0, 100_000),
    sale_price: int(input.sale_price, 0, 10_000_000),
    sale_from: str(input.sale_from, 10),
    sale_to: str(input.sale_to, 10),
  };
  if (!raw.cats.some(c => c.cid === p.cid)) fail('Выберите категорию');
  if (!p.name) fail('Укажите название');
  if (p.unit === 'шт') { p.piece_g = 0; p.min_g = 0; }
  if (p.piece_g && p.piece_g < 50) fail('Вес одной штуки — не меньше 50 г');
  if (p.min_g && p.min_g < 100) fail('Минимальный вес — не меньше 100 г');
  if (p.piece_g) p.min_g = 0;
  if (!isDate(p.sale_from) || !isDate(p.sale_to)) fail('Неверная дата акции');
  if (p.sale_price && p.sale_price >= p.price) fail('Цена по акции должна быть ниже обычной');
  if (p.sale_from && p.sale_to && p.sale_from > p.sale_to) fail('Акция заканчивается раньше, чем начинается');
  if (!p.sale_price) { p.sale_from = ''; p.sale_to = ''; }
  if (!isImage(p.image)) fail('Некорректное фото');
  // категория сменилась — в конец новой
  if (old && old.cid !== p.cid) p.sort = raw.products.filter(x => x.cid === p.cid).reduce((m, x) => Math.max(m, x.sort ?? 0), -1) + 1;

  const pricesChanged = !old || old.price !== p.price || old.sale_price !== p.sale_price;
  const prevImage = old ? old.image : '';
  if (old) Object.assign(old, p); else raw.products.push(p);
  if (prevImage && prevImage !== p.image) dropImage(prevImage);
  commit({ prices: pricesChanged });
  return state.byId[p.id];
}

// Быстрые правки из списка: цена и наличие
function quickProduct(id, patch) {
  get();
  const p = raw.products.find(x => x.id === +id);
  if (!p) fail('Товар не найден');
  let prices = false;
  if (patch.price !== undefined) {
    const v = int(patch.price, 0, 10_000_000);
    if (p.sale_price && p.sale_price >= v && v > 0) fail('Цена ниже акционной — сначала измените акцию');
    prices = v !== p.price; p.price = v;
  }
  if (patch.out !== undefined) p.out = patch.out ? 1 : 0;
  commit({ prices });
  return state.byId[p.id];
}

function deleteProduct(id) {
  get();
  const i = raw.products.findIndex(x => x.id === +id);
  if (i < 0) fail('Товар не найден');
  const [p] = raw.products.splice(i, 1);
  dropImage(p.image);
  commit();
}

// Сдвиг вверх/вниз внутри категории (или категорий между собой)
function move(list, item, dir) {
  const sorted = list.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  sorted.forEach((x, i) => (x.sort = i));
  const i = sorted.indexOf(item), j = i + (dir < 0 ? -1 : 1);
  if (j < 0 || j >= sorted.length) return;
  [sorted[i].sort, sorted[j].sort] = [sorted[j].sort, sorted[i].sort];
}
function moveProduct(id, dir) {
  get();
  const p = raw.products.find(x => x.id === +id);
  if (!p) fail('Товар не найден');
  move(raw.products.filter(x => x.cid === p.cid), p, dir);
  commit();
}

function saveCategory(input) {
  get();
  const name = str(input.name, 60);
  const emoji = str(input.emoji, 8) || '🐟';
  if (!name) fail('Укажите название категории');
  const image = str(input.image, 500);
  if (!isImage(image)) fail('Некорректное фото');
  let c = input.cid ? raw.cats.find(x => x.cid === input.cid) : null;
  if (input.cid && !c) fail('Категория не найдена');
  if (raw.cats.some(x => x !== c && x.name.toLowerCase() === name.toLowerCase())) fail('Такая категория уже есть');
  if (c) {
    if (c.image !== image) { const was = c.image; c.image = image; dropImage(was); }
    Object.assign(c, { name, emoji });
  } else {
    c = { cid: 'c' + crypto.randomBytes(3).toString('hex'), name, emoji, image, sort: raw.cats.reduce((m, x) => Math.max(m, x.sort ?? 0), -1) + 1 };
    raw.cats.push(c);
  }
  commit();
  return c;
}
function deleteCategory(cid) {
  get();
  const i = raw.cats.findIndex(x => x.cid === cid);
  if (i < 0) fail('Категория не найдена');
  if (raw.products.some(p => p.cid === cid)) fail('В категории есть товары — перенесите или удалите их');
  const [c] = raw.cats.splice(i, 1);
  dropImage(c.image);
  commit();
}
function moveCategory(cid, dir) {
  get();
  const c = raw.cats.find(x => x.cid === cid);
  if (!c) fail('Категория не найдена');
  move(raw.cats, c, dir);
  commit();
}

const SETTINGS = { brand: 60, phone_tel: 40, phone_wa: 20, hours: 80, delivery: 400, payment: 200, price_date: 30, min_order: 10 };
function saveSettings(input) {
  get();
  for (const [k, max] of Object.entries(SETTINGS)) if (input[k] !== undefined) raw.settings[k] = str(input[k], max);
  raw.settings.min_order = String(int(raw.settings.min_order, 0, 1_000_000));
  raw.settings.phone_wa = raw.settings.phone_wa.replace(/\D/g, '');
  if (!raw.settings.brand) fail('Укажите название магазина');
  commit();
  return state.settings;
}

function setImage(kind, id, src) {
  get();
  const item = kind === 'cat' ? raw.cats.find(c => c.cid === id) : raw.products.find(p => p.id === +id);
  if (item) { item.image = src; commit(); }
}

// ---------- поиск и подписи ----------
const norm = s => String(s).toLowerCase().replace(/ё/g, 'е');
function search(q, limit = 10) {
  const c = get();
  const words = norm(q).split(/[^a-zа-я0-9]+/).filter(w => w.length > 2)
    .map(w => w.slice(0, Math.max(4, w.length - 2))); // грубая «основа» слова: креветки → кревет
  if (!words.length) return [];
  const scored = [];
  for (const p of c.products) {
    if (p.out) continue;
    const cat = c.cats.find(x => x.cid === p.cid);
    const hay = norm(p.name + ' ' + p.note + ' ' + (cat ? cat.name : ''));
    const hits = words.filter(w => hay.includes(w)).length;
    if (hits) scored.push([hits + (norm(p.name).includes(words[0]) ? 1 : 0), p]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(x => x[1]);
}

// Одинаковые названия различаются фасовкой в описании («250 г», «500 г»)
function fullName(p) {
  const dup = get().products.filter(x => x.name === p.name).length > 1;
  return dup && p.note ? `${p.name}, ${p.note}` : p.name;
}

function sales() { return get().products.filter(p => !p.out && P.onSale(p)); }

module.exports = {
  get, start, load, search, fullName, sales, thumbOf,
  saveProduct, quickProduct, deleteProduct, moveProduct,
  saveCategory, deleteCategory, moveCategory, saveSettings, setImage, InputError,
  _raw: () => (get(), raw),
};
