// Настройки из .env (без внешних библиотек)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = (k, d = '') => (process.env[k] ?? d).trim();
const list = k => env(k).split(',').map(s => s.trim()).filter(Boolean);

const config = {
  root: ROOT,
  port: +env('PORT', '8080'),
  // Публичный адрес сервера с HTTPS, например https://bot.seafood-sochi.ru
  // На Vercel адрес берётся сам из VERCEL_PROJECT_PRODUCTION_URL (например seafood-sochi-bot.vercel.app)
  publicUrl: (env('PUBLIC_URL') || (env('VERCEL_PROJECT_PRODUCTION_URL') ? 'https://' + env('VERCEL_PROJECT_PRODUCTION_URL') : '')).replace(/\/$/, ''),
  serverless: !!env('VERCEL'),
  // Рабочие данные: каталог, фото, заказы. В git не попадают.
  // На Vercel диск только для чтения: без Redis пишем во временную папку (данные не сохранятся надолго)
  dataDir: path.resolve(ROOT, env('DATA_DIR', env('VERCEL') ? require('os').tmpdir() + '/seafood' : 'storage')),

  telegram: {
    token: env('TG_TOKEN'),
    mode: env('TG_MODE', 'polling'), // polling | webhook
    webhookSecret: env('TG_WEBHOOK_SECRET'),
    managers: list('TG_MANAGER_CHAT_IDS'),
  },
  max: {
    token: env('MAX_TOKEN'),
    botName: env('MAX_BOT_NAME'), // публичное имя бота, к которому привязано мини-приложение
    api: env('MAX_API', 'https://platform-api2.max.ru'),
    mode: env('MAX_MODE', 'polling'), // polling | webhook
    webhookSecret: env('MAX_WEBHOOK_SECRET'),
    managers: list('MAX_MANAGER_CHAT_IDS'),
  },

  // Код, которым сотрудник подключается к уведомлениям: /manager 4821
  managerPin: env('MANAGER_PIN'),

  // Админ-панель /admin. Без пароля панель выключена.
  admin: {
    password: env('ADMIN_PASSWORD'),
  },

  // Битрикс24: входящий вебхук с правами crm, например https://xxx.bitrix24.ru/rest/1/abcdef/
  b24: {
    webhook: env('B24_WEBHOOK').replace(/\/?$/, '/'),
    entity: env('B24_ENTITY', 'lead'), // lead | deal
    sourceId: env('B24_SOURCE_ID', ''),
    assignedId: env('B24_ASSIGNED_ID', ''),
  },

  // Заказы из браузера (не из мессенджера) — по умолчанию разрешены, но помечаются
  allowWebOrders: env('ALLOW_WEB_ORDERS', '1') === '1',
  timeSlots: list('TIME_SLOTS').length ? list('TIME_SLOTS') : ['Сегодня до 15:00', 'Сегодня 15:00–21:00', 'Завтра 9:00–13:00', 'Завтра 13:00–17:00', 'Завтра 17:00–21:00'],
  payments: ['Наличными', 'Картой через терминал', 'По QR-коду'],
};

config.b24.enabled = !!env('B24_WEBHOOK');
// Секреты вебхуков: если не заданы — выводим из токена, чтобы не хранить ещё одну переменную
const derive = (label, token) => crypto.createHash('sha256').update(label + ':' + token).digest('hex').slice(0, 48);
config.telegram.webhookSecret ||= derive('tg-hook', config.telegram.token);
config.max.webhookSecret ||= derive('max-hook', config.max.token);
// Секрет для подписи сессий админки; смена пароля разлогинивает всех
config.admin.secret = crypto.createHash('sha256').update('sf-admin:' + config.admin.password).digest();
config.appUrl = platform => `${config.publicUrl}/app/?p=${platform}`;
config.uploadsDir = path.join(config.dataDir, 'uploads');

module.exports = config;
