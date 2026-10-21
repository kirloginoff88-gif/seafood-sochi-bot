/*
 * Логика бота — одна для Telegram и MAX.
 * Адаптер превращает апдейт платформы в событие ev и передаёт ctx для ответа:
 *   ev  = { platform, type: 'start'|'text'|'callback'|'contact'|'location', user: {id, name, username},
 *           chatId, text, data, payload, phone, lat, lon }
 *   ctx = { reply(view), edit(view), toast(text) }
 * Экран (view) = { text (HTML: b, i, a), buttons: [[{text, cb}|{text, url}|{text, app:true}|{text, contact:true}|{text, location:true}]], image }
 */
const P = require('./shared/pricing');
const catalog = require('./catalog');
const store = require('./store');
const orders = require('./orders');
const config = require('./config');
const loyalty = require('./loyalty');
const branding = require('./branding');
const Z = require('./shared/zones');
const { esc } = orders;

const PAGE = 10;

// ---------- экраны ----------
function cartSum(u) { return orders.summarize(u.cart); }
function cartBtnLabel(u) {
  const s = cartSum(u);
  return s.lines.length ? `🛒 Корзина · ${P.rub(s.sum)}` : '🛒 Корзина';
}

function menuView(u, greet) {
  const s = catalog.get().settings;
  const hasSales = catalog.sales().length > 0 || catalog.livePromos().length > 0;
  const w = greet ? branding.welcome(u.profile.name || u.name || '') : null;
  const text = w ? w.text : 'Главное меню. Что вас интересует?';
  const rows = [];
  if (config.publicUrl) rows.push([{ text: '🛍 Открыть магазин', app: true }]);
  rows.push(hasSales ? [{ text: '🐟 Каталог', cb: 'cats' }, { text: '🔥 Акции', cb: 'sale' }] : [{ text: '🐟 Каталог', cb: 'cats' }, { text: '🔎 Поиск', cb: 'srch' }]);
  rows.push(hasSales ? [{ text: cartBtnLabel(u), cb: 'cart' }, { text: '🔎 Поиск', cb: 'srch' }] : [{ text: cartBtnLabel(u), cb: 'cart' }]);
  rows.push([{ text: '👤 Кабинет и бонусы', cb: 'acc' }, { text: '📞 Менеджер', cb: 'ct' }]);
  rows.push((u.orderIds || []).length ? [{ text: '🚚 Доставка и оплата', cb: 'dl' }, { text: '📦 Мои заказы', cb: 'my' }] : [{ text: '🚚 Доставка и оплата', cb: 'dl' }]);
  return w && w.photo ? { text, photo: w.photo, buttons: rows } : { text, buttons: rows };
}

function catsView(u) {
  const c = catalog.get();
  const cats = c.cats.filter(x => x.count > 0);
  const rows = [];
  for (let i = 0; i < cats.length; i += 2) rows.push(cats.slice(i, i + 2).map(x => ({ text: `${x.emoji} ${x.name}`, cb: `c:${x.cid}:0` })));
  if (catalog.sales().length) rows.unshift([{ text: '🔥 Акции', cb: 'sale' }]);
  rows.push([{ text: '← Меню', cb: 'm' }, { text: cartBtnLabel(u), cb: 'cart' }]);
  const n = c.products.filter(p => !p.out).length;
  return { text: `<b>Каталог</b> · ${n} ${P.plural(n, 'позиция', 'позиции', 'позиций')}${c.settings.price_date ? `\n<i>Цены актуальны на ${esc(c.settings.price_date)}</i>` : ''}`, buttons: rows };
}

function productBtn(p) {
  const sale = P.onSale(p) ? '🔥 ' : '';
  return [{ text: `${sale}${catalog.fullName(p)} — ${P.priceText(p)}`, cb: `p:${p.id}` }];
}

function catView(u, cid, page) {
  const c = catalog.get();
  const cat = c.cats.find(x => x.cid === cid);
  if (!cat) return catsView(u);
  const items = c.products.filter(p => p.cid === cid && !p.out);
  const pages = Math.max(1, Math.ceil(items.length / PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const rows = items.slice(page * PAGE, page * PAGE + PAGE).map(productBtn);
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '‹ Назад', cb: `c:${cid}:${page - 1}` });
    nav.push({ text: `${page + 1} / ${pages}`, cb: `c:${cid}:${page}` });
    if (page < pages - 1) nav.push({ text: 'Дальше ›', cb: `c:${cid}:${page + 1}` });
    rows.push(nav);
  }
  rows.push([{ text: '← Разделы', cb: 'cats' }, { text: cartBtnLabel(u), cb: 'cart' }]);
  return { text: `<b>${cat.emoji} ${esc(cat.name)}</b> · ${items.length} поз.\nНажмите на товар, чтобы выбрать количество.`, buttons: rows, image: cat.banner };
}

function saleView(u) {
  const items = catalog.sales();
  const promos = catalog.livePromos();
  if (!items.length && !promos.length) return { text: 'Сейчас акций нет — загляните в каталог 🐟', buttons: [[{ text: '🐟 Каталог', cb: 'cats' }]] };
  const parts = ['<b>🔥 Акции и предложения</b>'];
  for (const x of promos.slice(0, 6)) parts.push(`\n${x.badge ? `[${esc(x.badge)}] ` : ''}<b>${esc(x.title)}</b>${x.to ? ` <i>до ${x.to.slice(8, 10)}.${x.to.slice(5, 7)}</i>` : ''}\n${esc(x.text)}`);
  if (items.length) parts.push(`\n<b>Скидки на товары:</b>\n${items.map(p => `• ${esc(catalog.fullName(p))}: <b>${P.priceText(p)}</b> вместо ${P.rub(p.price)} (−${P.saleOff(p)}%)`).join('\n')}`);
  const promoBtns = promos.slice(0, 6).map(promoBtn).filter(Boolean);
  const withImage = promos.find(x => x.imageAbs);
  return {
    text: parts.join('\n'),
    image: withImage ? withImage.imageAbs : undefined,
    buttons: [...promoBtns, ...items.slice(0, 20).map(productBtn), [{ text: '← Меню', cb: 'm' }, { text: cartBtnLabel(u), cb: 'cart' }]],
  };
}
// Кнопка у акции: товар, раздел, кабинет или ссылка
function promoBtn(x) {
  const t = x.btn || x.title;
  if (x.link_type === 'product') return [{ text: '👉 ' + t, cb: `p:${x.link_id}` }];
  if (x.link_type === 'category') return [{ text: '👉 ' + t, cb: `c:${x.link_id}:0` }];
  if (x.link_type === 'account') return [{ text: '👉 ' + t, cb: 'acc' }];
  if (x.link_type === 'url') return [{ text: '👉 ' + t, url: x.link_id }];
  return null;
}

// Личный кабинет: бонусы, приглашения, заказы
async function accountView(u) {
  const a = await loyalty.account(u.platform, u.userId, u);
  const b = a.bonus;
  const lines = ['<b>👤 Личный кабинет</b>', ''];
  if (b.enabled) {
    lines.push(`💎 Бонусов на счёте: <b>${a.bonus.balance}</b>`, `<i>1 бонус = 1 ₽. Оплачивайте ими до ${b.maxPay}% заказа.</i>`, '');
    lines.push('<b>Как получить бонусы</b>');
    if (b.cashback) lines.push(`• ${b.cashback}% с каждого доставленного заказа`);
    if (b.referrer || b.welcome) lines.push(`• Пригласите друга: ему ${b.welcome} бонусов на первый заказ, вам ${b.referrer} — когда он получит покупку`);
    lines.push('');
    if (a.ref.link) lines.push(`🔗 Ваша ссылка для друзей:\n${a.ref.link}`);
    else lines.push(`🔑 Ваш код приглашения: <b>${a.ref.code}</b>`);
    lines.push(`👥 Приглашено друзей: <b>${a.ref.count}</b>`);
  }
  const last = a.orders[0];
  if (last) lines.push('', `📦 Последний заказ №${last.id}: ${last.statusLabel}, ${P.rub(last.finalSum || last.sum)}`);
  if (a.history.length) lines.push('', '<b>Последние операции</b>', ...a.history.slice(0, 5).map(h => `${h.amount > 0 ? '＋' : '−'}${Math.abs(h.amount)} · ${esc(h.reason)}`));
  const rows = [];
  if (b.enabled && a.ref.link) {
    const share = u.platform === 'tg'
      ? `https://t.me/share/url?url=${encodeURIComponent(a.ref.link)}&text=${encodeURIComponent(`Заказываю морепродукты в ${catalog.get().settings.brand || 'Seafood Сочи'} — держи ${b.welcome} бонусов на первый заказ 🐟`)}`
      : a.ref.link;
    rows.push([{ text: '📤 Пригласить друга', url: share }]);
  }
  if (config.publicUrl) rows.push([{ text: '🛍 Открыть магазин', app: true }]);
  rows.push((u.orderIds || []).length ? [{ text: '📦 Мои заказы', cb: 'my' }, { text: '← Меню', cb: 'm' }] : [{ text: '← Меню', cb: 'm' }]);
  return { text: lines.join('\n'), buttons: rows };
}

function cardView(u, id) {
  const c = catalog.get();
  const p = c.byId[id];
  if (!p || p.out) return { text: 'Этот товар закончился. Посмотрите другие позиции 🐟', buttons: [[{ text: '🐟 Каталог', cb: 'cats' }]] };
  const cat = c.cats.find(x => x.cid === p.cid);
  u.pick = u.pick || {};
  const inCart = u.cart[id];
  const q = u.pick[id] || inCart || P.firstQty(p);
  u.pick[id] = q;
  const lines = [`<b>${esc(catalog.fullName(p))}</b>`];
  if (p.note && !catalog.fullName(p).includes(p.note)) lines.push(`<i>${esc(p.note)}</i>`);
  if (P.isAsk(p)) {
    lines.push('', 'Цена и наличие — по запросу. Напишите, какой объём нужен, менеджер ответит здесь.');
    return { text: lines.join('\n'), image: p.imageAbs, buttons: [[{ text: '💬 Узнать цену', cb: `ask:${p.id}` }], [{ text: '← ' + (cat ? cat.name : 'Каталог'), cb: cat ? `c:${cat.cid}:0` : 'cats' }]] };
  }
  lines.push('', P.onSale(p) ? `🔥 <b>${P.priceText(p)}</b> вместо ${P.rub(p.price)}` : `<b>${P.priceText(p)}</b>`);
  const hint = P.hintText(p);
  if (hint) lines.push(hint);
  lines.push('', `Количество: <b>${P.qtyLabel(p, q)}</b> · ${P.approx(p) ? '≈ ' : ''}${P.rub(P.lineSum(p, q))}`);
  if (P.approx(p)) lines.push('<i>Точный вес и сумму подтвердит менеджер.</i>');
  if (inCart) lines.push(`🛒 В корзине: ${P.qtyLabel(p, inCart)}`);
  const addText = inCart ? (inCart === q ? '✓ В корзине' : '🔄 Обновить в корзине') : '🛒 В корзину';
  return {
    text: lines.join('\n'),
    image: p.imageAbs,
    buttons: [
      [{ text: '−', cb: `q:${id}:-` }, { text: P.qtyLabel(p, q), cb: `p:${id}` }, { text: '+', cb: `q:${id}:+` }],
      [{ text: addText, cb: `a:${id}` }],
      [{ text: '← ' + (cat ? cat.name : 'Каталог'), cb: cat ? `c:${cat.cid}:0` : 'cats' }, { text: cartBtnLabel(u), cb: 'cart' }],
    ],
  };
}

function cartView(u) {
  const s = cartSum(u);
  if (!s.lines.length) return { text: 'Корзина пока пустая 🧺\nЗагляните в каталог или напишите название товара.', buttons: [[{ text: '🐟 Каталог', cb: 'cats' }], ...(config.publicUrl ? [[{ text: '🛍 Открыть магазин', app: true }]] : [])] };
  const min = orders.minOrder();
  const low = min && s.sum < min;
  const text = [
    '<b>🛒 Ваша корзина</b>', '',
    orders.linesText(s.lines), '',
    `<b>Примерно: ${P.rub(s.sum)}</b>`,
    s.weighed ? '<i>Весовой товар взвешиваем при сборке, итог подтвердит менеджер.</i>' : '',
    low ? `\n⚠️ Минимальный заказ ${P.rub(min)}. Добавьте ещё на ${P.rub(min - s.sum)}.` : '',
  ].filter(Boolean).join('\n');
  const rows = [];
  if (!low) rows.push([{ text: '✅ Оформить заказ', cb: 'co' }]);
  rows.push(...s.lines.slice(0, 15).map(l => [{ text: `✎ ${l.name} · ${l.qtyLabel}`, cb: `p:${l.id}` }]));
  rows.push([{ text: '🐟 Продолжить покупки', cb: 'cats' }, { text: '🗑 Очистить', cb: 'clr' }]);
  return { text, buttons: rows };
}

function zonesText() {
  const zones = (catalog.get().zones || []).filter(z => z.active !== 0);
  if (!zones.length) return '';
  return '\n\n<b>Зоны доставки</b>\n' + zones.map(z => `${zoneDot(z.color)} <b>${esc(z.name)}</b>: ${esc(Z.tariff(z))}${z.eta ? ` · ${esc(z.eta)}` : ''}`).join('\n');
}
// Цветной кружок, ближайший к цвету зоны
function zoneDot(hex) {
  const n = parseInt(String(hex || '#888888').slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const dots = [['🟢', 46, 158, 91], ['🟡', 224, 177, 46], ['🟠', 228, 119, 46], ['🔴', 220, 60, 50], ['🔵', 40, 110, 200], ['🟣', 122, 79, 181]];
  return dots.reduce((best, d) => { const dist = (d[1] - r) ** 2 + (d[2] - g) ** 2 + (d[3] - b) ** 2; return dist < best[1] ? [d[0], dist] : best; }, ['⚪', Infinity])[0];
}

function deliveryView() {
  const s = catalog.get().settings;
  const map = config.publicUrl && (catalog.get().zones || []).length ? [[{ text: '🗺 Карта зон доставки', app: 'delivery' }]] : [];
  return {
    text: `<b>🚚 Доставка и оплата</b>\n\n${esc(s.delivery || 'Доставляем по Сочи.')}${zonesText()}\n\n⚖️ <b>Честный вес.</b> Рыбу взвешиваем при сборке, итог по весу менеджер подтвердит до отправки.\n❄️ Свежая рыба и сухая заморозка, везём в холоде.\n💳 ${esc(s.payment || 'Оплата при получении.')}\n\n🕒 ${esc(s.hours || '')}`,
    buttons: [...map, [{ text: '🐟 Каталог', cb: 'cats' }, { text: '📞 Менеджер', cb: 'ct' }]],
  };
}

function contactView() {
  const s = catalog.get().settings;
  const rows = [[{ text: '💬 Задать вопрос здесь', cb: 'ask' }]];
  if (s.phone_wa) rows.push([{ text: '🟢 Написать в WhatsApp', url: `https://wa.me/${String(s.phone_wa).replace(/\D/g, '')}` }]);
  rows.push([{ text: '← Меню', cb: 'm' }]);
  return { text: `<b>📞 Связь с менеджером</b>\n\nТелефон и WhatsApp: <b>${esc(s.phone_tel || '')}</b>\n${esc(s.hours || '')}\n\nМожно задать вопрос прямо в этом чате — менеджер ответит сюда же.`, buttons: rows };
}

async function myOrdersView(u) {
  const list = await store.ordersByIds((u.orderIds || []).slice(0, 3));
  if (!list.length) return { text: 'Заказов пока нет.', buttons: [[{ text: '🐟 Каталог', cb: 'cats' }]] };
  const text = '<b>📦 Ваши заказы</b>\n\n' + list.map(o => {
    const st = orders.STATUS[o.status] || orders.STATUS.new;
    const d = new Date(o.createdAt + 3 * 3600e3).toISOString().slice(5, 16).replace('T', ' ').replace(/^(\d\d)-(\d\d)/, '$2.$1');
    return `<b>№${o.id}</b> от ${d} — ${st.icon} ${st.label}\n${o.lines.length} поз. · ${P.rub(o.finalSum || o.sum)}`;
  }).join('\n\n');
  return { text, buttons: [...list.map(o => [{ text: `🔁 Повторить №${o.id}`, cb: `rp:${o.id}` }]), [{ text: '← Меню', cb: 'm' }]] };
}

function searchResultsView(u, q) {
  const hits = catalog.search(q, 10);
  if (!hits.length) return { text: `По запросу «${esc(q)}» ничего не нашлось. Посмотрите каталог или спросите менеджера.`, buttons: [[{ text: '🐟 Каталог', cb: 'cats' }, { text: '💬 Спросить', cb: 'ask' }]] };
  return { text: `Нашёл ${hits.length} ${P.plural(hits.length, 'позицию', 'позиции', 'позиций')} по запросу «${esc(q)}»:`, buttons: [...hits.map(productBtn), [{ text: '🐟 Весь каталог', cb: 'cats' }]] };
}

// ---------- оформление заказа ----------
const STEPS = ['name', 'phone', 'address', 'time', 'pay', 'comment', 'confirm'];
const stepNo = s => STEPS.indexOf(s) + 1;

function checkoutView(u) {
  const d = u.draft;
  const pr = u.profile || {};
  const cancel = { text: '✖️ Отменить', cb: 'cx' };
  switch (u.step) {
    case 'name':
      return { text: `📝 <b>Оформление заказа</b>\n\n<b>Шаг 1 из 6.</b> Как к вам обращаться?`, buttons: [...(d.suggestName ? [[{ text: `Я ${d.suggestName}`, cb: 'nm' }]] : []), [cancel]] };
    case 'phone':
      return { text: `<b>Шаг 2 из 6.</b> Телефон для связи — нажмите кнопку или введите номер.`, buttons: [[{ text: '📱 Отправить мой номер', contact: true }], ...(pr.phone ? [[{ text: `Тот же: ${pr.phone}`, cb: 'ph' }]] : []), [cancel]] };
    case 'address':
      return { text: `<b>Шаг 3 из 6.</b> Адрес доставки: улица, дом, квартира, подъезд. Можно отправить геоточку.`, buttons: [[{ text: '📍 Отправить геоточку', location: true }], ...(pr.address ? [[{ text: `Прошлый: ${pr.address.slice(0, 40)}`, cb: 'ad' }]] : []), [cancel]] };
    case 'time':
      return { text: `<b>Шаг 4 из 6.</b> Когда удобно получить заказ?`, buttons: [...pairs(config.timeSlots.map((t, i) => ({ text: t, cb: `t:${i}` }))), [cancel]] };
    case 'pay':
      return { text: `<b>Шаг 5 из 6.</b> Как удобнее оплатить?`, buttons: [...config.payments.map((t, i) => [{ text: t, cb: `py:${i}` }]), [cancel]] };
    case 'comment':
      return { text: `<b>Шаг 6 из 6.</b> Комментарий к заказу? Например: «разделать форель на стейки», «позвонить за час».`, buttons: [[{ text: 'Без комментария', cb: 'nc' }], [cancel]] };
    case 'confirm': {
      const s = cartSum(u);
      const avail = u._loyal ? loyalty.maxSpend(u._loyal, s.sum) : 0;
      const use = d.useBonus && avail > 0;
      const total = [`<b>Примерно: ${P.rub(s.sum)}</b>`];
      const zone = d.geo ? Z.find(catalog.get().zones, d.geo.lat, d.geo.lon) : null;
      const dl = zone ? Z.cost(zone, s.sum) : null;
      if (use) total.push(`💎 Бонусами: −${P.rub(avail)}`);
      if ((catalog.get().zones || []).length) total.push(orders.deliveryText(dl || (d.geo ? { outside: true } : { unknown: true })));
      if (use || (dl && dl.price)) total.push(`<b>К оплате: ${P.rub(s.sum - (use ? avail : 0) + ((dl && dl.price) || 0))}</b>`);
      if (!use && avail) total.push(`<i>💎 Можно списать ${avail} бонусов</i>`);
      const rows = [[{ text: '✅ Подтвердить заказ', cb: 'ok' }]];
      if (avail) rows.push([{ text: use ? '↩️ Не списывать бонусы' : `💎 Списать ${avail} бонусов`, cb: 'bu' }]);
      rows.push([{ text: '✎ Изменить данные', cb: 'co' }, { text: '🛒 Корзина', cb: 'cart' }]);
      return {
        text: [`<b>Проверьте заказ</b>`, '', orders.linesText(s.lines), '', ...total, '',
          `👤 ${esc(d.name)}`, `📱 ${esc(d.phone)}`, `📍 ${esc(d.address)}`, `🕒 ${esc(d.time)}`, `💳 ${esc(d.pay)}`, ...(d.comment ? [`💬 ${esc(d.comment)}`] : [])].join('\n'),
        buttons: rows,
      };
    }
  }
  return menuView(u);
}
function pairs(btns) { const r = []; for (let i = 0; i < btns.length; i += 2) r.push(btns.slice(i, i + 2)); return r; }

function startCheckout(u, ev) {
  const s = cartSum(u);
  const min = orders.minOrder();
  if (!s.lines.length || (min && s.sum < min)) return cartView(u);
  u.draft = { suggestName: u.profile.name || ev.user.name || '' };
  u.step = 'name';
  return checkoutView(u);
}

// Подсказка о зоне доставки после адреса
function zoneNote(u) {
  const zones = catalog.get().zones || [];
  if (!zones.length) return '';
  const g = u.draft.geo;
  if (!g) return '\n🚚 Стоимость доставки подтвердит менеджер.';
  const z = Z.find(zones, g.lat, g.lon);
  if (!z) return '\n⚠️ Похоже, адрес вне наших зон доставки — менеджер свяжется и согласует условия.';
  return `\n🚚 Зона «${esc(z.name)}»: ${esc(Z.tariff(z))}.`;
}

function nextStep(u) {
  u.step = STEPS[stepNo(u.step)] || 'confirm';
  return checkoutView(u);
}

// ---------- обработка ----------
// Загружаем покупателя, обрабатываем событие, сохраняем изменения одним разом в конце.
async function handle(ev, rawCtx) {
  await catalog.sync();
  const u = await store.getUser(ev.platform, ev.user.id);
  u.chatId = String(ev.chatId);
  u.name = ev.user.name; u.username = ev.user.username || '';
  const ctx = wrapCtx(u, rawCtx);
  const cartBefore = JSON.stringify(u.cart);
  try {
    u._loyal = await loyalty.get(ev.platform, ev.user.id); // баланс нужен экрану подтверждения заказа
    await route(u, ev, ctx);
  } finally {
    delete u._loyal;
    if (JSON.stringify(u.cart) !== cartBefore) await require('./reminders').touch(u);
    await store.saveUser(u);
  }
}

// Обычная клавиатура Telegram (запрос номера/геоточки) присылает нажатия текстом.
// Запоминаем, какой текст какой кнопке соответствует, и снимаем клавиатуру следующим экраном.
function wrapCtx(u, ctx) {
  const prep = view => {
    if (!view) return view;
    const flat = (view.buttons || []).flat();
    if (flat.some(b => b.contact || b.location)) {
      u.replyMap = Object.fromEntries(flat.filter(b => b.cb).map(b => [b.text, b.cb]));
      u.replyKb = true;
    } else if (u.replyKb && !flat.length) {
      view = { ...view, removeKeyboard: true };
      u.replyKb = false;
    }
    return view;
  };
  return { reply: v => ctx.reply(prep(v)), edit: v => ctx.edit(prep(v)), toast: t => ctx.toast(t) };
}

async function route(u, ev, ctx) {
  // Служебные команды менеджера
  if (ev.type === 'text' && /^\/manager\b/i.test(ev.text || '')) return managerCommand(u, ev, ctx);
  if (ev.type === 'text' && /^\/admin\b/i.test(ev.text || '')) return adminCommand(u, ev, ctx);
  if (await store.isManager(ev.platform, ev.chatId)) {
    const done = await managerHandle(u, ev, ctx);
    if (done) return;
  }

  if (ev.type === 'start') {
    u.step = null;
    const pl = String(ev.payload || '');
    if (/^p\d+$/.test(pl)) return ctx.reply(cardView(u, +pl.slice(1)));
    if (/^ref_[A-Za-z0-9]{4,12}$/.test(pl)) {
      const r = await loyalty.applyReferral(u.platform, u.userId, pl, { hasOrders: (u.orderIds || []).length > 0 });
      if (r && r.welcome) await ctx.reply({ text: `🎁 Вас пригласил друг — дарим <b>${r.welcome} бонусов</b>! Ими можно оплатить часть первого заказа.` });
    }
    return ctx.reply(menuView(u, true));
  }

  if (ev.type === 'contact') {
    if (u.step === 'phone') { u.draft.phone = ev.phone; await ctx.reply({ text: `📱 Телефон: ${esc(ev.phone)} ✓` }); return ctx.reply(nextStep(u)); }
    return ctx.reply({ text: 'Спасибо! Номер получили 👍', buttons: [[{ text: '← Меню', cb: 'm' }]] });
  }
  if (ev.type === 'location') {
    const geo = `Геоточка: https://yandex.ru/maps/?pt=${ev.lon},${ev.lat}&z=17&l=map`;
    if (u.step === 'address') {
      u.draft.geo = { lat: ev.lat, lon: ev.lon };
      const r = await require('./geocode').reverse(ev.lat, ev.lon).catch(() => null);
      u.draft.address = r && r.label ? `${r.label} (${geo})` : geo;
      await ctx.reply({ text: `📍 Геоточку получили ✓${zoneNote(u)}\nНомер квартиры и подъезд напишите в комментарии на шаге 6.` });
      return ctx.reply(nextStep(u));
    }
    return ctx.reply({ text: 'Геоточку получили. Чтобы оформить доставку, соберите корзину 🐟', buttons: [[{ text: '🐟 Каталог', cb: 'cats' }]] });
  }

  if (ev.type === 'text') return onText(u, ev, ctx);
  if (ev.type === 'callback') return onCallback(u, ev, ctx);
}

async function onText(u, ev, ctx) {
  const t = String(ev.text || '').trim();
  if (!t) return;
  // Кнопки с ответной клавиатуры Telegram приходят текстом
  if (u.replyMap && u.replyMap[t]) { const cb = u.replyMap[t]; u.replyMap = null; return onCallback(u, { ...ev, data: cb }, { ...ctx, edit: ctx.reply }); }
  if (/^\/(start|menu|меню)$/i.test(t)) { u.step = null; return ctx.reply(menuView(u, t.toLowerCase() === '/start')); }
  if (/^\/cart$/i.test(t)) return ctx.reply(cartView(u));
  if (/^\/(delivery|доставка)$/i.test(t)) return ctx.reply(deliveryView());
  if (/^\/(account|bonus|кабинет)$/i.test(t)) return ctx.reply(await accountView(u));
  if (/^\/(catalog|каталог)$/i.test(t)) return ctx.reply(catsView(u));

  switch (u.step) {
    case 'name': u.draft.name = t.slice(0, 80); return ctx.reply(nextStep(u));
    case 'phone':
      if (t.replace(/\D/g, '').length < 10) return ctx.reply({ text: 'Похоже, номер неполный. Введите 10–11 цифр, например +7 918 123-45-67.', buttons: [[{ text: '📱 Отправить мой номер', contact: true }], [{ text: '✖️ Отменить', cb: 'cx' }]] });
      u.draft.phone = t.slice(0, 40);
      await ctx.reply({ text: `📱 Телефон: ${esc(u.draft.phone)} ✓` });
      return ctx.reply(nextStep(u));
    case 'address':
      if (t.length < 5) return ctx.reply({ text: 'Напишите адрес подробнее: улица, дом, квартира.' });
      u.draft.address = t.slice(0, 300);
      u.draft.geo = null;
      if ((catalog.get().zones || []).length) { const r = await require('./geocode').search(t).catch(() => null); if (r) u.draft.geo = { lat: r.lat, lon: r.lon }; }
      await ctx.reply({ text: `📍 Адрес: ${esc(u.draft.address)} ✓${zoneNote(u)}` });
      return ctx.reply(nextStep(u));
    case 'comment': u.draft.comment = t.slice(0, 500); return ctx.reply(nextStep(u));
    case 'time': u.draft.time = t.slice(0, 80); return ctx.reply(nextStep(u));
    case 'question': return sendQuestion(u, ev, ctx, t);
    case 'search': u.step = null; return ctx.reply(searchResultsView(u, t));
  }
  if (/^(привет|здравств|добр|hi|hello|начать|старт)/i.test(t)) return ctx.reply(menuView(u, true));
  return ctx.reply(searchResultsView(u, t));
}

async function onCallback(u, ev, ctx) {
  const [k, a, b] = String(ev.data || '').split(':');
  const c = catalog.get();
  switch (k) {
    case 'm': u.step = null; return ctx.edit(menuView(u));
    case 'cats': return ctx.edit(catsView(u));
    case 'c': return ctx.edit(catView(u, a, +b || 0));
    case 'sale': return ctx.edit(saleView(u));
    case 'p': return ctx.reply(cardView(u, +a));
    case 'q': {
      const p = c.byId[+a];
      if (!p) return ctx.toast('Товар не найден');
      u.pick = u.pick || {};
      const cur = u.pick[a] || u.cart[a] || P.firstQty(p);
      let next = b === '+' ? P.inc(p, cur) : P.dec(p, cur);
      if (!next) { next = P.firstQty(p); ctx.toast(`Минимум — ${P.qtyLabel(p, next)}`); }
      u.pick[a] = next;
      return ctx.edit(cardView(u, +a));
    }
    case 'a': {
      const p = c.byId[+a];
      if (!p || p.out) return ctx.toast('Товар закончился');
      const q = (u.pick && u.pick[a]) || P.firstQty(p);
      u.cart[a] = P.normQty(p, q);
      ctx.toast(`Добавлено: ${P.qtyLabel(p, u.cart[a])}. В корзине ≈ ${P.rub(cartSum(u).sum)}`);
      return ctx.edit(cardView(u, +a));
    }
    case 'cart': return ctx.reply(cartView(u));
    case 'clr': u.cart = {}; u.pick = {}; return ctx.edit({ text: 'Корзина очищена.', buttons: [[{ text: '🐟 Каталог', cb: 'cats' }]] });
    case 'dl': return ctx.reply(deliveryView());
    case 'ct': return ctx.reply(contactView());
    case 'my': return ctx.reply(await myOrdersView(u));
    case 'acc': return ctx.reply(await accountView(u));
    case 'bu': if (u.step !== 'confirm') return; u.draft.useBonus = !u.draft.useBonus; return ctx.edit(checkoutView(u));
    case 'srch': u.step = 'search'; return ctx.reply({ text: 'Напишите, что ищете — например, <b>креветки</b>, <b>икра</b> или <b>форель</b>.' });
    case 'thx': return ctx.reply({ text: 'Спасибо! Ждём курьера вместе с вами 🐟' });
    case 'ask': {
      u.step = 'question'; u.draft = { ...(u.draft || {}), askId: a || null };
      const p = a && c.byId[+a];
      return ctx.reply({ text: p ? `Напишите вопрос про «${esc(catalog.fullName(p))}» — например, нужный вес. Передам менеджеру, ответ придёт сюда.` : 'Напишите ваш вопрос — передам менеджеру, ответ придёт в этот чат.', buttons: [[{ text: '✖️ Отменить', cb: 'cx' }]] });
    }
    case 'rp': {
      const o = await store.order(+a);
      if (!o || o.platform !== u.platform || String(o.userId) !== String(u.userId)) return ctx.toast('Заказ не найден');
      let skipped = 0;
      for (const l of o.lines) { const p = c.byId[l.id]; if (p && !p.out && !P.isAsk(p)) u.cart[l.id] = P.normQty(p, l.qty); else skipped++; }
      if (skipped) await ctx.reply({ text: `ℹ️ ${skipped} ${P.plural(skipped, 'позиции', 'позиций', 'позиций')} сейчас нет в наличии — остальное добавил в корзину.` });
      return ctx.reply(cartView(u));
    }
    // оформление
    case 'co': return ctx.reply(startCheckout(u, ev));
    case 'cx': u.step = null; u.draft = {}; return ctx.reply({ text: 'Хорошо, отменил. Корзина сохранена.', buttons: [[{ text: cartBtnLabel(u), cb: 'cart' }, { text: '← Меню', cb: 'm' }]] });
    case 'nm': if (u.step !== 'name') return; u.draft.name = u.draft.suggestName; return ctx.edit(nextStep(u));
    case 'ph': if (u.step !== 'phone') return; u.draft.phone = u.profile.phone; await ctx.reply({ text: `📱 Телефон: ${esc(u.draft.phone)} ✓` }); return ctx.reply(nextStep(u));
    case 'ad': if (u.step !== 'address') return; u.draft.address = u.profile.address; await ctx.reply({ text: `📍 Адрес: ${esc(u.draft.address)} ✓` }); return ctx.reply(nextStep(u));
    case 't': if (u.step !== 'time') return; u.draft.time = config.timeSlots[+a] || config.timeSlots[0]; return ctx.edit(nextStep(u));
    case 'py': if (u.step !== 'pay') return; u.draft.pay = config.payments[+a] || config.payments[0]; return ctx.edit(nextStep(u));
    case 'nc': if (u.step !== 'comment') return; u.draft.comment = ''; return ctx.edit(nextStep(u));
    case 'ok': {
      if (u.step !== 'confirm') return ctx.toast('Заказ уже оформлен');
      const d = u.draft;
      const r = await orders.create({ user: u, platform: u.platform, userId: u.userId, chatId: u.chatId, username: u.username, source: 'chat', verified: true, cart: u.cart, name: d.name, phone: d.phone, address: d.address, time: d.time, pay: d.pay, comment: d.comment, useBonus: !!d.useBonus, geo: d.geo });
      if (!r.ok) return ctx.reply({ text: '⚠️ ' + r.errors.join('\n'), buttons: [[{ text: '🛒 Корзина', cb: 'cart' }]] });
      u.step = null; u.draft = {};
      return ctx.edit({ text: orders.customerText(r.order), buttons: [[{ text: '🐟 В каталог', cb: 'cats' }, { text: '📞 Менеджер', cb: 'ct' }]] });
    }
  }
  await ctx.toast('Эта кнопка устарела — открываю меню');
  return ctx.reply(menuView(u));
}

async function sendQuestion(u, ev, ctx, text) {
  const c = catalog.get();
  const p = u.draft && u.draft.askId && c.byId[+u.draft.askId];
  const q = await store.newQuestion({ platform: u.platform, userId: u.userId, chatId: u.chatId, name: ev.user.name, username: u.username, phone: u.profile.phone || '', text: (p ? `[${catalog.fullName(p)}] ` : '') + text });
  u.step = null; u.draft = {};
  const view = { text: `❓ <b>Вопрос из ${u.platform === 'tg' ? 'Telegram' : 'MAX'}</b>\n👤 ${esc(q.name)}${q.username ? ' (@' + esc(q.username) + ')' : ''}${q.phone ? '\n📱 ' + esc(q.phone) : ''}\n\n${esc(q.text)}`, buttons: [[{ text: '↩️ Ответить', cb: `mq:${q.id}` }]] };
  const hub = require('./hub');
  let delivered = 0;
  for (const m of await store.managers()) if (await hub.send(m.platform, { chatId: m.chatId }, view)) delivered++;
  return ctx.reply({ text: delivered ? 'Передал менеджеру ✅ Ответ придёт в этот чат, обычно в течение 10–15 минут.' : `Менеджер сейчас не в сети. Позвоните, пожалуйста: ${esc(c.settings.phone_tel || '')}`, buttons: [[{ text: '← Меню', cb: 'm' }]] });
}

// ---------- менеджер ----------
async function managerCommand(u, ev, ctx) {
  const arg = String(ev.text).split(/\s+/)[1] || '';
  if (arg === 'off') { await store.removeManager(ev.platform, ev.chatId); return ctx.reply({ text: 'Уведомления о заказах отключены.' }); }
  if (!config.managerPin || arg !== config.managerPin) return ctx.reply({ text: 'Неверный код. Попросите код у администратора.' });
  await store.addManager(ev.platform, ev.chatId, ev.user.name);
  return ctx.reply({ text: `✅ Вы подключены как менеджер. Сюда будут приходить заказы и вопросы покупателей.\n\nАдмин-панель открывается прямо из магазина (Кабинет → «Админ-панель») или командой /admin — без пароля.\nОтключить: /manager off`, buttons: adminButton() });
}
function adminButton() { return config.publicUrl ? [[{ text: '⚙️ Админ-панель', app: 'admin' }]] : []; }
async function adminCommand(u, ev, ctx) {
  if (!(await store.isManager(ev.platform, ev.chatId))) return ctx.reply({ text: 'Админ-панель доступна менеджерам. Подключитесь командой /manager КОД.' });
  return ctx.reply({ text: '⚙️ Админ-панель: товары, заказы, акции, доставка и настройки.', buttons: adminButton() });
}

async function managerHandle(u, ev, ctx) {
  // Ввод суммы или ответа покупателю
  if (ev.type === 'text' && u.mstep) {
    const [kind, id] = u.mstep.split(':');
    const t = String(ev.text).trim();
    if (/^(отмена|\/cancel)$/i.test(t)) { u.mstep = null; await ctx.reply({ text: 'Отменено.' }); return true; }
    if (kind === 'sum') {
      const sum = parseInt(t.replace(/[^\d]/g, ''), 10);
      if (!sum) { await ctx.reply({ text: 'Введите итоговую сумму числом, например 4820. Или «отмена».' }); return true; }
      u.mstep = null;
      const o = await orders.setFinalSum(+id, sum, ev.user.name);
      await ctx.reply({ text: `Итог ${P.rub(sum)} по заказу №${id} отправлен покупателю ✓` });
      if (o) await orders.refreshManagerCards(o);
      return true;
    }
    if (kind === 'ans') {
      const q = await store.question(id);
      u.mstep = null;
      if (!q) { await ctx.reply({ text: 'Вопрос не найден.' }); return true; }
      q.answered = true; await store.saveQuestion(q);
      const hub = require('./hub');
      await hub.send(q.platform, { chatId: q.chatId }, { text: `💬 <b>Ответ менеджера:</b>\n${esc(t)}`, buttons: [[{ text: '🐟 Каталог', cb: 'cats' }, { text: '💬 Ещё вопрос', cb: 'ask' }]] });
      await ctx.reply({ text: 'Ответ отправлен покупателю ✓' });
      return true;
    }
  }
  if (ev.type !== 'callback') return false;
  const [k, id, act] = String(ev.data || '').split(':');
  if (k === 'mq') {
    u.mstep = `ans:${id}`;
    await ctx.reply({ text: 'Напишите ответ одним сообщением — бот перешлёт его покупателю. «отмена» — чтобы выйти.' });
    return true;
  }
  if (k !== 'mo') return false;
  const map = { ok: 'confirmed', go: 'going', done: 'done', x: 'canceled' };
  if (act === 'sum') {
    u.mstep = `sum:${id}`;
    await ctx.reply({ text: `Заказ №${id}: введите итоговую сумму после взвешивания (числом).` });
    return true;
  }
  const o = await orders.setStatus(+id, map[act], ev.user.name);
  if (!o) { await ctx.toast('Заказ не найден'); return true; }
  ctx.toast(`№${o.id}: ${orders.STATUS[o.status].label}`);
  await ctx.edit(orders.managerView(o));
  await orders.refreshManagerCards(o, { platform: ev.platform, chatId: ev.chatId });
  return true;
}

module.exports = { handle, menuView, cartView, cardView, catView, catsView, accountView };
