/*
 * Зоны доставки — общий код для сервера, бота, магазина и админки.
 * Зона: { id, name, color, price, free_from, min_order, eta, polygon: [[lat, lon], ...], active }
 *  - price      — стоимость доставки, ₽ (0 — всегда бесплатно)
 *  - free_from  — с какой суммы товаров доставка бесплатная (0 — без порога)
 *  - min_order  — минимальная сумма заказа в этой зоне (0 — общий минимум магазина)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Zones = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Точка внутри многоугольника (луч вправо)
  function inside(lat, lon, poly) {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [yi, xi] = poly[i], [yj, xj] = poly[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  }

  // Первая подходящая зона по порядку (порядок задаётся в админке: сначала самые выгодные)
  function find(zones, lat, lon) {
    if (lat == null || lon == null || isNaN(+lat) || isNaN(+lon)) return null;
    return (zones || []).find(z => z.active !== 0 && z.polygon && z.polygon.length >= 3 && inside(+lat, +lon, z.polygon)) || null;
  }

  // Стоимость доставки для суммы товаров
  function cost(zone, sum) {
    if (!zone) return null;
    const free = (+zone.free_from > 0 && sum >= +zone.free_from) || !(+zone.price > 0);
    return { id: zone.id, name: zone.name, color: zone.color, price: free ? 0 : +zone.price, free, freeFrom: +zone.free_from || 0, minOrder: +zone.min_order || 0, eta: zone.eta || '' };
  }

  // Подпись тарифа: «Бесплатно от 3 000 ₽ · иначе 300 ₽»
  function rub(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽'; }
  function tariff(zone) {
    const price = +zone.price || 0, free = +zone.free_from || 0, min = +zone.min_order || 0;
    const parts = [];
    if (!price) parts.push('Доставка бесплатно');
    else if (free) parts.push(`Бесплатно от ${rub(free)}, иначе ${rub(price)}`);
    else parts.push(`Доставка ${rub(price)}`);
    if (min) parts.push(`заказ от ${rub(min)}`);
    return parts.join(' · ');
  }

  return { inside, find, cost, tariff };
});
