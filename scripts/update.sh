#!/usr/bin/env bash
# Actualiza EMA AppHub a la última versión del repositorio (las migraciones se aplican al iniciar)
set -euo pipefail
cd "$(dirname "$0")/.."
./scripts/backup-platform.sh
git pull --ff-only
docker compose build --pull
docker compose up -d
docker image prune -f >/dev/null
echo "✔ Plataforma actualizada"
