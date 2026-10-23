// Адаптер MAX Bot API (platform-api.max.ru): апдейты → события бота, экраны → сообщения.
// Схема: github.com/max-messenger/api-schema. Токен — в заголовке Authorization.
const config = require('../config');
const bot = require('../bot');

// Основной адрес API и запасной: если один недоступен по сети — пробуем другой и запоминаем рабочий
const HOSTS = [...new Set([config.max.api, 'https://platform-api.max.ru', 'https://platform-api2.max.ru'])];
let hostIdx = 0;
async function api(method, path, query, body) {
  let lastErr;
  for (let i = 0; i < HOSTS.length; i++) {
    const host = HOSTS[(hostIdx + i) % HOSTS.length];
    try {
      const r = await call(host, method, path, query, body);
      hostIdx = (hostIdx + i) % HOSTS.length;
      return r;
    } catch (e) {
      if (!e.network) throw e;
      lastErr = e;
    }
  }
  throw new Error(`MAX API недоступен с сервера (${lastErr.message}). Возможно, MAX не пускает запросы из-за рубежа — нужен сервер в России.`);
}

async function call(host, method, path, query, body) {
  const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null)).toString() : '';
  const res = await fetch(host + path + qs, {
    method,
    headers: { Authorization: config.max.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(path === '/updates' ? 45000 : 15000),
  }).catch(e => { const err = new Error(e.cause ? `${e.message}: ${e.cause.code || e.cause.message}` : e.message); err.network = true; throw err; });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${json.code || res.status} ${json.message || ''}`);
  return json;
}

// Экран → NewMessageBody
function render(view, { noApp } = {}) {
  const body = { text: (view.text || ' ').slice(0, 4000), format: 'html' };
  const rows = (view.buttons || []).map(r => r.map(b => {
    if (b.url) return { type: 'link', text: b.text, url: b.url };
    if (b.app) {
      if (config.max.botName && !noApp && !appBroken) return { type: 'open_app', text: b.text, web_app: config.max.botName };
      return config.publicUrl ? { type: 'link', text: b.text, url: config.appUrl('max') } : null;
    }
    if (b.contact) return { type: 'request_contact', text: b.text };
    if (b.location) return { type: 'request_geo_location', text: b.text };
    return { type: 'callback', text: b.text.slice(0, 128), payload: String(b.cb).slice(0, 1024) };
  }).filter(Boolean)).filter(r => r.length).slice(0, 30);
  body.attachments = rows.length ? [{ type: 'inline_keyboard', payload: { buttons: rows } }] : [];
  if (view.photo) body.attachments.unshift({ type: 'image', payload: { url: view.photo } });
  return body;
}

function targetQuery(target) {
  return target.chatId ? { chat_id: target.chatId } : { user_id: target.userId };
}

// Если мини-приложение ещё не привязано к боту в кабинете MAX, кнопка open_app не проходит —
// тогда шлём обычную ссылку на магазин и больше не пробуем до перезапуска.
let appBroken = false;
const hasApp = view => (view.buttons || []).some(r => r.some(b => b.app));
async function withAppFallback(fn, view) {
  try { return await fn(render(view)); }
  catch (e) {
    if (e.network || !hasApp(view) || appBroken || !config.max.botName) throw e;
    console.warn('[max] кнопка мини-приложения не принята, шлём ссылку:', e.message);
    appBroken = true;
    return fn(render(view, { noApp: true }));
  }
}

async function send(target, view) {
  const r = await withAppFallback(body => api('POST', '/messages', targetQuery(target), body), view);
  return { msgId: r.message && r.message.body ? r.message.body.mid : null };
}

async function edit(target, msgId, view) {
  if (view.photo) return send(target, view); // сообщение с картинкой отправляем заново
  await withAppFallback(body => api('PUT', '/messages', { message_id: msgId }, body), view);
  return { msgId };
}

function userOf(u) {
  return { id: String(u.user_id), name: [u.first_name, u.last_name].filter(Boolean).join(' '), username: u.username || '' };
}

function phoneFromContact(payload) {
  if (!payload) return '';
  const vcf = String(payload.vcf_info || '');
  const m = vcf.match(/TEL[^:\r\n]*:([^\r\n]+)/i);
  if (m) { const d = m[1].replace(/[^\d+]/g, ''); return d.startsWith('+') ? d : '+' + d; }
  return '';
}

async function handleUpdate(up) {
  try {
    if (up.update_type === 'bot_started') {
      const chatId = String(up.chat_id);
      const ctx = { reply: v => send({ chatId }, v), edit: v => send({ chatId }, v), toast: () => Promise.resolve() };
      return await bot.handle({ platform: 'max', type: 'start', user: userOf(up.user), chatId, payload: up.payload || '' }, ctx);
    }
    if (up.update_type === 'message_created') {
      const m = up.message;
      if (!m || !m.sender || m.sender.is_bot) return;
      if (m.recipient && m.recipient.chat_type && m.recipient.chat_type !== 'dialog') return; // только личка
      const chatId = String(m.recipient.chat_id);
      const base = { platform: 'max', user: userOf(m.sender), chatId };
      const ctx = { reply: v => send({ chatId }, v), edit: v => send({ chatId }, v), toast: () => Promise.resolve() };
      const atts = (m.body && m.body.attachments) || [];
      const contact = atts.find(a => a.type === 'contact');
      const loc = atts.find(a => a.type === 'location');
      const text = (m.body && m.body.text) || '';
      let ev;
      if (contact) ev = { ...base, type: 'contact', phone: phoneFromContact(contact.payload) };
      else if (loc) ev = { ...base, type: 'location', lat: loc.latitude ?? loc.payload?.latitude, lon: loc.longitude ?? loc.payload?.longitude };
      else if (/^\/start\b/.test(text)) ev = { ...base, type: 'start', payload: text.split(/\s+/)[1] || '' };
      else if (text) ev = { ...base, type: 'text', text };
      else return;
      if (ev.type === 'contact' && !ev.phone) return ctx.reply({ text: 'Не удалось прочитать номер. Введите его текстом, пожалуйста.' });
      return await bot.handle(ev, ctx);
    }
    if (up.update_type === 'message_callback') {
      const cb = up.callback;
      const chatId = String(up.message && up.message.recipient ? up.message.recipient.chat_id : cb.user.user_id);
      // Ответ на нажатие: правка исходного сообщения и/или всплывающее уведомление — одним запросом /answers
      let answer = null;
      const ctx = {
        reply: v => send({ chatId }, v),
        edit: v => { answer = { ...(answer || {}), message: render(v) }; return Promise.resolve({ msgId: up.message?.body?.mid }); },
        toast: text => { answer = { ...(answer || {}), notification: String(text).slice(0, 200) }; return Promise.resolve(); },
      };
      await bot.handle({ platform: 'max', type: 'callback', user: userOf(cb.user), chatId, data: cb.payload }, ctx);
      if (answer) await api('POST', '/answers', { callback_id: cb.callback_id }, answer).catch(e => console.error('[max] answer:', e.message));
    }
  } catch (e) {
    console.error('[max] update error:', e.message);
  }
}

let stopped = false;
async function poll() {
  let marker = null;
  while (!stopped) {
    try {
      const r = await api('GET', '/updates', { timeout: 30, limit: 100, marker: marker ?? undefined, types: UPDATES.join(',') });
      for (const up of r.updates || []) await handleUpdate(up);
      if (r.marker !== undefined && r.marker !== null) marker = r.marker;
    } catch (e) {
      console.error('[max] polling:', e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

const UPDATES = ['message_created', 'message_callback', 'bot_started'];

// Подключить бота к этому серверу через вебхук (так работает на Vercel)
async function connect() {
  if (!config.max.token) throw new Error('MAX_TOKEN не задан');
  if (!config.publicUrl) throw new Error('Не известен публичный адрес (PUBLIC_URL)');
  await api('POST', '/subscriptions', null, { url: `${config.publicUrl}/webhook/max`, update_types: UPDATES, secret: config.max.webhookSecret });
  return status();
}

async function status() {
  if (!config.max.token) return { enabled: false };
  const me = await api('GET', '/me');
  if (!config.max.botName && me.username) config.max.botName = me.username;
  if (me.username) await require('../db').set('bot:max:username', me.username).catch(() => {}); // для кнопки мини-приложения на других экземплярах
  const subs = await api('GET', '/subscriptions').catch(() => ({ subscriptions: [] }));
  const expected = `${config.publicUrl}/webhook/max`;
  const urls = (subs.subscriptions || []).map(x => x.url);
  return { enabled: true, username: me.username || me.name || String(me.user_id), link: me.username ? `https://max.ru/${me.username}` : '', webhook: urls.join(', '), connected: urls.includes(expected), botNameSet: !!process.env.MAX_BOT_NAME };
}

// Оформление бота: имя, описание, команды, аватар (по ссылке)
async function brand({ name, description, commands, photoUrl }) {
  const body = { name: name.slice(0, 64), description: description.slice(0, 200), commands: commands.map(c => ({ name: c.command, description: c.description })) };
  if (photoUrl) body.photo = { url: photoUrl };
  await api('PATCH', '/me', null, body);
  return { ok: true, photo: !!photoUrl };
}

// Запуск на обычном сервере: polling или вебхук
async function start() {
  if (!config.max.token) return console.log('[max] MAX_TOKEN не задан — MAX выключен');
  const me = await api('GET', '/me');
  if (!config.max.botName && me.username) config.max.botName = me.username;
  if (config.max.mode === 'webhook') {
    await connect();
    console.log(`[max] бот ${me.username || me.user_id} подключён через вебхук`);
  } else {
    console.log(`[max] бот ${me.username || me.user_id} запущен (polling)`);
    poll();
  }
}

// Вебхук: проверяем секрет и обрабатываем до ответа
async function webhook(headers, body) {
  if (headers['x-max-bot-api-secret'] !== config.max.webhookSecret) return false;
  // Имя бота нужно кнопке «Открыть магазин»: если не задано в MAX_BOT_NAME — берём сохранённое при подключении
  if (!config.max.botName) config.max.botName = (await require('../db').get('bot:max:username').catch(() => '')) || '';
  await handleUpdate(body);
  return true;
}

module.exports = { brand, start, connect, status, send, edit, handleUpdate, webhook, render, api, phoneFromContact, stop: () => { stopped = true; } };
