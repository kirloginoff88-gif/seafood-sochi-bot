// Фото товаров: сохранение загруженных из админки и раздача по /media/<имя>.
// На сервере (файловое хранилище) — папка storage/uploads; на Vercel — в Redis (media:<имя>).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');

const MAX_BYTES = 3 * 1024 * 1024; // Vercel принимает запрос до 4,5 МБ, а base64 раздувает на треть
const inRedis = db.kind === 'redis';

// Определяем формат по первым байтам — расширению и MIME из браузера не верим
function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

function fromDataUrl(s) {
  const m = /^data:image\/[a-z+]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(s || ''));
  return m ? Buffer.from(m[1], 'base64') : null;
}

const safeName = urlPath => { const n = path.basename(String(urlPath)); return /^[a-z0-9_-]+\.(jpg|png|webp)$/.test(n) ? n : null; };

async function put(name, buf) {
  if (inRedis) return db.set(`media:${name}`, buf.toString('base64'));
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(config.uploadsDir, name), buf);
}

// Сохраняет фото и миниатюру (<имя>_t.<ext>). Возвращает путь вида /media/xxxx.jpg
async function saveImage(full, thumb) {
  const ext = sniff(full);
  if (!ext) throw new Error('Поддерживаются фото JPG, PNG и WebP');
  if (full.length > MAX_BYTES) throw new Error('Фото больше 3 МБ');
  const name = crypto.randomBytes(8).toString('hex');
  await put(`${name}.${ext}`, full);
  // у миниатюры то же расширение, что и у основного файла — так её находит thumbOf()
  await put(`${name}_t.${ext}`, thumb && sniff(thumb) === ext && thumb.length <= MAX_BYTES ? thumb : full);
  return `/media/${name}.${ext}`;
}

async function read(urlPath) {
  const name = safeName(urlPath);
  if (!name) return null;
  if (inRedis) { const b64 = await db.get(`media:${name}`); return b64 ? Buffer.from(b64, 'base64') : null; }
  try { return fs.readFileSync(path.join(config.uploadsDir, name)); } catch { return null; }
}

async function remove(urlPath) {
  const name = safeName(urlPath);
  if (!name) return;
  const thumb = name.replace(/\.(jpg|png|webp)$/, '_t.$1');
  if (inRedis) return db.del(`media:${name}`, `media:${thumb}`);
  for (const n of [name, thumb]) fs.rmSync(path.join(config.uploadsDir, n), { force: true });
}

module.exports = { saveImage, fromDataUrl, read, remove, sniff, MAX_BYTES };
