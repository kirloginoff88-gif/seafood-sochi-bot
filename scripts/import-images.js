#!/usr/bin/env node
/*
 * Переносит фото, которые сейчас берутся по ссылкам с чужих сайтов, к себе на сервер (storage/uploads).
 * Стартовый каталог ссылается на фото с seafood-sochi.ru — запустите один раз после установки:
 *   npm run import-images            (или: docker compose exec bot npm run import-images)
 * Повторный запуск безопасен: уже перенесённые фото пропускаются.
 */
const catalog = require('../src/catalog');
const media = require('../src/media');

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!media.sniff(buf)) throw new Error('не похоже на фото');
  return buf;
}

async function importImages({ log = console.log } = {}) {
  catalog.load();
  const raw = catalog._raw();
  const jobs = [
    ...raw.cats.filter(c => /^https?:\/\//.test(c.image || '')).map(c => ({ kind: 'cat', id: c.cid, url: c.image, title: c.name })),
    ...raw.products.filter(p => /^https?:\/\//.test(p.image || '')).map(p => ({ kind: 'product', id: p.id, url: p.image, title: p.name })),
  ];
  const done = new Map(); // одно и то же фото у нескольких товаров скачиваем один раз
  let ok = 0, failed = 0;
  for (const j of jobs) {
    try {
      let local = done.get(j.url);
      if (!local) {
        const full = await download(j.url);
        const thumb = await download(catalog.thumbOf(j.url)).catch(() => null);
        local = media.saveImage(full, thumb);
        done.set(j.url, local);
      }
      catalog.setImage(j.kind, j.id, local);
      ok++;
    } catch (e) {
      failed++;
      log(`  ✗ ${j.title}: ${e.message}`);
    }
  }
  log(`Фото перенесено: ${ok}, не удалось: ${failed}, всего ссылок было: ${jobs.length}`);
  return { ok, failed, total: jobs.length };
}

if (require.main === module) importImages().catch(e => { console.error(e); process.exit(1); });
module.exports = { importImages };
