// Фото товаров: сохранение загруженных из админки и раздача по /media/<имя>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const MAX_BYTES = 4 * 1024 * 1024;

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

// Сохраняет основное фото и миниатюру (<имя>_t.<ext>). Возвращает путь вида /media/xxxx.jpg
function saveImage(full, thumb) {
  const ext = sniff(full);
  if (!ext) throw new Error('Поддерживаются фото JPG, PNG и WebP');
  if (full.length > MAX_BYTES) throw new Error('Фото больше 4 МБ');
  const thumbExt = thumb ? sniff(thumb) : null;
  const name = crypto.randomBytes(8).toString('hex');
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(config.uploadsDir, `${name}.${ext}`), full);
  // у миниатюры то же расширение, что и у основного файла — так её находит thumbOf()
  fs.writeFileSync(path.join(config.uploadsDir, `${name}_t.${ext}`), thumbExt === ext && thumb.length <= MAX_BYTES ? thumb : full);
  return `/media/${name}.${ext}`;
}

function filePath(urlPath) {
  const name = path.basename(urlPath);
  if (!/^[a-z0-9_-]+\.(jpg|png|webp)$/.test(name)) return null;
  return path.join(config.uploadsDir, name);
}

module.exports = { saveImage, fromDataUrl, filePath, sniff, MAX_BYTES };
