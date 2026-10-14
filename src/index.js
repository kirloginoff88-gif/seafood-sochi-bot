// Точка входа: каталог → HTTP-сервер → боты Telegram и MAX
const config = require('./config');
const catalog = require('./catalog');
const store = require('./store');
const hub = require('./hub');
const server = require('./server');
const tg = require('./adapters/telegram');
const max = require('./adapters/max');

(async () => {
  catalog.start();
  if (config.telegram.token) hub.register('tg', tg);
  if (config.max.token) hub.register('max', max);
  await server.start();
  if (!config.publicUrl) console.warn('[app] PUBLIC_URL не задан — кнопка «Открыть магазин» и вебхуки работать не будут');
  await tg.start().catch(e => console.error('[tg] не запустился:', e.message));
  await max.start().catch(e => console.error('[max] не запустился:', e.message));
  if (!config.managerPin && !store.managers().length) console.warn('[app] Задайте MANAGER_PIN или *_MANAGER_CHAT_IDS, иначе заказы некому получать');
})();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { store.flush(); process.exit(0); });
