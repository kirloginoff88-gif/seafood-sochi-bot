/*
 * КБЖУ и «польза заказа» — общий код для бота, мини-приложения и админки.
 *
 * Значения на 100 г съедобной части — справочные средние (таблицы химического состава продуктов),
 * точность ±15%: состав рыбы зависит от сезона, места вылова и обработки.
 * Любой товар можно уточнить в админке (поле «КБЖУ»): тогда берём значения оттуда.
 *
 * of(product)        → { kcal, p, f, c, o3, yield, tags, micro, custom }
 * gramsOf(product, q) → граммы продукта в строке корзины (или 0, если вес неизвестен)
 * order(lines, byId)  → итог по заказу: КБЖУ, омега-3, доли суточных норм
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Nutrition = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // [ключевые слова, ккал, белки, жиры, углеводы, омега-3 (EPA+DHA), г]
  // Порядок важен: первое совпадение по названию побеждает
  const TABLE = [
    [/корюшк/, 102, 15.5, 4.5, 0, 0.7],
    [/икр[аы].*(стерлят|осетр|чёрн|черн)|чёрная икра|черная икра/, 264, 24.6, 17.9, 4.0, 6.5],
    [/икр[аы].*сельд|сельд.*икр/, 130, 22, 4.5, 1, 1.4],
    [/икр/, 250, 31.6, 13.8, 0, 3.0],
    [/печень трески/, 613, 4.2, 65.7, 1.2, 10],
    [/угор/, 200, 15, 14, 9, 0.8],
    [/том ям/, 60, 4, 3, 4, 0.1],
    [/котлет/, 160, 14, 8, 8, 0.3],
    [/рулет|тортик|ассорти|трио/, 170, 20, 10, 0, 1.0],
    [/суп-набор|для ухи/, 90, 16, 3, 0, 0.4],
    [/фарширован/, 120, 14, 3, 8, 0.3],
    [/(кальмар).*(жарен)/, 175, 18, 9, 4, 0.4],
    [/кальмар/, 92, 15.6, 1.4, 3.1, 0.5],
    [/осьмин/, 82, 14.9, 1.0, 2.2, 0.2],
    [/гребеш/, 69, 12.1, 0.5, 3.2, 0.2],
    [/мясо мидии/, 86, 11.9, 2.2, 3.7, 0.5],
    [/мидии/, 86, 11.9, 2.2, 3.7, 0.5],
    [/устриц/, 68, 7, 2.5, 3.9, 0.6],
    [/вонголе|клэм/, 74, 12.8, 1.0, 2.6, 0.2],
    [/краб/, 84, 18.3, 0.6, 0, 0.4],
    [/лангустин/, 90, 18.7, 0.8, 0, 0.3],
    [/креветк|катаифи/, 95, 20.1, 1.1, 0.2, 0.3],
    [/рак/, 77, 16, 0.9, 0, 0.2],
    [/лосос|сёмг|семг|кижуч/, 208, 20.4, 13.4, 0, 2.3],
    [/нерк/, 131, 22.3, 4.7, 0, 0.9],
    [/кет[аы]|кеты/, 120, 20, 3.8, 0, 0.6],
    [/горбуш/, 127, 20.5, 4.4, 0, 0.7],
    [/форел/, 141, 19.9, 6.2, 0, 1.0],
    [/тун/, 109, 24.4, 0.5, 0, 0.2],
    [/скумбри/, 205, 18.6, 13.9, 0, 2.3],
    [/сельд/, 158, 18, 9, 0, 1.7],
    [/маслян/, 180, 18, 11.5, 0, 0.3],
    [/осётр|осетр|стерлядь/, 147, 16.4, 10.9, 0, 1.4],
    [/палтус/, 102, 18.9, 3.0, 0, 0.6],
    [/зубатк/, 126, 19.6, 5.3, 0, 0.6],
    [/камбал|калкан/, 83, 15.7, 3.0, 0, 0.4],
    [/треск/, 82, 17.8, 0.7, 0, 0.2],
    [/окун/, 103, 18.2, 3.3, 0, 0.4],
    [/судак/, 84, 18.4, 1.1, 0, 0.2],
    [/дорадо/, 96, 19.8, 1.2, 0, 0.5],
    [/сибас/, 97, 18.4, 2.0, 0, 0.7],
    [/сузуки/, 97, 18.4, 2.0, 0, 0.7],
    [/барабул/, 113, 18.7, 4.3, 0, 0.6],
    [/баррамунди/, 95, 19, 1.6, 0, 0.4],
    [/конгри/, 90, 18, 1.5, 0, 0.3],
    [/пеленгас/, 110, 19, 3.6, 0, 0.5],
    [/карп/, 127, 17.8, 5.6, 0, 0.5],
    [/корюшк/, 102, 15.5, 4.5, 0, 0.7],
    [/тарань|вобл|лещ/, 105, 17.1, 4.1, 0, 0.4],
  ];
  // Если по названию не нашли — по разделу каталога
  const BY_CAT = {
    ikra: [250, 31.6, 13.8, 0, 3.0], krevetki: [95, 20.1, 1.1, 0.2, 0.3], raki: [77, 16, 0.9, 0, 0.2],
    more: [85, 16, 1.5, 2, 0.3], polufab: [160, 14, 8, 8, 0.3], konservy: [150, 20, 7, 0, 1.0], preservy: [250, 16, 20, 0, 1.5],
  };
  const FISH = [120, 19, 5, 0, 0.7];

  // Обработка меняет состав на 100 г: уходит вода → больше белка и калорий
  function processing(name, cid) {
    if (/вялен|юкол/.test(name) || cid === 'vyalenaya') return { k: 2.2, label: 'вяленая' };
    if (/г\/к|горячего копч|горячее копч/.test(name)) return { k: 1.3, label: 'горячего копчения' };
    if (/х\/к|холодного копч|холодное копч|подкопч/.test(name) || cid === 'kopch') return { k: 1.25, label: 'холодного копчения' };
    if (/жарен/.test(name) || cid === 'zharenaya') return { k: 1.35, label: 'жареная', fat: 6 };
    if (/солён|солен|соле|в масле/.test(name) || ['solenaya', 'preservy'].includes(cid)) return { k: 1.05, label: 'солёная' };
    return { k: 1, label: '' };
  }

  // Съедобная часть: целая рыба — без костей и головы, раки и креветки в панцире — только мясо
  function yieldOf(name, cid, mode) {
    if (/филе|стейк|мясо|нарезк|ломтик|кусок|котлет|икр|балык|трубк|медальон|рулет|тортик|ассорти|колбаск|косичк|фарш|суп|печень|бабочк/.test(name)) return 1;
    if (/очищ/.test(name) && /креветк|кальмар|мидии/.test(name)) return 1;
    if (/рак/.test(name) || cid === 'raki') return 0.15;
    if (/лангустин/.test(name)) return 0.35;
    if (/креветк/.test(name)) return 0.5;
    if (/мидии/.test(name)) return 0.3;
    if (/краб/.test(name)) return 1;
    if (['fresh', 'frozen', 'vyalenaya'].includes(cid) || /целая|целый|потрош/.test(name)) return 0.6;
    if (cid === 'kopch' && mode !== 'pack') return 0.7;
    return 1;
  }

  const r1 = n => Math.round(n * 10) / 10;

  function of(p) {
    const name = `${p.name || ''} ${p.note || ''}`.toLowerCase();
    const custom = p.nut && +p.nut.kcal > 0;
    let base;
    if (custom) base = [+p.nut.kcal, +p.nut.p || 0, +p.nut.f || 0, +p.nut.c || 0, +p.nut.o3 || 0];
    else {
      const row = TABLE.find(t => t[0].test(name));
      base = row ? row.slice(1) : BY_CAT[p.cid] || FISH;
    }
    let [kcal, pr, f, c, o3] = base;
    let label = '';
    if (!custom) {
      const pr0 = processing(name, p.cid);
      label = pr0.label;
      if (pr0.k !== 1) { kcal *= pr0.k; pr *= pr0.k; f *= pr0.k; o3 *= pr0.k; }
      if (pr0.fat) { f += pr0.fat; kcal += pr0.fat * 9; }
    }
    const y = custom && +p.nut.yield > 0 ? Math.min(1, +p.nut.yield / 100) : yieldOf(name, p.cid, p.unit === 'кг' ? (+p.piece_g ? 'piece' : 'weight') : 'pack');
    const n = { kcal: Math.round(kcal), p: r1(pr), f: r1(f), c: r1(c), o3: r1(o3), yield: y, custom: !!custom, label };
    n.tags = tags(n);
    n.micro = micro(name, p.cid);
    return n;
  }

  // Подсказки для тех, кто следит за питанием
  function tags(n) {
    const t = [];
    if (n.p >= 18 && n.f <= 5) t.push('Высокий белок, мало жира');
    else if (n.p >= 18) t.push('Высокий белок');
    if (n.o3 >= 1) t.push('Богато омега-3');
    if (n.kcal <= 100) t.push('До 100 ккал');
    if (n.c <= 1) t.push('Без углеводов');
    return t;
  }
  function micro(name, cid) {
    if (/икр/.test(name) || cid === 'ikra') return ['витамин D', 'B12', 'фосфор'];
    if (/лосос|сёмг|семг|форел|скумбри|сельд|нерк|кет|горбуш|кижуч|осётр|осетр/.test(name)) return ['витамин D', 'B12', 'селен'];
    if (/мидии|устриц|гребеш|краб|креветк|лангустин|кальмар|осьмин|рак|вонголе/.test(name) || ['more', 'krevetki', 'raki'].includes(cid)) return ['йод', 'цинк', 'селен'];
    return ['B12', 'фосфор', 'селен'];
  }

  // Сколько граммов продукта в строке корзины
  function packGrams(p) {
    const s = `${p.note || ''} ${p.name || ''}`.toLowerCase().replace(',', '.');
    const kg = s.match(/(\d+(?:\.\d+)?)\s*кг/);
    if (kg) return Math.round(+kg[1] * 1000);
    const g = s.match(/(\d+)\s*(?:гр|г)(?![а-яё])/);
    return g ? +g[1] : 0;
  }
  function gramsOf(p, q) {
    if (p.unit === 'кг') return +p.piece_g >= 50 ? +p.piece_g * q : q;
    return packGrams(p) * q;
  }

  // Ориентиры на день для взрослого (усреднённо): белок ~75 г, EPA+DHA — 250–500 мг, энергия ~2000 ккал
  const DAILY = { p: 75, o3: 0.5, kcal: 2000 };

  function order(lines, byId) {
    const t = { grams: 0, kcal: 0, p: 0, f: 0, c: 0, o3: 0, counted: 0, skipped: 0 };
    const micro = new Set();
    for (const l of lines) {
      const p = byId[l.id];
      if (!p) continue;
      const g = gramsOf(p, l.qty);
      if (!g) { t.skipped++; continue; }
      const n = of(p);
      const edible = g * n.yield;
      t.grams += edible;
      t.kcal += (n.kcal * edible) / 100;
      t.p += (n.p * edible) / 100;
      t.f += (n.f * edible) / 100;
      t.c += (n.c * edible) / 100;
      t.o3 += (n.o3 * edible) / 100;
      n.micro.forEach(m => micro.add(m));
      t.counted++;
    }
    return {
      grams: Math.round(t.grams), kcal: Math.round(t.kcal), p: Math.round(t.p), f: Math.round(t.f), c: Math.round(t.c), o3: r1(t.o3),
      proteinDays: r1(t.p / DAILY.p), omegaDays: Math.round(t.o3 / DAILY.o3), portions: Math.round(t.grams / 150),
      micro: [...micro].slice(0, 5), counted: t.counted, skipped: t.skipped,
    };
  }

  // Короткая строка КБЖУ: «141 ккал · Б 19,9 · Ж 6,2 · У 0»
  const num = v => String(v).replace('.', ',');
  const line = n => `${n.kcal} ккал · Б ${num(n.p)} · Ж ${num(n.f)} · У ${num(n.c)}`;

  return { of, gramsOf, packGrams, order, line, num, DAILY, TABLE };
});
