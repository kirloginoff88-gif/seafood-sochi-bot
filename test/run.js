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
  PUBLIC_URL: 'https://bot.example.ru', GEOCODE: '0', MANAGER_PIN: '4821', ADMIN_PASSWORD: 'secret-pass', PORT: '0',
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
    assert.ok(sent.url.startsWith('https://platform-api.max.ru/messages?chat_id=321'));
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
    const hello = calls.find(c => c.url.endsWith('sendPhoto'));
    assert.ok(hello && /Seafood Сочи/.test(hello.body.caption), 'приветствие с баннером ушло до того, как вебхук вернул 200');
    assert.equal(hello.body.photo, 'https://bot.example.ru/static/welcome.jpg');
    assert.ok(hello.body.reply_markup.inline_keyboard.length > 2, 'у приветствия есть кнопки меню');
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
    const home = await req('GET', '/');
    assert.equal(home.status, 302); assert.equal(home.headers.location, '/app/', 'главная ведёт в магазин');

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

test('бонусы и приглашения: подарок другу, оплата бонусами, кешбэк, награда, возврат при отмене', async () => {
  const orders = require('../src/orders');
  const loyalty = require('../src/loyalty');
  await db.set('bot:tg:username', 'seafood_test_bot');

  // владелец ссылки открывает кабинет
  let c = await say('tg', 2001, 2001, { type: 'start', payload: '' });
  assert.ok(flat(last(c)).some(b => b.cb === 'acc'), 'в меню есть кабинет');
  c = await say('tg', 2001, 2001, { type: 'callback', data: 'acc' });
  const code = await loyalty.refCode('tg', '2001');
  assert.match(code, /^[A-Z2-9]{6}$/);
  assert.match(last(c).text, new RegExp(`t\\.me/seafood_test_bot\\?start=ref_${code}`));
  assert.ok(flat(last(c)).some(b => b.url && b.url.startsWith('https://t.me/share/url')), 'кнопка «Пригласить друга»');

  // друг приходит по ссылке
  outbox.length = 0;
  c = await say('tg', 2002, 2002, { type: 'start', payload: `ref_${code}` });
  assert.match(c.replies[0].text, /дарим <b>300 бонусов/);
  assert.equal((await loyalty.get('tg', '2002')).balance, 300);
  assert.ok(outbox.some(m => m.target.userId === '2001' && /По вашей ссылке пришёл друг/.test(m.view.text)), 'пригласивший уведомлён');
  assert.equal(await loyalty.applyReferral('tg', '2002', code), null, 'повторно подарок не даём');
  assert.equal(await loyalty.applyReferral('tg', '2001', code), null, 'сам себя пригласить нельзя');
  assert.equal((await loyalty.get('tg', '2001')).refCount, 1);

  // оформление в чате: переключатель «списать бонусы»
  await patchUser('tg', '2002', { cart: { 41: 1, 76: 1 }, step: 'confirm', draft: { name: 'Олег', phone: '+79180000001', address: 'Навагинская, 1', time: 'Как можно скорее', pay: 'Наличными' } });
  c = await say('tg', 2002, 2002, { type: 'callback', data: 'bu' });
  assert.match(last(c).text, /Бонусами: −300 ₽/);
  assert.match(last(c).text, /К оплате: 8 050 ₽/);
  c = await say('tg', 2002, 2002, { type: 'callback', data: 'ok' });
  const id = +last(c).text.match(/№(\d+)/)[1];
  let o = await store.order(id);
  assert.equal(o.bonusUsed, 300); assert.equal(o.toPay, 8050);
  assert.equal((await loyalty.get('tg', '2002')).balance, 0, 'бонусы списаны');

  // доставлен → кешбэк 5% с оплаченного и награда пригласившему, повтор не удваивает
  outbox.length = 0;
  await orders.setStatus(id, 'done', 'тест');
  await orders.setStatus(id, 'done', 'тест');
  assert.equal((await loyalty.get('tg', '2002')).balance, Math.floor(8050 * 0.05));
  assert.equal((await loyalty.get('tg', '2001')).balance, 500);
  assert.ok(outbox.some(m => m.target.userId === '2001' && /начислили <b>500 бонусов/.test(m.view.text)));
  assert.equal((await store.order(id)).bonusEarned, 402);

  // второй заказ с бонусами отменён — бонусы вернулись
  const r = await orders.create({ platform: 'tg', userId: '2002', chatId: '2002', cart: { 41: 1 }, name: 'Олег', phone: '+79180000001', address: 'Навагинская, 1', useBonus: true });
  assert.ok(r.ok);
  assert.equal(r.order.bonusUsed, Math.min(402, Math.floor(2850 * 0.3)));
  assert.equal((await loyalty.get('tg', '2002')).balance, 402 - r.order.bonusUsed);
  await orders.setStatus(r.order.id, 'canceled', 'тест');
  await orders.setStatus(r.order.id, 'canceled', 'тест');
  assert.equal((await loyalty.get('tg', '2002')).balance, 402, 'возврат ровно один раз');
  assert.equal((await loyalty.get('tg', '2001')).balance, 500, 'награда за друга — только один раз');

  // мини-приложение: друг из MAX по ссылке startapp, кабинет в сессии
  const { srv, req } = await startServer({ vercel: true });
  try {
    const initData = sign({ auth_date: String(Math.floor(Date.now() / 1000)), start_param: `ref_${code}`, user: JSON.stringify({ id: 3003, first_name: 'Вера' }) }, 'max-test-token');
    const ses = await req('POST', '/api/session', { platform: 'max', initData });
    assert.equal(ses.body.gift.welcome, 300, 'подарок по ссылке из приложения');
    assert.equal(ses.body.account.bonus.balance, 300);
    assert.equal(ses.body.account.bonus.maxPay, 30);
    assert.match(ses.body.account.ref.link, /^https:\/\/max\.ru\/seafood_sochi_bot\?start=ref_/);
    const again = await req('POST', '/api/session', { platform: 'max', initData });
    assert.equal(again.body.gift, null);
    const ord = await req('POST', '/api/order', { platform: 'max', initData, cart: { 41: 1 }, order: { name: 'Вера', phone: '+79180000003', address: 'Курортный пр., 1', useBonus: true } });
    assert.equal(ord.body.bonusUsed, 300); assert.equal(ord.body.toPay, 2550);
    const acc = await req('POST', '/api/account', { platform: 'max', initData });
    assert.equal(acc.body.account.bonus.balance, 0);
    assert.equal(acc.body.account.orders[0].id, ord.body.id);
    assert.equal(acc.body.account.history[0].amount, -300);
    assert.equal((await req('POST', '/api/account', { platform: 'web' })).status, 401);
  } finally { srv.close(); }
});

test('акции: стартовые баннеры, даты показа, админка, покупатели и ручные бонусы', async () => {
  const server = require('../src/server');
  assert.ok(server.publicCatalog().promos.length >= 3, 'стартовые акции видны в магазине');
  const { srv, req } = await startServer({ vercel: REDIS });
  try {
    assert.equal((await req('POST', '/admin/api/promo/save', { promo: { title: 'x' } })).status, 401);
    assert.equal((await req('POST', '/admin/api/login', { password: 'secret-pass' })).status, 200);
    // новая акция с картинкой, ведёт на товар, всплывает
    const up = await req('POST', '/admin/api/upload', { full: dataUrl(JPEG), thumb: dataUrl(JPEG) });
    let r = await req('POST', '/admin/api/promo/save', { promo: { title: 'Креветки −15%', text: 'До воскресенья', badge: '−15%', image: up.body.image, link_type: 'product', link_id: '41', popup: 1 } });
    assert.equal(r.status, 200);
    const id = r.body.promo.id;
    assert.equal(r.body.promos[0].id, id, 'новая акция — первой');
    let pub = server.publicCatalog().promos;
    assert.equal(pub[0].title, 'Креветки −15%'); assert.equal(pub[0].popup, 1);
    assert.equal((await req('POST', '/admin/api/promo/save', { promo: { title: 'Плохо', link_type: 'product', link_id: '99999' } })).status, 422);
    assert.equal((await req('POST', '/admin/api/promo/save', { promo: { title: 'Плохо', from: '2026-10-10', to: '2026-10-01' } })).status, 422);
    // будущая и выключенная не показываются
    await req('POST', '/admin/api/promo/save', { promo: { title: 'Будущая', from: '2099-01-01' } });
    r = await req('POST', '/admin/api/promo/save', { promo: { ...r.body.promo, active: 0 } });
    pub = server.publicCatalog().promos.map(x => x.title);
    assert.ok(!pub.includes('Будущая') && !pub.includes('Креветки −15%'));
    r = await req('POST', '/admin/api/promo/move', { id, dir: 1 });
    assert.equal(r.body.promos[2].id, id, 'сдвинули ниже на одну позицию (выше — «Будущая»)');
    r = await req('POST', '/admin/api/promo/delete', { id });
    assert.ok(!r.body.promos.some(x => x.id === id));
    assert.equal(await media.read(up.body.image), null, 'картинка удалённой акции удалена');
    // бот показывает акции
    const c = await say('tg', 2001, 2001, { type: 'callback', data: 'sale' });
    assert.match(last(c).text, /Приведи друга/);
    assert.ok(flat(last(c)).some(b => b.cb === 'acc'));

    // настройки бонусов
    r = await req('POST', '/admin/api/settings/save', { settings: { bonus_cashback: '7', bonus_max_pay: '150' } });
    assert.equal(r.body.settings.bonus_cashback, '7'); assert.equal(r.body.settings.bonus_max_pay, '100');
    await req('POST', '/admin/api/settings/save', { settings: { bonus_cashback: '5', bonus_max_pay: '30' } });

    // покупатели и ручное начисление
    r = await req('GET', '/admin/api/customers');
    const owner = r.body.customers.find(x => x.key === 'tg:2001');
    assert.equal(owner.balance, 500); assert.equal(owner.refCount, 2, 'друг из Telegram и подруга из MAX');
    outbox.length = 0;
    r = await req('POST', '/admin/api/customer/bonus', { key: 'tg:2001', amount: 250, reason: 'Извинение за задержку' });
    assert.equal(r.body.balance, 750);
    assert.ok(outbox.some(m => m.target.userId === '2001' && /Извинение за задержку/.test(m.view.text)));
    assert.equal((await req('POST', '/admin/api/customer/bonus', { key: 'tg:nobody', amount: 5 })).status, 404);
    r = await req('GET', '/admin/api/customer?key=tg:2001');
    assert.equal(r.body.history[0].amount, 250);
  } finally { srv.close(); }
});

test('зоны доставки: расчёт стоимости, заказ с точкой, админка, плитки карты', async () => {
  const Z = require('../src/shared/zones');
  const orders = require('../src/orders');
  const zones = catalog.get().zones;
  assert.ok(zones.length >= 3, 'стартовые зоны есть');
  const center = { lat: 43.5855, lon: 39.7231 }; // Центр Сочи
  const zc = Z.find(zones, center.lat, center.lon);
  assert.equal(zc.id, 'z-center');
  assert.equal(Z.cost(zc, 2500).price, 300);
  assert.equal(Z.cost(zc, 3000).price, 0, 'бесплатно от порога');
  assert.equal(Z.find(zones, 45.03, 38.97), null, 'Краснодар вне зон');
  assert.match(Z.tariff(zc), /Бесплатно от 3\s000\s₽, иначе 300\s₽/);
  assert.equal(Z.find(zones, 43.43, 39.935).id, 'z-south', 'Адлер');

  // заказ с точкой: доставка в итоге, менеджер видит ссылку на карту
  outbox.length = 0;
  let r = await orders.create({ platform: 'tg', userId: '4001', chatId: '4001', cart: { 41: 1 }, name: 'Ян', phone: '+79180000004', address: 'Навагинская, 1', geo: center });
  assert.equal(r.order.delivery.name, 'Центр Сочи');
  assert.equal(r.order.delivery.price, 300);
  assert.equal(r.order.toPay, 2850 + 300);
  assert.match(orders.customerText(r.order), /Доставка \(Центр Сочи\): 300 ₽/);
  assert.ok(outbox.some(m => /yandex\.ru\/maps\/\?pt=39\.7231,43\.5855/.test(m.view.text)));
  // вне зон — принимаем с пометкой; при строгом режиме — отказ
  r = await orders.create({ platform: 'tg', userId: '4001', chatId: '4001', cart: { 41: 1 }, name: 'Ян', phone: '+79180000004', address: 'Краснодар', geo: { lat: 45.03, lon: 38.97 } });
  assert.equal(r.order.delivery.outside, true);
  // точка из геометки бота распознаётся без поиска адреса
  const d = await orders.deliveryFor(null, 'Геоточка: https://yandex.ru/maps/?pt=39.7231,43.5855&z=17&l=map', 5000);
  assert.equal(d.delivery.name, 'Центр Сочи'); assert.equal(d.delivery.price, 0);

  const { srv, req } = await startServer({ vercel: REDIS });
  try {
    const cat = await req('GET', '/api/catalog');
    assert.ok(cat.body.zones.length >= 3 && cat.body.zones[0].polygon.length >= 3, 'зоны с контурами отдаются магазину');
    assert.match((await req('GET', '/static/zones.js')).body, /tariff/);
    assert.match((await req('GET', '/static/leaflet.js')).body, /Leaflet/);
    assert.equal((await req('GET', '/static/../src/config.js')).status, 404);
    assert.equal((await req('GET', '/tiles/12/2000/2000.png')).status, 404, 'плитки вне Сочи не отдаём');
    assert.equal(require('../src/tiles').allowed(12, 2500, 1504), true, 'плитка Сочи разрешена');

    await req('POST', '/admin/api/login', { password: 'secret-pass' });
    assert.equal((await req('POST', '/admin/api/zone/save', { zone: { name: 'Пусто', polygon: [[43.5, 39.7]] } })).status, 422);
    let a = await req('POST', '/admin/api/zone/save', { zone: { name: 'Сириус', color: '#2F6FCB', price: 0, polygon: [[43.39, 39.93], [43.42, 39.93], [43.42, 39.98], [43.39, 39.98]] } });
    assert.equal(a.status, 200);
    const id = a.body.zone.id;
    assert.equal(a.body.zones.at(-1).id, id);
    a = await req('POST', '/admin/api/zone/move', { id, dir: -1 });
    a = await req('POST', '/admin/api/settings/save', { settings: { zone_strict: '1' } });
    r = await orders.create({ platform: 'tg', userId: '4001', chatId: '4001', cart: { 41: 1 }, name: 'Ян', phone: '+79180000004', address: 'Краснодар', geo: { lat: 45.03, lon: 38.97 } });
    assert.equal(r.ok, false); assert.match(r.errors[0], /вне зоны доставки/);
    await req('POST', '/admin/api/settings/save', { settings: { zone_strict: '0' } });
    a = await req('POST', '/admin/api/zone/delete', { id });
    assert.ok(!a.body.zones.some(z => z.id === id));
  } finally { srv.close(); }
});

test('напоминание о брошенной корзине: через N часов, второе через сутки, не ночью, не после заказа', async () => {
  const reminders = require('../src/reminders');
  await db.del('carts');
  let c = await say('tg', 5001, 5001, { type: 'callback', data: 'a:41' });
  const u = await store.getUser('tg', '5001');
  assert.ok(u.cartAt, 'время изменения корзины запомнили');
  const day = new Date('2026-10-20T08:00:00Z').getTime(); // 11:00 в Сочи
  await patchUser('tg', '5001', { cartAt: day - 3600e3 });
  outbox.length = 0;
  let r = await reminders.run({ now: day });
  assert.equal(r.sent, 0, 'рано: прошёл час из трёх'); assert.equal(r.waiting, 1);
  r = await reminders.run({ now: day + 2.1 * 3600e3 });
  assert.equal(r.sent, 1);
  const msg = outbox.find(m => m.target.chatId === '5001');
  assert.match(msg.view.text, /🛒 У вас 1 товар в корзине!/);
  assert.match(msg.view.text, /менеджер закрепил партию и окно доставки/);
  assert.ok(flat(msg.view).some(b => b.app === 'cart') && flat(msg.view).some(b => b.cb === 'cart'));
  outbox.length = 0;
  r = await reminders.run({ now: day + 3 * 3600e3 });
  assert.equal(r.sent, 0, 'повторно сразу не шлём');
  r = await reminders.run({ now: day + 23.5 * 3600e3 }); // сутки с изменения корзины, 10:30 по Сочи
  assert.equal(r.sent, 1, 'второе — через сутки');
  assert.match(outbox.at(-1).view.text, /^⏰/);
  r = await reminders.run({ now: day + 3 * 24 * 3600e3 });
  assert.equal(r.sent, 0, 'больше двух раз не беспокоим');

  // ночью ждём; после заказа не пишем
  c = await say('tg', 5002, 5002, { type: 'callback', data: 'a:41' });
  await patchUser('tg', '5002', { cartAt: day - 10 * 3600e3 });
  r = await reminders.run({ now: new Date('2026-10-20T20:00:00Z').getTime() }); // 23:00 в Сочи
  assert.equal(r.skipped, 'ночь');
  await patchUser('tg', '5002', { cart: {} });
  r = await reminders.run({ now: day });
  assert.equal(r.sent, 0);

  // ручной запуск по ключу
  const { srv, req } = await startServer({ vercel: true });
  try {
    assert.equal((await req('GET', '/cron/reminders?key=wrong')).status, 403);
    assert.equal((await req('GET', '/cron/reminders?key=' + config.cronSecret)).body.ok, true);
  } finally { srv.close(); }
});

test('оформление бота: приветствие с баннером, описание, аватар', async () => {
  const branding = require('../src/branding');
  const w = branding.welcome('Анна');
  assert.match(w.text, /^Здравствуйте, Анна! 👋/);
  assert.match(w.text, /<b>Seafood Сочи<\/b>/);
  assert.match(w.text, /Кешбэк 5%/);
  assert.equal(w.photo, 'https://bot.example.ru/static/welcome.jpg');
  const tg = require('../src/adapters/telegram');
  hub.register('tg', tg);
  try {
    const calls = [];
    global.fetch = async (url, opt = {}) => { calls.push({ url: String(url), body: opt.body }); return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) }; };
    const r = await branding.apply({ photo: true });
    assert.deepEqual(r.tg, { name: true, description: true, short: true, commands: true, photo: true });
    const desc = JSON.parse(calls.find(c => c.url.endsWith('setMyDescription')).body);
    assert.match(desc.description, /Нажмите «Старт»/);
    assert.ok(desc.description.length <= 512);
    const photo = calls.find(c => c.url.endsWith('setMyProfilePhoto'));
    assert.ok(photo.body instanceof FormData, 'аватар загружается файлом');
    assert.equal(JSON.parse(photo.body.get('photo')).photo, 'attach://avatar');
  } finally { hub.register('tg', fake('tg')); global.fetch = realFetch; }
  // своё приветствие из админки
  await catalog.saveSettings({ welcome_text: 'Привет{name}! *Скидка* для вас' });
  assert.equal(branding.welcome('Олег').text, 'Привет, Олег! <b>Скидка</b> для вас');
  await catalog.saveSettings({ welcome_text: '' });
});

test('менеджер входит в админку из мини-приложения без пароля, покупатель — нет', async () => {
  const { srv, req } = await startServer({ vercel: REDIS });
  try {
    const mk = id => sign({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: 'Тест' }) }, 'max-test-token');
    // 900 подключён менеджером в чате 9000 (тест чат-бота выше)
    assert.equal((await req('POST', '/api/session', { platform: 'max', initData: mk(900) })).body.manager, true);
    assert.equal((await req('POST', '/api/session', { platform: 'max', initData: mk(555) })).body.manager, false);
    assert.equal((await req('POST', '/admin/api/login-app', { platform: 'max', initData: mk(555) })).status, 403);
    assert.equal((await req('POST', '/admin/api/login-app', { platform: 'max', initData: mk(900) + 'x' })).status, 401);
    assert.equal((await req('GET', '/admin/api/state')).status, 401);
    const ok = await req('POST', '/admin/api/login-app', { platform: 'max', initData: mk(900) });
    assert.equal(ok.status, 200);
    assert.equal((await req('GET', '/admin/api/state')).status, 200, 'кука админки выдана');
  } finally { srv.close(); }
  const c = await say('max', 900, 9000, { type: 'text', text: '/admin' });
  assert.ok(flat(last(c)).some(b => b.app === 'admin'));
  const c2 = await say('max', 555, 5550, { type: 'text', text: '/admin' });
  assert.match(last(c2).text, /доступна менеджерам/);
});
