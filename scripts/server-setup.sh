#!/usr/bin/env bash
# Установка магазина Seafood Сочи на сервер в России (Ubuntu 22.04/24.04), без Docker.
#   Node.js — с nodejs.org, Caddy (HTTPS) — с GitHub, код — из приватного репозитория по ключу развёртывания.
# Запуск на сервере от root:   bash server-setup.sh
# Повторный запуск безопасен: обновит код и перезапустит магазин, .env не трогает.
set -euo pipefail

REPO="git@github.com:kirloginoff88-gif/seafood-sochi-bot.git"
APP=/opt/seafood
NODE_MAJOR=22
CADDY_VER=2.8.4
KEY=/root/.ssh/seafood_deploy

say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ask() { local v; read -r -p "$1: " v </dev/tty; printf '%s' "$v"; }
asks() { local v; read -r -s -p "$1: " v </dev/tty; echo >&2; printf '%s' "$v"; }

[ "$(id -u)" = 0 ] || { echo "Запустите от root: sudo bash server-setup.sh"; exit 1; }
case "$(uname -m)" in x86_64) ARCH=x64; CARCH=amd64 ;; aarch64) ARCH=arm64; CARCH=arm64 ;; *) echo "Неизвестная архитектура"; exit 1 ;; esac

say "1/6 Системные пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates xz-utils >/dev/null

say "2/6 Node.js ${NODE_MAJOR}"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  FILE=$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" | grep -o "node-v[0-9.]*-linux-${ARCH}.tar.xz" | head -1)
  curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/${FILE}" -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
  rm -f /tmp/node.tar.xz
fi
node -v

say "3/6 Caddy (HTTPS-сертификат выпускается сам)"
if ! command -v caddy >/dev/null; then
  curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VER}/caddy_${CADDY_VER}_linux_${CARCH}.tar.gz" -o /tmp/caddy.tgz
  tar -xzf /tmp/caddy.tgz -C /usr/local/bin caddy
  rm -f /tmp/caddy.tgz
fi
caddy version

say "4/6 Код магазина из GitHub"
if [ ! -d "$APP/.git" ]; then
  mkdir -p /root/.ssh && chmod 700 /root/.ssh
  [ -f "$KEY" ] || ssh-keygen -t ed25519 -N "" -f "$KEY" -C "seafood-server" >/dev/null
  ssh-keyscan -t ed25519 github.com >> /root/.ssh/known_hosts 2>/dev/null
  cat > /root/.ssh/config <<EOF
Host github.com
  IdentityFile $KEY
  IdentitiesOnly yes
EOF
  echo
  echo "Добавьте этот ключ в GitHub: репозиторий seafood-sochi-bot → Settings → Deploy keys → Add deploy key"
  echo "(название любое, галочку «Allow write access» НЕ ставить):"
  echo
  cat "$KEY.pub"
  echo
  read -r -p "Когда добавите — нажмите Enter… " _ </dev/tty
  git clone -q "$REPO" "$APP"
else
  git -C "$APP" pull -q --ff-only
fi

say "5/6 Настройки (.env)"
if [ ! -f "$APP/.env" ]; then
  echo "Значения возьмите в Vercel: проект → Settings → Environment Variables (глазок показывает значение)."
  DOMAIN=$(ask "Адрес магазина [shop.seafood-sochi.ru]"); DOMAIN=${DOMAIN:-shop.seafood-sochi.ru}
  TG=$(asks "TG_TOKEN (токен Telegram-бота)")
  MAXT=$(asks "MAX_TOKEN (токен бота MAX, можно пусто)")
  ADM=$(asks "ADMIN_PASSWORD (пароль админки)")
  PIN=$(ask "MANAGER_PIN (код менеджера)")
  KVU=$(ask "KV_REST_API_URL (база Upstash — чтобы перенести все заказы и каталог)")
  KVT=$(asks "KV_REST_API_TOKEN")
  umask 077
  cat > "$APP/.env" <<EOF
PORT=8080
DOMAIN=$DOMAIN
PUBLIC_URL=https://$DOMAIN
DATA_DIR=$APP/storage
ADMIN_PASSWORD=$ADM
MANAGER_PIN=$PIN
TG_TOKEN=$TG
TG_MODE=webhook
MAX_TOKEN=$MAXT
MAX_MODE=webhook
KV_REST_API_URL=$KVU
KV_REST_API_TOKEN=$KVT
ALLOW_WEB_ORDERS=1
EOF
  umask 022
fi
DOMAIN=$(grep -E '^DOMAIN=' "$APP/.env" | cut -d= -f2)
mkdir -p "$APP/storage"

say "6/6 Службы: магазин и HTTPS"
cat > /etc/systemd/system/seafood.service <<EOF
[Unit]
Description=Seafood Сочи — бот и магазин
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$APP
EnvironmentFile=$APP/.env
ExecStart=/usr/local/bin/node src/start.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:8080
}
EOF
cat > /etc/systemd/system/caddy.service <<EOF
[Unit]
Description=Caddy (HTTPS)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile
Environment=XDG_DATA_HOME=/var/lib XDG_CONFIG_HOME=/etc
Restart=always
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF

# Команда обновления: seafood-update
cat > /usr/local/bin/seafood-update <<EOF
#!/usr/bin/env bash
set -e
git -C $APP pull --ff-only
systemctl restart seafood
sleep 2
systemctl --no-pager --lines=5 status seafood
EOF
chmod +x /usr/local/bin/seafood-update

command -v ufw >/dev/null && ufw status | grep -q active && { ufw allow 80/tcp; ufw allow 443/tcp; } || true

systemctl daemon-reload
systemctl enable -q --now caddy seafood
systemctl restart seafood caddy
sleep 5

IP=$(curl -fsS4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
echo
echo "✅ Готово. Магазин: https://$DOMAIN   Админка: https://$DOMAIN/admin"
echo "   IP сервера: $IP — в DNS должна быть A-запись ${DOMAIN%%.*} → $IP"
echo "   Логи: journalctl -u seafood -f      Обновить код: seafood-update"
echo
systemctl --no-pager --lines=8 status seafood || true
