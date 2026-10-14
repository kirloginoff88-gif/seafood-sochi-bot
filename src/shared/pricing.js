/*
 * Правила цены и количества — общие для бота (Node) и мини-приложения (браузер).
 * Повторяют логику сайта seafood-sochi.ru, чтобы сумма везде совпадала.
 *
 * Как продаётся товар:
 *   'pack'   — фасовка (unit «шт»): цена за штуку, количество в штуках
 *   'piece'  — штучный весовой (unit «кг» + piece_g): цена за кг, вес штуки примерный, считаем штуками
 *   'weight' — развес (unit «кг» без piece_g): цена за кг, количество в граммах:
 *              минимум (min_g или 500 г), дальше круглые полкило: 300 → 500 → 1000 → 1500…
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Pricing = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Защита от опечаток в админке сайта: «вес штуки 1 г» или «минимум 1 г» считаем незаполненными
  const pieceG = p => (+p.piece_g >= 50 ? +p.piece_g : 0);
  const rawMinG = p => (+p.min_g >= 100 ? +p.min_g : 0);

  function mode(p) {
    if (p.unit !== 'кг') return 'pack';
    return pieceG(p) ? 'piece' : 'weight';
  }

  // Дата «сегодня» в Сочи (UTC+3), чтобы акции включались и гасли по местному времени
  function today(now) {
    const d = new Date((now ? +now : Date.now()) + 3 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  }
  function onSale(p, now) {
    const sp = +p.sale_price;
    if (!(sp > 0) || !(p.price > 0) || sp >= p.price) return false;
    const t = today(now);
    if (p.sale_from && t < p.sale_from) return false;
    if (p.sale_to && t > p.sale_to) return false;
    return true;
  }
  const eff = (p, now) => (onSale(p, now) ? +p.sale_price : +p.price);
  const saleOff = p => Math.round((1 - +p.sale_price / p.price) * 100);
  const isAsk = p => !(+p.price > 0);

  const minG = p => rawMinG(p) || 500;
  function nextW(p, cur) {
    const mn = minG(p);
    if (cur < mn) return mn;
    if (cur < 500) return 500;
    return cur + 500;
  }
  function prevW(p, cur) {
    const mn = minG(p);
    if (cur > 500) return cur - 500;
    if (cur > mn) return mn;
    return 0;
  }
  const firstQty = p => (mode(p) === 'weight' ? minG(p) : 1);
  const inc = (p, q) => (mode(p) === 'weight' ? nextW(p, q) : Math.min(99, q + 1));
  const dec = (p, q) => (mode(p) === 'weight' ? prevW(p, q) : Math.max(0, q - 1));

  // Приводит пришедшее количество к допустимому (защита от подделки корзины)
  function normQty(p, q) {
    q = Math.floor(+q || 0);
    if (q <= 0) return 0;
    if (mode(p) === 'weight') {
      const mn = minG(p);
      if (q < mn) return 0;
      if (q !== mn) q = Math.max(500, Math.round(q / 500) * 500);
      return Math.min(q, 50000);
    }
    return Math.min(q, 99);
  }

  function wt(g) {
    if (g < 1000) return g + ' г';
    return String(Math.round((g / 1000) * 10) / 10).replace('.', ',') + ' кг';
  }
  const ru = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const rub = n => ru(n) + ' ₽';

  function lineSum(p, q, now) {
    const m = mode(p), pr = eff(p, now);
    if (isAsk(p)) return 0;
    if (m === 'pack') return pr * q;
    if (m === 'piece') return Math.round((pr * pieceG(p)) / 1000) * q;
    return Math.round((pr * q) / 1000);
  }
  const qtyLabel = (p, q) => (mode(p) === 'weight' ? wt(q) : q + ' шт');
  const approx = p => mode(p) !== 'pack';

  function priceText(p, now) {
    if (isAsk(p)) return 'по запросу';
    return rub(eff(p, now)) + (p.unit === 'кг' ? '/кг' : '');
  }
  function hintText(p, now) {
    const m = mode(p);
    if (m === 'piece') return '1 шт ≈ ' + wt(pieceG(p)) + ' ≈ ' + rub((eff(p, now) * pieceG(p)) / 1000);
    if (m === 'weight') return 'от ' + wt(minG(p)) + ', дальше по 500 г';
    return '';
  }

  // Корзина: { [productId]: qty } → строки и итог
  function cartLines(cart, byId, now) {
    const lines = [];
    let sum = 0, weighed = false, ask = false;
    for (const id of Object.keys(cart || {})) {
      const p = byId[id];
      if (!p || p.out) continue;
      const q = normQty(p, cart[id]);
      if (!q) continue;
      const s = lineSum(p, q, now);
      sum += s;
      if (approx(p)) weighed = true;
      if (isAsk(p)) ask = true;
      lines.push({ id: p.id, name: p.name, note: p.note || '', qty: q, mode: mode(p), pieceG: pieceG(p), qtyLabel: qtyLabel(p, q), sum: s, approx: approx(p), ask: isAsk(p), price: eff(p, now), unit: p.unit, sale: onSale(p, now) });
    }
    return { lines, sum, weighed, ask };
  }

  function plural(n, a, b, c) {
    const d = n % 10, e = n % 100;
    if (d === 1 && e !== 11) return a;
    if (d >= 2 && d <= 4 && (e < 10 || e >= 20)) return b;
    return c;
  }

  return { mode, onSale, eff, saleOff, isAsk, minG, nextW, prevW, firstQty, inc, dec, normQty, wt, ru, rub, lineSum, qtyLabel, approx, priceText, hintText, cartLines, plural, today, pieceG };
});
