// Автотесты без сети: имитируем апдейты Telegram и MAX, проверяем запросы к их API, мини-приложение и админку.
// Запуск: npm test — прогоняет всё дважды: на файловом хранилище и на Redis (поддельный Upstash REST).
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfbot-'));
const REDIS = process.env.TEST_BACKEND === 'redis';

// ---- поддельный Upstash Redis REST: POST / ["CMD", ...args] → { result }
const redisData = new Map(), redisLists = new Map();
let redisCalls = 0;
const redisSrv = REDIS && http.createServer((q, s) => {
  let body = ''; q.on('data', d => (body += d)); q.on('end', () => {
    const send = obj => { s.writeHead(200, { 'Content-Type': 'application/json' }); s.end(JSON.stringify(obj)); };
    if (q.headers.authorization !== 'Bearer test-redis-token') return send({ error: 'Unauthorized' });
    redisCalls++;
    const [cmd, ...a] = JSON.parse(body);
    switch (cmd) {
      case 'PING': return send({ result: 'PONG' });
      case 'GET': return send({ result: redisData.has(a[0]) ? redisData.get(a[0]) : null });
      case 'SET': { if (a.includes('NX') && redisData.has(a[0])) return send({ result: null }); redisData.set(a[0], a[1]); return send({ result: 'OK' }); }
      case 'DEL': { let n = 0; a.forEach(k => { if (redisData.delete(k) || redisLists.delete(k)) n++; }); return send({ result: n }); }
      case 'INCR': { const v = (+redisData.get(a[0]) || 0) + 1; redisData.set(a[0], String(v)); return send({ result: v }); }
      case 'LPUSH': { const l = redisLists.get(a[0]) || []; l.unshift(a[1]); redisLists.set(a[0], l); return send({ result: l.length }); }
      case 'LRANGE': { const l = redisLists.get(a[0]) || []; const st = +a[1], en = +a[2]; return send({ result: l.slice(st, en < 0 ? l.length + en + 1 : en + 1) }); }
      case 'MGET': return send({ result: a.map(k => (redisData.has(k) ? redisData.get(k) : null)) });
    }
    send({ error: 'unknown command ' + cmd });
  });
});
const REDIS_PORT = 40000 + Math.floor(Math.random() * 20000);
if (REDIS) redisSrv.listen(REDIS_PORT);

Object.assign(process.env, {
  DATA_DIR: tmp, TG_TOKEN: '123:TEST', MAX_TOKEN: 'max-test-token', MAX_BOT_NAME: 'seafood_sochi_bot',
  PUBLIC_URL: 'https://bot.example.ru', MANAGER_PIN: '4821', ADMIN_PASSWORD: 'secret-pass', PORT: '0',
  ...(REDIS ? { KV_REST_API_URL: `http://127.0.0.1:${REDIS_PORT}`, KV_REST_API_TOKEN: 'test-redis-token' } : {}),
});

const test = require('node:test');
const realFetch = global.fetch;
const assert = require('node:assert/strict');
const P = require('../src/shared/pricing');
const { sign, validate } = require('../src/initdata');
const db = require('../src/db');
const catalog = require('../src/catalog');
const media = require('../src/media');
const hub = require('../src/hub');
const bot = require('../src/bot');
const store = require('../src/store');
const config = require('../src/config');

// ---- поддельные платформы: всё, что бот отправляет, складываем в outbox
const outbox = [];
const fake = platform => ({
  send: async (target, view) => { outbox.push({ platform, target, view }); return { msgId: 'm' + outbox.length }; },
  edit: async (target, msgId, view) => { outbox.push({ platform, target, view, edit: msgId }); return { msgId }; },
});
require('../api/index'); // точка входа Vercel регистрирует настоящие адаптеры — подменяем их после
hub.register('tg', fake('tg'));
hub.register('max', fake('max'));

function mkCtx() {
  const out = { replies: [], edits: [], toasts: [] };
  out.ctx = { reply: async v => out.replies.push(v), edit: async v => out.edits.push(v), toast: async t => out.toasts.push(t) };
  return out;
}
const user = (id, name = 'Анна') => ({ id: String(id), name, username: 'anna' });
async function say(platform, uid, chatId, ev) {
  const c = mkCtx();
  await bot.handle({ platform, user: user(uid), chatId: String(chatId), ...ev }, c.ctx);
  return c;
}
const last = c => c.edits.at(-1) || c.replies.at(-1);
const flat = v => (v.buttons || []).flat();
async function patchUser(platform, id, patch) { const u = await store.getUser(platform, id); Object.assign(u, patch); await store.saveUser(u); }

// HTTP-сервер приложения для тестов; vercel=true — имитирует Vercel, где тело уже прочитано в req.body
async function startServer({ vercel = false } = {}) {
  const server = require('../src/server');
  const vercelHandler = require('../api/index');
  const srv = http.createServer((req, res) => {
    if (!vercel) return server.handle(req, res);
    let b = ''; req.on('data', d => (b += d)); req.on('end', () => { req.body = b ? JSON.parse(b) : undefined; vercelHandler(req, res); });
  });
  await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  let cookie = '';
  const req = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request(base + p, { method, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const sc = res.headers['set-cookie']; if (sc) cookie = sc[0].split(';')[0];
        resolve({ status: res.statusCode, headers: res.headers, buf, body: /json/.test(res.headers['content-type'] || '') ? JSON.parse(buf.toString()) : buf.toString() });
      });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  return { srv, req, setCookie: c => (cookie = c) };
}
function mockFetch(handler) {
  const calls = [];
  global.fetch = async (url, opt = {}) => {
    const call = { url: String(url), method: opt.method || 'GET', headers: opt.headers || {}, body: opt.body ? JSON.parse(opt.body) : null };
    calls.push(call);
    const json = handler(call) || {};
    return { ok: true, status: 200, json: async () => json };
  };
  return calls;
}
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const dataUrl = buf => 'data:image/jpeg;base64,' + buf.toString('base64');

test.before(async () => {
  if (REDIS) await new Promise(r => (redisSrv.listening ? r() : redisSrv.once('listening', r)));
  await catalog.sync();
});

test(`хранилище: ${db.kind}`, async () => {
  assert.equal(db.kind, REDIS ? 'redis' : 'file');
  assert.ok(await db.ping());
  assert.equal(catalog.get().products.length, 109, 'каталог создан из стартового наполнения');
  assert.ok(await db.get('catalog'), 'каталог лежит в хранилище');
});

test('цены: развес, штучный, фасовка, акции', () => {
  const c = catalog.get();
  const herring = c.byId[48]; // филе сельди х/к, мин 300 г
  assert.equal(P.mode(herring), 'weight');
  assert.equal(P.firstQty(herring), 300);
  assert.deepEqual([P.inc(herring, 300), P.inc(herring, 500), P.inc(herring, 1000)], [500, 1000, 1500]);
  assert.equal(P.dec(herring, 500), 300);
  assert.equal(P.dec(herring, 300), 0);
  assert.equal(P.lineSum(herring, 300), 285);
  const trout = c.byId[1]; // форель 2,5–4 кг, ~3,25 кг/шт
  assert.equal(P.mode(trout), 'piece');
  assert.equal(P.lineSum(trout, 2), 3543 * 2);
  const caviar = c.byId[41];
  assert.equal(P.mode(caviar), 'pack');
  assert.equal(P.lineSum(caviar, 2), 5700);
  assert.equal(P.mode(c.byId[106]), 'weight');
  assert.equal(P.lineSum(c.byId[106], 500), 795);
  const sale = { price: 1000, sale_price: 800, sale_from: '2026-10-01', sale_to: '2026-10-20', unit: 'шт' };
  assert.equal(P.onSale(sale, new Date('2026-10-14T10:00:00Z')), true);
  assert.equal(P.onSale(sale, new Date('2026-10-21T10:00:00Z')), false);
  assert.equal(P.normQty(herring, 777), 1000);
  assert.equal(P.normQty(herring, 100), 0);
});

test('initData: подпись Telegram/MAX проверяется, подделка отклоняется', () => {
  const now = Math.floor(Date.now() / 1000);
  const s = sign({ auth_date: String(now), query_id: 'AA', user: JSON.stringify({ id: 77, first_name: 'Иван' }) }, '123:TEST');
  assert.equal(validate(s, '123:TEST').user.id, 77);
  assert.equal(validate(s, 'другой токен'), null);
  assert.equal(validate(s.replace('77', '78'), '123:TEST'), null);
  assert.equal(validate(s + 'x', '123:TEST'), null);
  const old = sign({ auth_date: String(now - 3 * 86400), user: JSON.stringify({ id: 1 }) }, '123:TEST');
  assert.equal(validate(old, '123:TEST'), null);
});

test('чат-бот: от /start до заказа, менеджер подтверждает и взвешивает', async () => {
  let c = await say('max', 900, 9000, { type: 'text', text: '/manager 0000' });
  assert.match(last(c).text, /Неверный код/);
  c = await say('max', 900, 9000, { type: 'text', text: '/manager 4821' });
  assert.match(last(c).text, /подключены как менеджер/);

  c = await say('tg', 1, 1, { type: 'start', payload: '' });
  assert.match(last(c).text, /Seafood Сочи/);
  assert.ok(flat(last(c)).some(b => b.app), 'есть кнопка мини-приложения');

  c = await say('tg', 1, 1, { type: 'callback', data: 'cats' });
  assert.ok(flat(last(c)).some(b => b.cb === 'c:fresh:0'));
  c = await say('tg', 1, 1, { type: 'callback', data: 'c:frozen:0' });
  assert.ok(flat(last(c)).some(b => b.cb === 'c:frozen:1'), 'длинный раздел разбит на страницы');

  c = await say('tg', 1, 1, { type: 'callback', data: 'p:1' });
  assert.match(last(c).text, /1 шт/);
  c = await say('tg', 1, 1, { type: 'callback', data: 'q:1:+' });
  assert.match(last(c).text, /2 шт/, 'выбор количества сохраняется между нажатиями');
  c = await say('tg', 1, 1, { type: 'callback', data: 'a:1' });
  assert.match(c.toasts[0], /Добавлено: 2 шт/);
  assert.deepEqual((await store.getUser('tg', '1')).cart, { 1: 2 });

  await patchUser('tg', '1', { cart: { 48: 300 } });
  c = await say('tg', 1, 1, { type: 'callback', data: 'cart' });
  assert.match(last(c).text, /Минимальный заказ/);
  assert.ok(!flat(last(c)).some(b => b.cb === 'co'));
  await patchUser('tg', '1', { cart: { 1: 2, 48: 300 } });

  c = await say('tg', 1, 1, { type: 'text', text: 'креветки' });
  assert.match(last(c).text, /Нашёл \d+/);

  c = await say('tg', 1, 1, { type: 'callback', data: 'co' });
  assert.match(last(c).text, /Шаг 1 из 6/);
  c = await say('tg', 1, 1, { type: 'callback', data: 'nm' });
  assert.match(last(c).text, /Шаг 2 из 6/);
  assert.ok(flat(last(c)).some(b => b.contact), 'кнопка «Отправить номер»');
  assert.equal((await store.getUser('tg', '1')).replyMap['✖️ Отменить'], 'cx', 'запомнили текст кнопки обычной клавиатуры');
  c = await say('tg', 1, 1, { type: 'text', text: '123' });
  assert.match(last(c).text, /номер неполный/);
  c = await say('tg', 1, 1, { type: 'contact', phone: '+79181234567' });
  assert.equal(c.replies[0].removeKeyboard, true, 'клавиатура с номером убирается');
  assert.match(last(c).text, /Шаг 3 из 6/);
  c = await say('tg', 1, 1, { type: 'text', text: 'Навагинская, 9, кв 12' });
  assert.match(last(c).text, /Шаг 4 из 6/);
  c = await say('tg', 1, 1, { type: 'callback', data: 't:1' });
  assert.match(last(c).text, /Шаг 5 из 6/);
  c = await say('tg', 1, 1, { type: 'callback', data: 'py:2' });
  c = await say('tg', 1, 1, { type: 'text', text: 'Разделать на стейки' });
  assert.match(last(c).text, /Проверьте заказ/);
  assert.match(last(c).text, /Разделать на стейки/);

  outbox.length = 0;
  c = await say('tg', 1, 1, { type: 'callback', data: 'ok' });
  assert.match(last(c).text, /Заказ №\d+ принят/);
  const id = +last(c).text.match(/№(\d+)/)[1];
  assert.ok(id > 1000);
  const o = await store.order(id);
  assert.equal(o.sum, 3543 * 2 + 285);
  assert.equal(o.pay, 'По QR-коду');
  const mgr = outbox.find(m => m.platform === 'max' && m.target.chatId === '9000');
  assert.ok(mgr, 'менеджер в MAX получил карточку заказа до ответа покупателю');
  assert.match(mgr.view.text, /Заказ №\d+/);
  const u1 = await store.getUser('tg', '1');
  assert.equal(Object.keys(u1.cart).length, 0, 'корзина очищена');
  assert.deepEqual(u1.orderIds, [id]);
  assert.equal(u1.profile.phone, '+79181234567');

  outbox.length = 0;
  c = await say('max', 900, 9000, { type: 'callback', data: `mo:${id}:ok` });
  assert.match(last(c).text, /Подтверждён/);
  const cust = outbox.find(m => m.platform === 'tg' && m.target.chatId === '1');
  assert.match(cust.view.text, /подтверждён/);

  await say('max', 900, 9000, { type: 'callback', data: `mo:${id}:sum` });
  outbox.length = 0;
  await say('max', 900, 9000, { type: 'text', text: '7 450 ₽' });
  assert.equal((await store.order(id)).finalSum, 7450);
  assert.ok(outbox.some(m => m.platform === 'tg' && /7 450 ₽/.test(m.view.text)));

  c = await say('tg', 1, 1, { type: 'callback', data: 'my' });
  assert.match(last(c).text, new RegExp(`№${id}`));
  c = await say('tg', 1, 1, { type: 'callback', data: `rp:${id}` });
  assert.match(last(c).text, /Ваша корзина/);
});

test('вопрос менеджеру и ответ обратно покупателю', async () => {
  let c = await say('max', 5, 500, { type: 'callback', data: 'ask:43' });
  assert.match(last(c).text, /Чёрная икра/);
  outbox.length = 0;
  c = await say('max', 5, 500, { type: 'text', text: 'Есть 100 г?' });
  assert.match(last(c).text, /Передал менеджеру/);
  const q = outbox.find(m => /Вопрос из MAX/.test(m.view.text));
  const qid = flat(q.view)[0].cb.split(':')[1];
  await say('max', 900, 9000, { type: 'callback', data: `mq:${qid}` });
  outbox.length = 0;
  await say('max', 900, 9000, { type: 'text', text: 'Да, есть, 9 500 ₽' });
  const ans = outbox.find(m => m.platform === 'max' && m.target.chatId === '500');
  assert.match(ans.view.text, /Ответ менеджера/);
  assert.equal((await store.question(qid)).answered, true);
});

test('MAX: кнопки, ответ на нажатие через /answers, контакт из vcf', async () => {
  const max = require('../src/adapters/max');
  const body = max.render({ text: 'x', buttons: [[{ text: 'Магазин', app: true }], [{ text: 'Номер', contact: true }], [{ text: 'Гео', location: true }], [{ text: 'A', cb: 'cats' }, { text: 'WA', url: 'https://wa.me/7' }]] });
  assert.equal(body.format, 'html');
  const kb = body.attachments[0];
  assert.equal(kb.type, 'inline_keyboard');
  assert.deepEqual(kb.payload.buttons[0][0], { type: 'open_app', text: 'Магазин', web_app: 'seafood_sochi_bot' });
  assert.equal(kb.payload.buttons[1][0].type, 'request_contact');
  assert.equal(kb.payload.buttons[2][0].type, 'request_geo_location');
  assert.deepEqual(kb.payload.buttons[3][0], { type: 'callback', text: 'A', payload: 'cats' });
  assert.equal(kb.payload.buttons[3][1].type, 'link');
  assert.equal(max.phoneFromContact({ vcf_info: 'BEGIN:VCARD\r\nVERSION:3.0\r\nTEL;TYPE=cell:79181112233\r\nEND:VCARD' }), '+79181112233');

  hub.register('max', max);
  try {
    const calls = mockFetch(c => (c.url.includes('/messages') && c.method === 'POST' ? { message: { body: { mid: 'mid.1' } } } : { success: true }));
    await max.handleUpdate({ update_type: 'bot_started', chat_id: 321, user: { user_id: 42, first_name: 'Олег' }, timestamp: 1 });
    const sent = calls.find(c => c.method === 'POST' && c.url.includes('/messages'));
    assert.ok(sent.url.startsWith('https://platform-api2.max.ru/messages?chat_id=321'));
    assert.equal(sent.headers.Authorization, 'max-test-token');
    assert.match(sent.body.text, /Seafood Сочи/);

    calls.length = 0;
    await max.handleUpdate({ update_type: 'message_callback', timestamp: 2, callback: { callback_id: 'cb-1', payload: 'p:1', user: { user_id: 42, first_name: 'Олег' } }, message: { recipient: { chat_id: 321, chat_type: 'dialog' }, body: { mid: 'mid.1' } } });
    await max.handleUpdate({ update_type: 'message_callback', timestamp: 3, callback: { callback_id: 'cb-2', payload: 'q:1:+', user: { user_id: 42, first_name: 'Олег' } }, message: { recipient: { chat_id: 321, chat_type: 'dialog' }, body: { mid: 'mid.2' } } });
    const answer = calls.find(c => c.url.includes('/answers?callback_id=cb-2'));
    assert.ok(answer, 'нажатие подтверждено через /answers');
    assert.match(answer.body.message.text, /2 шт/, 'карточка обновлена в том же сообщении');

    await patchUser('max', '42', { step: 'phone' });
    await max.handleUpdate({ update_type: 'message_created', timestamp: 4, message: { sender: { user_id: 42, first_name: 'Олег' }, recipient: { chat_id: 321, chat_type: 'dialog' }, body: { mid: 'x', text: '', attachments: [{ type: 'contact', payload: { vcf_info: 'BEGIN:VCARD\r\nTEL:+7 918 111-22-33\r\nEND:VCARD' } }] } } });
    assert.equal((await store.getUser('max', '42')).draft.phone, '+79181112233');
  } finally { hub.register('max', fake('max')); global.fetch = realFetch; }
});

test('Telegram: мини-приложение в кнопке, клавиатура контакта, правка карточки', async () => {
  const tg = require('../src/adapters/telegram');
  const r1 = tg.render({ text: 'x', buttons: [[{ text: 'Магазин', app: true }], [{ text: 'A', cb: 'cats' }]] });
  assert.deepEqual(r1.reply_markup.inline_keyboard[0][0], { text: 'Магазин', web_app: { url: 'https://bot.example.ru/app/?p=tg' } });
  assert.equal(r1.parse_mode, 'HTML');
  const r2 = tg.render({ text: 'x', buttons: [[{ text: '📱 Отправить мой номер', contact: true }], [{ text: '✖️ Отменить', cb: 'cx' }]] });
  assert.equal(r2.reply_markup.keyboard[0][0].request_contact, true);
  assert.deepEqual(tg.render({ text: 'ok', removeKeyboard: true }).reply_markup, { remove_keyboard: true });

  hub.register('tg', tg);
  try {
    const calls = mockFetch(c => ({ ok: true, result: c.url.endsWith('sendMessage') ? { message_id: 10 } : true }));
    await tg.handleUpdate({ update_id: 1, callback_query: { id: 'q1', from: { id: 7, first_name: 'Ира' }, data: 'p:41', message: { message_id: 3, chat: { id: 7, type: 'private' } } } });
    await tg.handleUpdate({ update_id: 2, callback_query: { id: 'q2', from: { id: 7, first_name: 'Ира' }, data: 'q:41:+', message: { message_id: 10, chat: { id: 7, type: 'private' } } } });
    const ed = calls.find(c => c.url.endsWith('editMessageText'));
    assert.equal(ed.body.message_id, 10);
    assert.match(ed.body.text, /2 шт/);
    assert.ok(calls.some(c => c.url.endsWith('answerCallbackQuery') && c.body.callback_query_id === 'q2'));
    assert.ok(calls.every(c => c.url.startsWith('https://api.telegram.org/bot123:TEST/')));
  } finally { hub.register('tg', fake('tg')); global.fetch = realFetch; }
});

test('вебхуки: чужой секрет отклоняется, свой — обрабатывается до ответа', async () => {
  const tg = require('../src/adapters/telegram');
  hub.register('tg', tg);
  const { srv, req } = await startServer({ vercel: true });
  try {
    const calls = mockFetch(() => ({ ok: true, result: { message_id: 1 } }));
    const upd = { update_id: 5, message: { message_id: 1, chat: { id: 31, type: 'private' }, from: { id: 31, first_name: 'Пётр' }, text: '/start' } };
    assert.equal((await req('POST', '/webhook/tg', upd, { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' })).status, 403);
    assert.equal(calls.length, 0);
    assert.notEqual(config.telegram.webhookSecret, '', 'секрет выведен из токена');
    const r = await req('POST', '/webhook/tg', upd, { 'X-Telegram-Bot-Api-Secret-Token': config.telegram.webhookSecret });
    assert.equal(r.status, 200);
    assert.ok(calls.some(c => c.url.endsWith('sendMessage') && /Seafood Сочи/.test(c.body.text)), 'ответ ушёл до того, как вебхук вернул 200');
  } finally { srv.close(); hub.register('tg', fake('tg')); global.fetch = realFetch; }
});

test('API мини-приложения на Vercel: каталог, сессия, корзина, заказ', async () => {
  const { srv, req } = await startServer({ vercel: true });
  try {
    const cat = await req('GET', '/api/catalog');
    assert.ok(cat.body.products.length > 90);
    const html = await req('GET', '/app/?p=max');
    assert.match(html.body, /st\.max\.ru\/js\/max-web-app\.js/);
    assert.match((await req('GET', '/app/pricing.js')).body, /Pricing/);
    assert.equal((await req('GET', '/app/../src/config.js')).status, 404);
    assert.equal((await req('GET', '/health')).body.storage, db.kind);

    const initData = sign({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'x', user: JSON.stringify({ id: 555, first_name: 'Мария', username: 'masha' }) }, 'max-test-token');
    assert.equal((await req('POST', '/api/session', { platform: 'max', initData: initData + 'x' })).status, 401);
    const ses = await req('POST', '/api/session', { platform: 'max', initData });
    assert.equal(ses.body.user.id, '555');
    await req('PUT', '/api/cart', { platform: 'max', initData, cart: { 41: 1, 9999: 3, 43: 1 } });
    assert.deepEqual((await store.getUser('max', '555')).cart, { 41: 1 }, 'чужие и «по запросу» позиции отброшены');

    const low = await req('POST', '/api/order', { platform: 'max', initData, cart: { 99: 1 }, order: { name: 'Мария', phone: '+79180000000', address: 'Курортный пр., 50' } });
    assert.equal(low.status, 422);
    assert.match(low.body.errors.join(), /Минимальный заказ/);

    outbox.length = 0;
    const ok = await req('POST', '/api/order', { platform: 'max', initData, cart: { 41: 1, 76: 1 }, order: { name: 'Мария', phone: '+79180000000', address: 'Курортный пр., 50', time: 'Завтра 9:00–13:00', pay: 'Наличными' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.sum, 2850 + 5500);
    assert.ok(outbox.some(m => m.platform === 'max' && m.target.userId === '555' && /принят/.test(m.view.text)), 'подтверждение ушло покупателю в чат MAX');
    assert.ok(outbox.some(m => m.target.chatId === '9000' && /приложение/.test(m.view.text)), 'менеджер видит источник «приложение»');
    const u = await store.getUser('max', '555');
    assert.deepEqual(u.cart, {}); assert.equal(u.orderIds[0], ok.body.id);
  } finally { srv.close(); }
});

test('админка: вход, защита, товары, фото, категории, настройки, заказы, подключение ботов', async () => {
  const orders = require('../src/orders');
  const { srv, req, setCookie } = await startServer({ vercel: REDIS });
  try {
    assert.match((await req('GET', '/admin')).body, /управление магазином/);
    assert.equal((await req('GET', '/admin/api/state')).status, 401);
    assert.equal((await req('POST', '/admin/api/login', { password: 'nope' })).status, 401);
    setCookie('sf_admin=9999999999999.deadbeef');
    assert.equal((await req('GET', '/admin/api/state')).status, 401, 'поддельная сессия не проходит');
    const login = await req('POST', '/admin/api/login', { password: 'secret-pass' });
    assert.equal(login.status, 200);
    assert.match(login.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
    let st = await req('GET', '/admin/api/state');
    assert.equal(st.body.products.length, 109);
    assert.equal((await req('POST', '/admin/api/product/quick', { id: 1, price: 1 }, { Origin: 'https://evil.example' })).status, 403, 'запрос с чужого сайта отклонён');

    const saved = await req('POST', '/admin/api/product/save', { product: { cid: 'fresh', name: 'Дорадо охлаждённая', note: 'целая', unit: 'кг', piece_g: 400, price: 1500 } });
    assert.equal(saved.status, 200);
    const id = saved.body.product.id;
    let pub = await req('GET', '/api/catalog');
    const np = pub.body.products.find(p => p.id === id);
    assert.equal(P.mode(np), 'piece');
    assert.equal(P.lineSum(np, 2), 1200);
    assert.ok(bot.catView({ cart: {} }, 'fresh', 0).buttons.flat().some(b => b.cb === `p:${id}`), 'товар есть в разделе бота');

    let bad = await req('POST', '/admin/api/product/save', { product: { id, cid: 'fresh', name: 'Дорадо', unit: 'кг', price: 1500, sale_price: 1600 } });
    assert.equal(bad.status, 422); assert.match(bad.body.error, /ниже обычной/);
    bad = await req('POST', '/admin/api/product/save', { product: { cid: 'нет-такой', name: 'X', price: 1 } });
    assert.match(bad.body.error, /категорию/);

    await req('POST', '/admin/api/product/quick', { id, price: 1450 });
    st = await req('GET', '/admin/api/state');
    assert.equal(st.body.products.find(p => p.id === id).price, 1450);
    const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    const d = new Date(Date.now() + 3 * 3600e3);
    assert.equal(st.body.settings.price_date, `${d.getUTCDate()} ${months[d.getUTCMonth()]}`, 'дата цен обновилась сама');
    await req('POST', '/admin/api/product/quick', { id, out: true });
    pub = await req('GET', '/api/catalog');
    assert.ok(!pub.body.products.some(p => p.id === id), 'скрытый товар не виден покупателям');
    await req('POST', '/admin/api/product/quick', { id, out: false });

    // другой экземпляр сервера (как второй serverless-инстанс) видит изменения через версию каталога
    await db.set('catalog:ver', 'changed-elsewhere');
    const doc = await db.get('catalog'); doc.products.find(p => p.id === id).price = 1399; await db.set('catalog', doc);
    pub = await req('GET', '/api/catalog');
    assert.equal(pub.body.products.find(p => p.id === id).price, 1399, 'каталог перечитан после смены версии');

    assert.equal((await req('POST', '/admin/api/upload', { full: 'data:image/jpeg;base64,' + Buffer.from('<?php echo 1;').toString('base64') })).status, 422, 'не-картинку не принимаем');
    const up = await req('POST', '/admin/api/upload', { full: dataUrl(JPEG), thumb: dataUrl(JPEG) });
    assert.match(up.body.image, /^\/media\/[a-f0-9]{16}\.jpg$/);
    const img = await req('GET', up.body.image);
    assert.equal(img.status, 200); assert.equal(img.headers['content-type'], 'image/jpeg');
    assert.ok(img.buf.equals(JPEG));
    assert.equal((await req('GET', up.body.thumb)).status, 200);
    assert.equal((await req('GET', '/media/..%2F..%2Fdata.json')).status, 404);
    const cur = (await req('GET', '/admin/api/state')).body.products.find(p => p.id === id);
    await req('POST', '/admin/api/product/save', { product: { ...cur, image: up.body.image } });
    assert.equal(catalog.get().byId[id].imageAbs, 'https://bot.example.ru' + up.body.image, 'бот получает полный адрес фото');
    const up2 = await req('POST', '/admin/api/upload', { full: dataUrl(JPEG) });
    await req('POST', '/admin/api/product/save', { product: { ...cur, image: up2.body.image } });
    assert.equal((await req('GET', up.body.image)).status, 404, 'старое фото удалено');

    const before = catalog.get().products.filter(p => p.cid === 'fresh').map(p => p.id);
    await req('POST', '/admin/api/product/move', { id: before[1], dir: -1 });
    assert.equal(catalog.get().products.filter(p => p.cid === 'fresh')[0].id, before[1]);

    const nc = await req('POST', '/admin/api/category/save', { category: { name: 'Устрицы', emoji: '🦪' } });
    const cid = nc.body.cats.find(c => c.name === 'Устрицы').cid;
    assert.equal((await req('POST', '/admin/api/category/save', { category: { name: 'устрицы' } })).status, 422, 'дубликат');
    assert.equal((await req('POST', '/admin/api/category/delete', { cid: 'fresh' })).status, 422, 'непустую не удалить');
    await req('POST', '/admin/api/category/move', { cid, dir: -1 });
    assert.equal((await req('POST', '/admin/api/category/delete', { cid })).status, 200);

    await req('POST', '/admin/api/product/delete', { id });
    assert.equal(catalog.get().byId[id], undefined);

    await req('POST', '/admin/api/settings/save', { settings: { min_order: '3000', phone_wa: '+7 (918) 407-00-78' } });
    assert.equal(orders.minOrder(), 3000);
    assert.equal(catalog.get().settings.phone_wa, '79184070078');
    await req('POST', '/admin/api/settings/save', { settings: { min_order: '2000' } });

    const r = await orders.create({ platform: 'tg', userId: '77', chatId: '77', source: 'chat', verified: true, cart: { 41: 1 }, name: 'Ольга', phone: '+79180001122', address: 'Виноградная, 2' });
    const list = await req('GET', '/admin/api/orders?filter=active');
    assert.ok(list.body.orders.some(o => o.id === r.order.id));
    outbox.length = 0;
    assert.equal((await req('POST', '/admin/api/order/status', { id: r.order.id, status: 'confirmed' })).status, 200);
    assert.ok(outbox.some(m => m.platform === 'tg' && m.target.chatId === '77' && /подтверждён/.test(m.view.text)));
    await req('POST', '/admin/api/order/sum', { id: r.order.id, sum: 2790 });
    assert.equal((await store.order(r.order.id)).finalSum, 2790);

    assert.ok(((await db.get('catalog:backups')) || []).length >= 1, 'резервная копия каталога сделана');

    // подключение ботов: правильные вызовы setWebhook и /subscriptions
    hub.register('tg', require('../src/adapters/telegram'));
    hub.register('max', require('../src/adapters/max'));
    const calls = mockFetch(c => {
      if (c.url.includes('api.telegram.org')) {
        if (c.url.endsWith('getMe')) return { ok: true, result: { username: 'seafood_test_bot' } };
        if (c.url.endsWith('getWebhookInfo')) return { ok: true, result: { url: 'https://bot.example.ru/webhook/tg', pending_update_count: 0 } };
        return { ok: true, result: true };
      }
      if (c.url.endsWith('/me')) return { user_id: 1, username: 'seafood_max_bot' };
      if (c.url.endsWith('/subscriptions') && c.method === 'GET') return { subscriptions: [{ url: 'https://bot.example.ru/webhook/max' }] };
      return { success: true };
    });
    const con = await req('POST', '/admin/api/bots/connect', {});
    assert.equal(con.status, 200);
    const hook = calls.find(c => c.url.endsWith('setWebhook'));
    assert.equal(hook.body.url, 'https://bot.example.ru/webhook/tg');
    assert.equal(hook.body.secret_token, config.telegram.webhookSecret);
    assert.ok(calls.some(c => c.url.endsWith('setChatMenuButton') && c.body.menu_button.web_app.url === 'https://bot.example.ru/app/?p=tg'));
    const sub = calls.find(c => c.url.endsWith('/subscriptions') && c.method === 'POST');
    assert.equal(sub.body.url, 'https://bot.example.ru/webhook/max');
    assert.equal(sub.body.secret, config.max.webhookSecret);
    assert.equal(con.body.tg.connected, true); assert.equal(con.body.tg.username, 'seafood_test_bot');
    assert.equal(con.body.max.connected, true);
    hub.register('tg', fake('tg')); hub.register('max', fake('max')); global.fetch = realFetch;

    await req('POST', '/admin/api/logout', {});
    assert.equal((await req('GET', '/admin/api/state')).status, 401);
  } finally { srv.close(); global.fetch = realFetch; }
});

test('перенос фото с внешнего сайта к себе', async () => {
  const imgSrv = http.createServer((q, s) => {
    if (q.url.startsWith('/img/')) { s.writeHead(200, { 'Content-Type': 'image/jpeg' }); return s.end(JPEG); }
    s.writeHead(404); s.end();
  });
  await new Promise(r => imgSrv.listen(0, r));
  try {
    const url = `http://127.0.0.1:${imgSrv.address().port}/img/products/41.jpg`;
    const raw = await catalog._raw();
    raw.products.forEach(p => { if (/^https?:/.test(p.image)) p.image = ''; });
    raw.cats.forEach(c => (c.image = ''));
    await catalog.setImage('product', 41, url);
    await catalog.setImage('product', 42, url);
    await catalog.setImage('product', 1, `http://127.0.0.1:${imgSrv.address().port}/missing.jpg`);
    const { importImages } = require('../scripts/import-images');
    const r = await importImages({ log: () => {} });
    assert.deepEqual([r.ok, r.failed, r.left], [2, 1, 0]);
    const a = catalog.get().byId[41].image, b = catalog.get().byId[42].image;
    assert.match(a, /^\/media\//); assert.equal(a, b, 'одинаковое фото скачано один раз');
    assert.ok((await media.read(a)).equals(JPEG));
  } finally { imgSrv.close(); }
});

test.after(() => {
  store.flush();
  if (REDIS) { redisSrv.close(); console.log(`# запросов к Redis: ${redisCalls}`); }
  fs.rmSync(tmp, { recursive: true, force: true });
});
