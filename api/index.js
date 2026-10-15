// Точка входа на Vercel: все адреса (/app, /admin, /api, /webhook, /media) ведут сюда.
// Боты работают через вебхуки — подключаются кнопкой в админке: Настройки → Подключение.
require('../src/app');
const server = require('../src/server');

module.exports = (req, res) => server.handle(req, res);
