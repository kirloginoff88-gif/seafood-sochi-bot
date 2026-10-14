// Реестр адаптеров: позволяет отправить сообщение пользователю на любой платформе
// (нужно для уведомлений менеджеру и статусов заказа покупателю).
const adapters = {};

function register(platform, adapter) { adapters[platform] = adapter; }
function has(platform) { return !!adapters[platform]; }

// target: { chatId } или { userId } (MAX умеет писать по user_id, Telegram — chat_id = user_id в личке)
async function send(platform, target, view) {
  const a = adapters[platform];
  if (!a) return null;
  try { return await a.send(target, view); }
  catch (e) { console.error(`[hub] ${platform} send failed:`, e.message); return null; }
}
async function edit(platform, target, msgId, view) {
  const a = adapters[platform];
  if (!a || !msgId) return null;
  try { return await a.edit(target, msgId, view); }
  catch (e) { console.error(`[hub] ${platform} edit failed:`, e.message); return null; }
}

module.exports = { register, has, send, edit, adapters };
