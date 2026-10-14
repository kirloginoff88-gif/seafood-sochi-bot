// Битрикс24: создаём лид (или сделку) с товарами через входящий вебхук.
const config = require('./config');

async function call(method, params) {
  const res = await fetch(config.b24.webhook + method + '.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`${method}: ${json.error_description || json.error || res.status}`);
  return json.result;
}

const PLATFORM = { tg: 'Telegram', max: 'MAX', web: 'сайт/браузер' };

async function pushOrder(o) {
  if (!config.b24.enabled) return null;
  const isDeal = config.b24.entity === 'deal';
  const title = `Заказ №${o.id} из ${PLATFORM[o.platform] || o.platform}`;
  const comments = [
    `Источник: бот ${PLATFORM[o.platform] || o.platform} (${o.source === 'app' ? 'мини-приложение' : 'чат'})`,
    `Когда: ${o.time}`, `Оплата: ${o.pay}`,
    o.comment ? `Комментарий: ${o.comment}` : '',
    '', ...o.lines.map(l => `• ${l.name}${l.note ? ' (' + l.note + ')' : ''} — ${l.qtyLabel} — ${l.ask ? 'по запросу' : (l.approx ? '≈ ' : '') + l.sum + ' ₽'}`),
    '', `Примерно: ${o.sum} ₽ (точный вес подтверждает менеджер)`,
  ].filter(x => x !== '').join('\n');

  const fields = {
    TITLE: title,
    OPPORTUNITY: o.sum,
    CURRENCY_ID: 'RUB',
    COMMENTS: comments.replace(/\n/g, '<br>'),
    ...(config.b24.sourceId ? { SOURCE_ID: config.b24.sourceId } : {}),
    ...(config.b24.assignedId ? { ASSIGNED_BY_ID: +config.b24.assignedId } : {}),
  };
  let id;
  if (isDeal) {
    // Для сделки создаём контакт, чтобы телефон был в карточке клиента
    const contactId = await call('crm.contact.add', { fields: { NAME: o.customer.name, PHONE: [{ VALUE: o.customer.phone, VALUE_TYPE: 'MOBILE' }], ...(config.b24.sourceId ? { SOURCE_ID: config.b24.sourceId } : {}) } });
    id = await call('crm.deal.add', { fields: { ...fields, CONTACT_ID: contactId } });
  } else {
    id = await call('crm.lead.add', { fields: { ...fields, NAME: o.customer.name, PHONE: [{ VALUE: o.customer.phone, VALUE_TYPE: 'MOBILE' }], ADDRESS: o.address } });
  }
  // Товарные позиции: весовые передаём в кг с ценой за кг, чтобы менеджер поправил вес после взвешивания
  const rows = o.lines.filter(l => !l.ask).map(l => {
    if (l.mode === 'weight') {
      return { PRODUCT_NAME: l.name, PRICE: l.price, QUANTITY: l.qty / 1000, MEASURE_CODE: 166, MEASURE_NAME: 'кг' };
    }
    if (l.mode === 'piece') {
      return { PRODUCT_NAME: `${l.name} (${l.qty} шт)`, PRICE: l.price, QUANTITY: Math.round(l.qty * l.pieceG) / 1000, MEASURE_CODE: 166, MEASURE_NAME: 'кг' };
    }
    return { PRODUCT_NAME: l.name + (l.note ? ` (${l.note})` : ''), PRICE: l.qty ? Math.round(l.sum / l.qty) : l.price, QUANTITY: l.qty, MEASURE_CODE: 796, MEASURE_NAME: 'шт' };
  });
  try {
    await call(isDeal ? 'crm.deal.productrows.set' : 'crm.lead.productrows.set', { id, rows });
  } catch (e) { console.warn('[b24] товары не записаны:', e.message); }
  return { entity: isDeal ? 'deal' : 'lead', id };
}

module.exports = { pushOrder, call };
