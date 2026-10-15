// Заказы: проверка корзины, сохранение, уведомления менеджерам и покупателю, Битрикс24.
const P = require('./shared/pricing');
const catalog = require('./catalog');
const store = require('./store');
const hub = require('./hub');
const b24 = require('./b24');

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const PLATFORM = { tg: 'Telegram', max: 'MAX', web: 'браузер' };

const STATUS = {
  new: { label: 'Новый', icon: '🆕' },
  confirmed: { label: 'Подтверждён', icon: '✅' },
  going: { label: 'Курьер в пути', icon: '🚗' },
  done: { label: 'Доставлен', icon: '📦' },
  canceled: { label: 'Отменён', icon: '✖️' },
};

function minOrder() { return parseInt(catalog.get().settings.min_order, 10) || 0; }

function summarize(cart) {
  const c = catalog.get();
  const r = P.cartLines(cart, c.byId);
  r.lines = r.lines.map(l => ({ ...l, name: catalog.fullName(c.byId[l.id]) }));
  return r;
}

function linesText(lines) {
  return lines.map(l => `• ${esc(l.name)} — ${l.qtyLabel} — ${l.ask ? 'цена по запросу' : (l.approx ? '≈ ' : '') + P.rub(l.sum)}`).join('\n');
}

function validate(input) {
  const errors = [];
  const name = String(input.name || '').trim().slice(0, 80);
  const phone = String(input.phone || '').trim().slice(0, 40);
  const address = String(input.address || '').trim().slice(0, 300);
  if (!name) errors.push('Укажите имя');
  if (phone.replace(/\D/g, '').length < 10) errors.push('Проверьте телефон: нужно 10–11 цифр');
  if (address.length < 5) errors.push('Укажите адрес доставки');
  const sum = summarize(input.cart || {});
  if (!sum.lines.length) errors.push('Корзина пуста');
  const min = minOrder();
  if (min && sum.sum < min) errors.push(`Минимальный заказ ${P.rub(min)}, сейчас ${P.rub(sum.sum)}`);
  return { errors, name, phone, address, sum };
}

async function create(input) {
  const v = validate(input);
  if (v.errors.length) return { ok: false, errors: v.errors };
  // Оплата бонусами: только покупателю из мессенджера и не больше разрешённой доли
  const loyalty = require('./loyalty');
  let bonusUsed = 0;
  if (input.useBonus && input.platform !== 'web' && input.userId) {
    bonusUsed = loyalty.maxSpend(await loyalty.get(input.platform, String(input.userId)), v.sum.sum);
  }
  const o = await store.newOrder({
    platform: input.platform,
    userId: input.userId ? String(input.userId) : null,
    chatId: input.chatId ? String(input.chatId) : null,
    source: input.source || 'chat',
    verified: !!input.verified,
    customer: { name: v.name, phone: v.phone, username: input.username || '' },
    address: v.address,
    time: String(input.time || 'Как можно скорее').slice(0, 80),
    pay: String(input.pay || 'При получении').slice(0, 60),
    comment: String(input.comment || '').trim().slice(0, 500),
    lines: v.sum.lines,
    sum: v.sum.sum,
    bonusUsed,
    toPay: v.sum.sum - bonusUsed,
    weighed: v.sum.weighed,
    managerMsgs: [],
  });
  if (bonusUsed) await loyalty.spend(input.platform, String(input.userId), bonusUsed, o.id);
  // Запоминаем данные для следующего заказа и чистим корзину.
  // Если вызывающий уже держит объект покупателя (input.user) — меняем его, сохранит вызывающий.
  if (input.platform !== 'web' && input.userId) {
    const u = input.user || (await store.getUser(input.platform, input.userId));
    u.cart = {}; u.pick = {};
    u.profile = { ...u.profile, name: v.name, phone: v.phone, address: v.address };
    u.orderIds = [o.id, ...(u.orderIds || [])].slice(0, 20);
    if (!input.user) await store.saveUser(u);
  }
  // Уведомления ждём до ответа: на serverless работа после ответа может не выполниться
  const [crm] = await Promise.allSettled([
    b24.pushOrder(o),
    notifyManagers(o),
  ]);
  if (crm.status === 'fulfilled' && crm.value) { o.crm = crm.value; await store.setOrder(o.id, { crm: crm.value }); }
  if (crm.status === 'rejected') console.error('[b24]', crm.reason.message);
  return { ok: true, order: o };
}

const bonusLine = o => (o.bonusUsed ? `\n💎 Бонусами: −${P.rub(o.bonusUsed)}\n<b>К оплате: ${P.rub(Math.max(0, (o.finalSum || o.sum) - o.bonusUsed))}</b>` : '');

function customerText(o) {
  return `✅ <b>Заказ №${o.id} принят!</b>\n\n${linesText(o.lines)}\n\n<b>Примерно: ${P.rub(o.sum)}</b>${bonusLine(o)}${o.weighed ? '\n<i>Весовой товар взвесим при сборке — итог подтвердит менеджер.</i>' : ''}\n\n📍 ${esc(o.address)}\n🕒 ${esc(o.time)}\n💳 ${esc(o.pay)}\n\nМенеджер свяжется с вами в течение 15 минут. Статус заказа придёт в этот чат.`;
}

function managerView(o) {
  const st = STATUS[o.status] || STATUS.new;
  const who = o.customer.username ? ` (@${esc(o.customer.username)})` : '';
  const src = `${PLATFORM[o.platform] || o.platform}, ${o.source === 'app' ? 'приложение' : o.source === 'web' ? 'браузер' : 'чат'}${o.verified ? '' : ' ⚠️ без подтверждения мессенджера'}`;
  const text = [
    `${st.icon} <b>Заказ №${o.id}</b> · ${st.label}`,
    `<i>${src}</i>`,
    '',
    `👤 ${esc(o.customer.name)}${who}`,
    `📱 ${esc(o.customer.phone)}`,
    `📍 ${esc(o.address)}`,
    `🕒 ${esc(o.time)}`,
    `💳 ${esc(o.pay)}`,
    o.comment ? `💬 ${esc(o.comment)}` : '',
    '',
    linesText(o.lines),
    '',
    `<b>Примерно: ${P.rub(o.sum)}</b>${o.finalSum ? `\n<b>Итог по весу: ${P.rub(o.finalSum)}</b>` : ''}${bonusLine(o)}`,
    o.crm ? `CRM: ${o.crm.entity === 'deal' ? 'сделка' : 'лид'} #${o.crm.id}` : '',
  ].filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n');
  const buttons = [];
  if (!['done', 'canceled'].includes(o.status)) {
    buttons.push([{ text: '✅ Подтвердить', cb: `mo:${o.id}:ok` }, { text: '⚖️ Итог по весу', cb: `mo:${o.id}:sum` }]);
    buttons.push([{ text: '🚗 Курьер выехал', cb: `mo:${o.id}:go` }, { text: '📦 Доставлен', cb: `mo:${o.id}:done` }]);
    buttons.push([{ text: '✖️ Отменить', cb: `mo:${o.id}:x` }]);
  }
  return { text, buttons };
}

async function notifyManagers(o) {
  const view = managerView(o);
  const list = await store.managers();
  if (!list.length) console.warn(`[orders] заказ №${o.id}: нет ни одного менеджера (MANAGER_PIN / *_MANAGER_CHAT_IDS)`);
  const msgs = [];
  for (const m of list) {
    const r = await hub.send(m.platform, { chatId: m.chatId }, view);
    if (r && r.msgId) msgs.push({ platform: m.platform, chatId: m.chatId, msgId: r.msgId });
  }
  o.managerMsgs = msgs;
  await store.setOrder(o.id, { managerMsgs: msgs });
}

// Обновить карточку заказа у всех менеджеров (кроме того, кто уже видит изменения через edit)
async function refreshManagerCards(o, skip) {
  const view = managerView(o);
  for (const m of o.managerMsgs || []) {
    if (skip && m.platform === skip.platform && String(m.chatId) === String(skip.chatId)) continue;
    await hub.edit(m.platform, { chatId: m.chatId }, m.msgId, view);
  }
}

function customerTarget(o) {
  return o.chatId ? { chatId: o.chatId } : { userId: o.userId };
}

async function notifyCustomer(o, text, buttons) {
  if (o.platform === 'web' || (!o.chatId && !o.userId)) return;
  await hub.send(o.platform, customerTarget(o), { text, buttons });
}

async function setStatus(id, status, by) {
  const o = await store.setOrder(id, { status, by });
  if (!o) return null;
  const msgs = {
    confirmed: `✅ <b>Заказ №${o.id} подтверждён.</b>\nДоставка: ${esc(o.time)}.${o.finalSum ? `\nИтог по весу: <b>${P.rub(o.finalSum)}</b>` : ''}`,
    going: `🚗 <b>Курьер выехал</b> с заказом №${o.id}. Позвонит перед приездом.`,
    done: `📦 Заказ №${o.id} доставлен. Спасибо, что выбрали ${esc(catalog.get().settings.brand || 'нас')}! Приятного аппетита 🐟`,
    canceled: `✖️ Заказ №${o.id} отменён. Если это ошибка — напишите нам или позвоните ${esc(catalog.get().settings.phone_tel || '')}.`,
  };
  const btn = status === 'done' ? [[{ text: '🔁 Повторить заказ', cb: `rp:${o.id}` }]] : [[{ text: '📞 Связаться с менеджером', cb: 'ct' }]];
  await notifyCustomer(o, msgs[status], btn);
  // Кешбэк, награда пригласившему, возврат бонусов при отмене
  try { await require('./loyalty').onStatus(o, status); } catch (e) { console.error('[loyalty]', e); }
  return (await store.order(o.id)) || o;
}

async function setFinalSum(id, sum, by) {
  const cur = await store.order(id);
  if (!cur) return null;
  const o = await store.setOrder(id, { finalSum: sum, toPay: Math.max(0, sum - (cur.bonusUsed || 0)), by });
  await notifyCustomer(o, `⚖️ Взвесили ваш заказ №${o.id}: итог <b>${P.rub(sum)}</b>.${o.bonusUsed ? `\nСписано бонусами: −${P.rub(o.bonusUsed)}, к оплате <b>${P.rub(o.toPay)}</b>.` : ''}\nДоставка: ${esc(o.time)}.`, [[{ text: '👍 Всё верно', cb: 'thx' }, { text: '📞 Менеджер', cb: 'ct' }]]);
  return o;
}

module.exports = { create, validate, summarize, linesText, customerText, managerView, setStatus, setFinalSum, refreshManagerCards, notifyCustomer, minOrder, STATUS, esc };
