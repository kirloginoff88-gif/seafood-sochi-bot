/*
 * Оформление бота: приветствие, описание, короткое описание, аватар.
 * Тексты меняются в админке (Настройки → Оформление бота), кнопка «Применить» отправляет их в Telegram и MAX.
 * В текстах можно использовать {name} — имя покупателя, {brand}, {hours}, {cashback}, {welcome}; *так* — жирный.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const catalog = require('./catalog');
const hub = require('./hub');
const db = require('./db');
const media = require('./media');

const DEFAULTS = {
  welcome_text: [
    'Здравствуйте{name}! 👋',
    '',
    '*{brand}* — свежая и замороженная рыба, икра, креветки, крабы и копчёности с доставкой по Сочи.',
    '',
    '🐟 Честный вес — взвешиваем при сборке',
    '❄️ Везём в холоде, без лишнего льда',
    '🚚 Доставка по зонам, бывает бесплатной',
    '💎 Кешбэк {cashback}% бонусами с каждого заказа',
    '',
    'Нажмите «🛍 Открыть магазин» — там фото, цены и корзина. Или просто напишите, что ищете: «креветки», «икра».',
  ].join('\n'),
  bot_description: [
    '{brand} — свежая рыба и морепродукты с доставкой по Сочи 🐟',
    '',
    '• Каталог с фото и ценами прямо в мессенджере',
    '• Честный вес и доставка в холоде',
    '• Кешбэк бонусами и подарки за друзей',
    '',
    'Нажмите «Старт», чтобы открыть магазин.',
  ].join('\n'),
  bot_short: 'Свежая рыба и морепродукты с доставкой по Сочи. Каталог, бонусы и заказ за минуту 🐟',
};

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function vars(extra = {}) {
  const s = catalog.get().settings;
  const L = require('./loyalty').cfg();
  return { brand: s.brand || 'Seafood Сочи', hours: s.hours || '', cashback: L.cashback, welcome: L.welcome, name: '', ...extra };
}
function fill(tpl, v) { return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m)); }
const get = k => { const v = catalog.get().settings[k]; return v && String(v).trim() ? v : DEFAULTS[k]; };

// Приветствие для бота: HTML, картинка-баннер
function welcome(name) {
  const text = esc(fill(get('welcome_text'), vars({ name: name ? ', ' + name : '' }))).replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
  const img = catalog.get().settings.welcome_image;
  const photo = config.publicUrl ? (img ? (/^https?:/.test(img) ? img : config.publicUrl + img) : `${config.publicUrl}/static/welcome.jpg`) : '';
  return { text, photo };
}
const plain = k => fill(get(k), vars()).replace(/\*([^*\n]+)\*/g, '$1');

// Применить оформление в мессенджерах. photo: true — заодно поставить аватар
async function apply({ photo } = {}) {
  const s = catalog.get().settings;
  const name = s.brand || 'Seafood Сочи';
  const description = plain('bot_description'), short = plain('bot_short');
  const out = {};
  let avatar = null;
  if (photo) {
    const own = await db.get('brand:avatar');
    avatar = own ? await media.read(own) : null;
    if (!avatar) avatar = fs.readFileSync(path.join(__dirname, '..', 'webapp', 'assets', 'avatar.jpg'));
  }
  if (hub.adapters.tg && hub.adapters.tg.brand) {
    try { out.tg = await hub.adapters.tg.brand({ name, description, short, photo: avatar }); } catch (e) { out.tg = { error: e.message }; }
  }
  // В MAX имя, описание и аватар задаются в кабинете «MAX для партнёров» (API их не меняет)
  await db.set('brand:applied', { at: Date.now(), photo: !!photo });
  return out;
}

module.exports = { DEFAULTS, welcome, apply, fill, vars };
