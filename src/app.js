// Общая инициализация: подключаем адаптеры мессенджеров, для которых заданы токены
const config = require('./config');
const hub = require('./hub');

if (config.telegram.token) hub.register('tg', require('./adapters/telegram'));
if (config.max.token) hub.register('max', require('./adapters/max'));

module.exports = { config, hub };
