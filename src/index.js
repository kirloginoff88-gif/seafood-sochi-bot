// Запуск на обычном сервере (VPS, Docker): HTTP-сервер + боты в режиме polling или webhook
const { config, hub } = require('./app');
const catalog = require('./catalog');
const store = require('./store');
const server = require('./server');

(async () => {
  await catalog.sync();
  await server.start();
  if (!config.publicUrl) console.warn('[app] PUBLIC_URL не задан — кнопка «Открыть магазин» и вебхуки работать не будут');
  for (const pl of ['tg', 'max']) if (hub.adapters[pl]) await hub.adapters[pl].start().catch(e => console.error(`[${pl}] не запустился:`, e.message));
  if (!config.managerPin && !(await store.managers()).length) console.warn('[app] Задайте MANAGER_PIN или *_MANAGER_CHAT_IDS, иначе заказы некому получать');
})();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { store.flush(); process.exit(0); });
