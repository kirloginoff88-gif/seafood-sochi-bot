// Адаптер Telegram Bot API: апдейты → события бота, экраны → сообщения с клавиатурами.
const config = require('../config');
const bot = require('../bot');

const BASE = () => `https://api.telegram.org/bot${config.telegram.token}/`;

async function api(method, body) {
  const res = await fetch(BASE() + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(method === 'getUpdates' ? 40000 : 15000),
  });
  const json = await res.json().catch(() => ({ ok: false, description: 'bad json' }));
  if (!json.ok) {
    const err = new Error(`${method}: ${json.description || res.status}`);
    err.description = json.description || '';
    throw err;
  }
  return json.result;
}

// Экран → параметры сообщения Telegram
function render(view) {
  const p = { text: view.text || ' ', parse_mode: 'HTML' };
  p.link_preview_options = view.image ? { url: view.image, show_above_text: true, prefer_large_media: false } : { is_disabled: true };
  const rows = view.buttons || [];
  const special = rows.some(r => r.some(b => b.contact || b.location));
  if (special) {
    // Запрос контакта и геоточки в Telegram возможен только на обычной клавиатуре.
    // Нажатия её кнопок приходят текстом — соответствие текст → действие запоминает bot.js
    const keyboard = rows.map(r => r.filter(b => b.contact || b.location || b.cb).map(b => {
      if (b.contact) return { text: b.text, request_contact: true };
      if (b.location) return { text: b.text, request_location: true };
      return { text: b.text };
    })).filter(r => r.length);
    p.reply_markup = { keyboard, resize_keyboard: true, one_time_keyboard: true };
    return p;
  }
  const inline = rows.map(r => r.map(b => {
    if (b.url) return { text: b.text, url: b.url };
    if (b.app) return config.publicUrl ? { text: b.text, web_app: { url: config.appUrl('tg') } } : null;
    return { text: b.text, callback_data: String(b.cb).slice(0, 64) };
  }).filter(Boolean)).filter(r => r.length);
  if (inline.length) p.reply_markup = { inline_keyboard: inline };
  else if (view.removeKeyboard) p.reply_markup = { remove_keyboard: true };
  return p;
}

async function send(target, view) {
  const chatId = target.chatId || target.userId;
  const p = render(view);
  const m = await api('sendMessage', { chat_id: chatId, ...p });
  return { msgId: m.message_id };
}

async function edit(target, msgId, view) {
  const chatId = target.chatId || target.userId;
  const p = render(view);
  if (p.reply_markup && !p.reply_markup.inline_keyboard) return send(target, view); // обычную клавиатуру нельзя поставить правкой
  try {
    await api('editMessageText', { chat_id: chatId, message_id: msgId, ...p });
    return { msgId };
  } catch (e) {
    if (/not modified/i.test(e.description)) return { msgId };
    return send(target, view);
  }
}

function userOf(from) {
  return { id: String(from.id), name: [from.first_name, from.last_name].filter(Boolean).join(' '), username: from.username || '' };
}

async function handleUpdate(up) {
  try {
    if (up.message) {
      const m = up.message;
      if (m.chat.type !== 'private') return; // бот работает в личке
      const base = { platform: 'tg', user: userOf(m.from), chatId: String(m.chat.id) };
      const ctx = {
        reply: v => send({ chatId: m.chat.id }, v),
        edit: v => send({ chatId: m.chat.id }, v),
        toast: () => Promise.resolve(),
      };
      let ev;
      if (m.contact) ev = { ...base, type: 'contact', phone: '+' + String(m.contact.phone_number).replace(/^\+/, '') };
      else if (m.location) ev = { ...base, type: 'location', lat: m.location.latitude, lon: m.location.longitude };
      else if (m.web_app_data) return; // данные из мини-приложения идут через /api/order
      else if (typeof m.text === 'string' && /^\/start\b/.test(m.text)) ev = { ...base, type: 'start', payload: m.text.split(/\s+/)[1] || '' };
      else if (typeof m.text === 'string') ev = { ...base, type: 'text', text: m.text };
      else return;
      await bot.handle(ev, ctx);
    } else if (up.callback_query) {
      const q = up.callback_query;
      const chatId = q.message ? q.message.chat.id : q.from.id;
      let answered = false;
      const ctx = {
        reply: v => send({ chatId }, v),
        edit: v => (q.message ? edit({ chatId }, q.message.message_id, v) : send({ chatId }, v)),
        toast: text => { if (answered) return Promise.resolve(); answered = true; return api('answerCallbackQuery', { callback_query_id: q.id, text: String(text).slice(0, 200) }).catch(() => {}); },
      };
      await bot.handle({ platform: 'tg', type: 'callback', user: userOf(q.from), chatId: String(chatId), data: q.data }, ctx);
      if (!answered) await api('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
    }
  } catch (e) {
    console.error('[tg] update error:', e.message);
  }
}

const UPDATES = ['message', 'callback_query'];

// Команды и кнопка «Магазин»
async function setup() {
  await api('setMyCommands', { commands: [
    { command: 'menu', description: 'Главное меню' },
    { command: 'catalog', description: 'Каталог' },
    { command: 'cart', description: 'Корзина' },
    { command: 'account', description: 'Кабинет и бонусы' },
  ] }).catch(e => console.warn('[tg] commands:', e.message));
  if (config.publicUrl) {
    await api('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Магазин', web_app: { url: config.appUrl('tg') } } })
      .catch(e => console.warn('[tg] menu button:', e.message));
  }
}

// Подключить бота к этому серверу через вебхук (так работает на Vercel)
async function connect() {
  if (!config.telegram.token) throw new Error('TG_TOKEN не задан');
  if (!config.publicUrl) throw new Error('Не известен публичный адрес (PUBLIC_URL)');
  const me = await api('getMe');
  await setup();
  await api('setWebhook', { url: `${config.publicUrl}/webhook/tg`, secret_token: config.telegram.webhookSecret, allowed_updates: UPDATES, max_connections: 10 });
  return status(me);
}

async function status(me) {
  if (!config.telegram.token) return { enabled: false };
  me = me || (await api('getMe'));
  if (me.username) await require('../db').set('bot:tg:username', me.username).catch(() => {}); // для реферальных ссылок
  const info = await api('getWebhookInfo');
  const expected = `${config.publicUrl}/webhook/tg`;
  return {
    enabled: true, username: me.username, link: `https://t.me/${me.username}`,
    webhook: info.url || '', connected: !!info.url && info.url === expected,
    pending: info.pending_update_count || 0,
    lastError: info.last_error_message ? `${info.last_error_message} (${new Date(info.last_error_date * 1000).toLocaleString('ru-RU')})` : '',
  };
}

let stopped = false;
async function poll() {
  await api('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
  let offset = 0;
  while (!stopped) {
    try {
      const ups = await api('getUpdates', { offset, timeout: 30, allowed_updates: UPDATES });
      for (const up of ups) { offset = up.update_id + 1; await handleUpdate(up); }
    } catch (e) {
      console.error('[tg] polling:', e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// Запуск на обычном сервере: polling или вебхук
async function start() {
  if (!config.telegram.token) return console.log('[tg] TG_TOKEN не задан — Telegram выключен');
  if (config.telegram.mode === 'webhook') {
    const st = await connect();
    console.log(`[tg] бот @${st.username} подключён через вебхук`);
  } else {
    const me = await api('getMe');
    await setup();
    console.log(`[tg] бот @${me.username} запущен (polling)`);
    poll();
  }
}

// Вебхук: проверяем секрет из заголовка и обрабатываем до ответа
async function webhook(headers, body) {
  if (headers['x-telegram-bot-api-secret-token'] !== config.telegram.webhookSecret) return false;
  await handleUpdate(body);
  return true;
}

module.exports = { start, connect, status, send, edit, handleUpdate, webhook, render, api, stop: () => { stopped = true; } };
