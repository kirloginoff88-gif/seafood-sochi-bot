// Проверка подписи initData мини-приложения. Алгоритм одинаковый у Telegram и MAX:
// secret = HMAC_SHA256(key="WebAppData", msg=BOT_TOKEN); hash = hex(HMAC_SHA256(secret, data_check_string))
// data_check_string — все поля кроме hash, отсортированные по ключу, в виде key=value через \n.
const crypto = require('crypto');

function validate(initData, token, maxAgeSec = 24 * 3600) {
  if (!initData || !token) return null;
  const params = new URLSearchParams(initData);
  const hashes = params.getAll('hash');
  if (hashes.length !== 1) return null;
  const hash = String(hashes[0]).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) return null; // Buffer.from(hex) молча обрезает мусор — проверяем формат явно
  params.delete('hash');
  const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  const a = Buffer.from(calc, 'hex'), b = Buffer.from(String(hash), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const authDate = +params.get('auth_date') || 0;
  // auth_date — в секундах; на всякий случай понимаем и миллисекунды
  const ts = authDate > 1e12 ? authDate / 1000 : authDate;
  if (maxAgeSec && (!ts || Date.now() / 1000 - ts > maxAgeSec)) return null;
  const parse = k => { try { return JSON.parse(params.get(k)); } catch { return null; } };
  return { user: parse('user'), chat: parse('chat'), startParam: params.get('start_param') || '', authDate: ts };
}

// Для тестов: собрать подписанную строку initData
function sign(fields, token) {
  const params = new URLSearchParams(fields);
  const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}

module.exports = { validate, sign };
