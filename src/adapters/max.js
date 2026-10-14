// Адаптер MAX Bot API (platform-api2.max.ru): апдейты → события бота, экраны → сообщения.
// Схема: github.com/max-messenger/api-schema. Токен — в заголовке Authorization.
const config = require('../config');
const bot = require('../bot');

async function api(method, path, query, body) {
  const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null)).toString() : '';
  const res = await fetch(config.max.api + path + qs, {
    method,
    headers: { Authorization: config.max.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(path === '/updates' ? 45000 : 15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${json.code || res.status} ${json.message || ''}`);
  return json;
}

// Экран → NewMessageBody
function render(view) {
  const body = { text: (view.text || ' ').slice(0, 4000), format: 'html' };
  const rows = (view.buttons || []).map(r => r.map(b => {
    if (b.url) return { type: 'link', text: b.text, url: b.url };
    if (b.app) {
      if (config.max.botName) return { type: 'open_app', text: b.text, web_app: config.max.botName };
      return config.publicUrl ? { type: 'link', text: b.text, url: config.appUrl('max') } : null;
    }
    if (b.contact) return { type: 'request_contact', text: b.text };
    if (b.location) return { type: 'request_geo_location', text: b.text };
    return { type: 'callback', text: b.text.slice(0, 128), payload: String(b.cb).slice(0, 1024) };
  }).filter(Boolean)).filter(r => r.length).slice(0, 30);
  body.attachments = rows.length ? [{ type: 'inline_keyboard', payload: { buttons: rows } }] : [];
  return body;
}

function targetQuery(target) {
  return target.chatId ? { chat_id: target.chatId } : { user_id: target.userId };
}

async function send(target, view) {
  const r = await api('POST', '/messages', targetQuery(target), render(view));
  return { msgId: r.message && r.message.body ? r.message.body.mid : null };
}

async function edit(target, msgId, view) {
  await api('PUT', '/messages', { message_id: msgId }, render(view));
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
      const r = await api('GET', '/updates', { timeout: 30, limit: 100, marker: marker ?? undefined, types: 'message_created,message_callback,bot_started' });
      for (const up of r.updates || []) await handleUpdate(up);
      if (r.marker !== undefined && r.marker !== null) marker = r.marker;
    } catch (e) {
      console.error('[max] polling:', e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

async function start() {
  if (!config.max.token) return console.log('[max] MAX_TOKEN не задан — MAX выключен');
  const me = await api('GET', '/me');
  console.log(`[max] бот ${me.username || me.name || me.user_id} запущен (${config.max.mode})`);
  if (!config.max.botName && me.username) config.max.botName = me.username;
  if (config.max.mode === 'webhook') {
    await api('POST', '/subscriptions', null, { url: `${config.publicUrl}/webhook/max`, update_types: ['message_created', 'message_callback', 'bot_started'], secret: config.max.webhookSecret });
  } else {
    poll();
  }
}

function webhook(headers, body) {
  if (headers['x-max-bot-api-secret'] !== config.max.webhookSecret) return false;
  handleUpdate(body);
  return true;
}

module.exports = { start, send, edit, handleUpdate, webhook, render, api, phoneFromContact, stop: () => { stopped = true; } };
