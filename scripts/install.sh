#!/usr/bin/env bash
# EMA AppHub — instalación en un servidor Linux nuevo
# Uso: sudo ./scripts/install.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▶ Verificando requisitos…"
command -v docker >/dev/null || { echo "✖ Docker no está instalado: https://docs.docker.com/engine/install/"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "✖ Falta el plugin Docker Compose v2"; exit 1; }
command -v openssl >/dev/null || { echo "✖ Falta openssl"; exit 1; }

if [ ! -f .env ]; then
  echo "▶ Creando .env con secretos aleatorios…"
  cp .env.example .env
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" .env
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env
  sed -i "s|^MASTER_KEY=.*|MASTER_KEY=$(openssl rand -hex 32)|" .env
  ADMIN_PW="Ema$(openssl rand -hex 6)"
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=${ADMIN_PW}|" .env
  # || true: si "hostname -I" no existe en la distribución, sigue con el valor de ejemplo en vez de cortar en silencio
  IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  [ -n "${IP:-}" ] && sed -i "s|^PUBLIC_HOST=.*|PUBLIC_HOST=${IP}|" .env
  chmod 600 .env
  # Se detiene acá a propósito: si arrancara con los valores de ejemplo, Traefik pediría certificados
  # para un dominio que quizás todavía no apunta al servidor, y la MASTER_KEY quedaría sin respaldar.
  echo
  echo "✔ Se creó .env. Usuario inicial: admin / ${ADMIN_PW}  (se pedirá cambiarla al ingresar)"
  echo "  Antes de continuar:"
  echo "   1. Revise .env: PLATFORM_DOMAIN, ACME_EMAIL, PUBLIC_HOST y COOKIE_SECURE (ver docs/INSTALACION-SERVIDOR.md)."
  echo "   2. Guarde la MASTER_KEY de .env en el gestor de contraseñas de la empresa."
  echo "  Después vuelva a ejecutar: sudo ./scripts/install.sh"
  exit 0
fi

if grep -q 'CAMBIAR_' .env; then
  echo "✖ .env todavía tiene valores de ejemplo (CAMBIAR_…) en:"
  grep -n 'CAMBIAR_' .env | cut -d= -f1
  exit 1
fi

set -a; . ./.env; set +a
echo "▶ Preparando ${DATA_DIR}…"
mkdir -p "${DATA_DIR}"/{applications,backups,databases,logs,tmp}
chmod 750 "${DATA_DIR}"

./scripts/fetch-logo.sh || true

echo "▶ Construyendo e iniciando contenedores…"
docker compose up -d --build

echo "▶ Esperando a la API…"
for i in $(seq 1 60); do
  if docker compose exec -T backend wget -qO- http://127.0.0.1:4000/api/health >/dev/null 2>&1; then
    echo "✔ EMA AppHub en línea:"
    echo "   http://${PUBLIC_HOST:-localhost}:${PLATFORM_HTTP_PORT:-8080}"
    [ -n "${PLATFORM_DOMAIN:-}" ] && echo "   https://${PLATFORM_DOMAIN}"
    echo "  Siga con la verificación de docs/INSTALACION-SERVIDOR.md."
    exit 0
  fi
  sleep 3
done
echo "✖ La API no respondió. Revise: docker compose logs backend"; exit 1
