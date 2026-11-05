# EMA AppHub · frontend (React + Vite servido por Nginx)
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Logo principal de EMA Servicios: si no está en public/, se intenta descargar del sitio institucional.
ARG LOGO_URL=https://www.emaservicios.com.ar/images/logo-color.png
RUN [ -s public/logo-ema.png ] || wget -q -T 20 -O public/logo-ema.png "$LOGO_URL" || rm -f public/logo-ema.png; true
RUN npm run build

FROM nginx:1.30-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
