#!/usr/bin/env bash
# Copia el logo principal de www.emaservicios.com.ar a frontend/public/logo-ema.png
set -euo pipefail
cd "$(dirname "$0")/.."
DEST=frontend/public/logo-ema.png
[ -s "$DEST" ] && { echo "✔ Logo ya presente ($DEST)"; exit 0; }
URL="${LOGO_URL:-https://www.emaservicios.com.ar/images/logo-color.png}"
echo "▶ Descargando logo desde $URL"
if command -v curl >/dev/null; then curl -fsSL "$URL" -o "$DEST"; else wget -qO "$DEST" "$URL"; fi
echo "✔ Logo guardado en $DEST"
