#!/usr/bin/env bash
# Recuperación ante fallos: restaura base de la plataforma y DATA_DIR
# Uso: ./scripts/restore-platform.sh <apphub-db-XXXX.dump> <apphub-data-XXXX.tar.gz>
set -euo pipefail
cd "$(dirname "$0")/.."
[ $# -eq 2 ] || { echo "Uso: $0 <dump> <data.tar.gz>"; exit 1; }
set -a; . ./.env; set +a
read -rp "Esto reemplaza la base y los archivos actuales. ¿Continuar? (si/no) " ok; [ "$ok" = "si" ] || exit 1
docker compose up -d platform-db
sleep 5
docker compose stop backend
echo "▶ Restaurando base"
docker compose exec -T platform-db pg_restore -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" --clean --if-exists < "$1"
echo "▶ Restaurando archivos en $(dirname "${DATA_DIR}")"
tar -xzf "$2" -C "$(dirname "${DATA_DIR}")"
docker compose up -d
echo "✔ Restaurado. Redespliegue las aplicaciones desde la interfaz (o use 'Iniciar') si sus contenedores no existen."
