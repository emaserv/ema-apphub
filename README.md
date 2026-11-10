# EMA AppHub

Plataforma interna de **EMA Servicios** para registrar, almacenar, versionar, configurar y desplegar aplicaciones de cualquier tecnología sobre **Docker**. Funciona como repositorio centralizado de aplicaciones y como gestor de despliegues (similar a una combinación simplificada de GitLab + Portainer + Registry + PaaS + administrador PostgreSQL).

| Documento | Contenido |
|---|---|
| [docs/01-ARQUITECTURA.md](docs/01-ARQUITECTURA.md) | Arquitectura, componentes, modelo de datos, flujo de deploy, API y seguridad |
| [docs/INSTRUCTIVO-SUBIR-APLICACIONES.md](docs/INSTRUCTIVO-SUBIR-APLICACIONES.md) | **Instructivo paso a paso para subir y desplegar aplicaciones** |
| `/api/docs` | Documentación interactiva de la API (Swagger / OpenAPI 3) |

---

## Funcionalidades

* Alta de aplicaciones por **ZIP**, **repositorio Git** (público, token, usuario/clave o clave SSH; branch, tag o commit), **carga de carpeta** desde el navegador o **proyecto vacío**.
* **Detección automática de tecnología** (HTML/CSS/JS, React, Vue, Angular, Svelte, Next.js, Nuxt, NestJS, Node.js, Python Django/FastAPI/Flask, PHP/Laravel, Java Maven/Gradle, .NET, Go o Dockerfile propio) con corrección manual.
* **Generación automática de Dockerfile** por tecnología (multi-stage, imágenes de producción) y edición desde la interfaz.
* **docker-compose por ambiente** generado automáticamente (app + PostgreSQL opcional + labels Traefik).
* **Ambientes** Desarrollo / Test / Staging / Producción con código, variables, base, puerto y dominio independientes.
* **Variables de entorno** con secretos cifrados (AES-256-GCM), importación/exportación `.env`.
* **Puertos** con detección de conflictos, **volúmenes** persistentes, límites de CPU/RAM.
* **Ciclo de vida real de contenedores**: deploy, iniciar, detener, reiniciar, recrear, eliminar.
* **Versionado** completo (código + Dockerfile + compose + variables + commit + comentario) y **rollback** a cualquier versión; **rollback automático** si el deploy falla.
* **Pipeline CI/CD**: código → validación → build → tests → imagen (push opcional a registry) → deploy → health check.
* **Health checks** periódicos por HTTP.
* **Avisos** (campanita) para los superadministradores: deploy fallido, app caída (2 health checks seguidos) y recuperada, backup programado fallido. Se borran a los 90 días.
* **PostgreSQL por ambiente**: crear, eliminar, reiniciar, estado, conexión, logs, usuarios (lectura / lectura-escritura), rotación de credenciales.
* **Backups** de aplicación (tar.gz) y base (`pg_dump -Fc`): manuales, programados (cron + retención), descarga, restauración, historial.
* **Logs en tiempo real** (WebSocket) con pausa, búsqueda, filtro por fecha y descarga; logs de app y de PostgreSQL.
* **Terminal web** (`docker exec` con TTY) sólo para el permiso `terminal.access`, con auditoría de comandos.
* **Clonación** de aplicaciones (ej. CRM Producción → CRM Desarrollo).
* **Dominios + HTTPS** con Traefik y Let's Encrypt, redirección HTTP→HTTPS.
* **Docker registries** (local, Docker Hub, GHCR, privado).
* **Webhooks Git** (GitHub, GitLab, Bitbucket) para actualizar/desplegar en cada push.
* **Usuarios y RBAC** (Super Administrador, Administrador, Desarrollador, Consulta) y **auditoría** completa.
* **Dashboard** con estado de aplicaciones, CPU/RAM/disco del servidor, contenedores y consumo por app.

## Arquitectura (resumen)

```
Traefik (80/443) ──► frontend (Nginx + React/Vite) ──► backend (Node 20 + TypeScript + Express)
        │                                                   │  ├─ PostgreSQL de la plataforma
        └──► aplicaciones desplegadas (red ema_apps)  ◄─────┘  └─ /var/run/docker.sock (único acceso)
```

```
ema-apphub/
├── backend/            API REST + WebSockets (src/routes, src/services, src/ws)
├── frontend/           SPA React + TypeScript + Vite (estética EMA Servicios)
├── database/           migraciones SQL + seeds (roles y permisos)
├── docker/traefik/     configuración dinámica de Traefik
├── docs/               diseño e instructivo
├── scripts/            install, backup, restore, update, fetch-logo
├── storage/            directorio de datos para desarrollo local
├── docker-compose.yml
└── .env.example
```

> Cada servicio tiene su propio Dockerfile (`backend/Dockerfile`, `frontend/Dockerfile`); el `docker-compose.yml` de la raíz los orquesta.

---

## Requisitos

| Recurso | Mínimo | Recomendado |
|---|---|---|
| SO | Linux x86_64 (Ubuntu 22.04/24.04, Debian 12, RHEL 9) | Ubuntu 24.04 LTS |
| Docker Engine | 24+ con Compose v2 y Buildx | 27+ |
| CPU / RAM | 2 vCPU / 4 GB | 4+ vCPU / 8+ GB (cada app suma su consumo) |
| Disco | 40 GB | 100+ GB (imágenes, versiones y backups) |
| Red | Puertos 80, 443 y 8080 (o los configurados) | DNS de los dominios apuntando al servidor |

## Instalación

```bash
git clone <url-del-repositorio> ema-apphub
cd ema-apphub
cp .env.example .env          # editar secretos y dominios
docker compose up -d
```

O con el instalador, que genera secretos aleatorios, crea `DATA_DIR`, descarga el logo y levanta todo:

```bash
sudo ./scripts/install.sh
```

Acceso:

* Sin dominio: `http://IP-DEL-SERVIDOR:8080`
* Con dominio: `https://apphub.emaservicios.com.ar` (variable `PLATFORM_DOMAIN`)

Usuario inicial: `ADMIN_USERNAME` / `ADMIN_PASSWORD` del `.env`. En el primer ingreso se exige cambiar la contraseña.

Detener: `docker compose down` (los datos persisten en `DATA_DIR` y en los volúmenes Docker). Las aplicaciones desplegadas son proyectos Compose independientes (`ema-<app>-<ambiente>`) y siguen funcionando aunque la plataforma esté detenida; por eso Compose puede avisar que la red `ema_apps` "tiene endpoints activos" al bajar la plataforma: es esperado.

### Logo

El frontend usa `frontend/public/logo-ema.png` (logo principal de www.emaservicios.com.ar). `scripts/fetch-logo.sh` y el build del frontend lo descargan automáticamente; si el servidor no tiene salida a Internet, copie el archivo manualmente en esa ruta. Si falta, se muestra un isologo tipográfico con los colores institucionales.

## Configuración (`.env`)

| Variable | Descripción | Por defecto |
|---|---|---|
| `PLATFORM_DOMAIN` | Dominio de la interfaz (Traefik + HTTPS) | `apphub.localhost` |
| `PLATFORM_HTTP_PORT` | Puerto de acceso directo a la interfaz | `8080` |
| `HTTP_PORT` / `HTTPS_PORT` | Puertos públicos de Traefik | `80` / `443` |
| `ACME_EMAIL` | Email para Let's Encrypt | — |
| `COOKIE_SECURE` | `true` sólo si se accede siempre por HTTPS | `false` |
| `CORS_ORIGINS` | Orígenes adicionales permitidos (coma) | vacío |
| `POSTGRES_DB/USER/PASSWORD` | Base de la plataforma | `apphub` |
| `JWT_SECRET` | Firma de sesiones (`openssl rand -hex 32`) | **obligatorio** |
| `MASTER_KEY` | Clave de cifrado de secretos. **Respaldar**: sin ella no se descifran credenciales | **obligatorio** |
| `ADMIN_USERNAME/EMAIL/PASSWORD` | Super administrador inicial | `admin` |
| `DATA_DIR` | Carpeta del host para código, versiones, compose y backups | `/opt/ema-apphub/data` |
| `APPS_NETWORK` | Red Docker compartida con Traefik | `ema_apps` |
| `PUBLIC_HOST` | IP/host para armar URLs `http://host:puerto` | `localhost` |
| `APPS_BASE_DOMAIN` | Dominio base sugerido | — |
| `PORT_RANGE_START/END` | Rango de puertos externos auto-asignados | `8100–8999` |
| `MAX_UPLOAD_MB` | Tamaño máximo de ZIP | `500` |
| `BUILD_TIMEOUT_MIN` | Tiempo máximo de build | `30` |
| `DEPLOY_HEALTH_WAIT_SEC` | Espera del health check en un deploy | `90` |
| `HEALTH_INTERVAL_SEC` | Frecuencia de health checks | `60` |
| `TERMINAL_ENABLED` | Habilita la terminal web | `true` |

## Puertos

| Puerto | Servicio |
|---|---|
| 80 / 443 | Traefik (dominios de la plataforma y de las apps, HTTPS) |
| 8080 | Interfaz EMA AppHub (acceso directo) |
| 8100–8999 | Puertos externos de las aplicaciones (configurable) |
| interno 4000 | API (no expuesta; accesible vía `/api`) |
| interno 5432 | PostgreSQL de la plataforma y de cada app (sólo redes internas) |

## Volúmenes y datos

| Ubicación | Contenido |
|---|---|
| `DATA_DIR/applications/<app>/versions/<v>/source` | Código de cada versión |
| `DATA_DIR/applications/<app>/environments/<amb>` | `docker-compose.yml`, `.env`, `db.env` generados (0600) |
| `DATA_DIR/applications/<app>/data/` | Carpetas montadas como "Carpeta del servidor" |
| `DATA_DIR/backups/<app>/` | Backups `.tar.gz` y `.dump` |
| volumen `ema-apphub_platform_db` | Base de la plataforma |
| volumen `ema-<app>-<amb>-dbdata` | Base PostgreSQL de cada ambiente |
| volumen `ema-apphub_traefik_certs` | Certificados Let's Encrypt |

## Backups de la plataforma

Los backups de cada aplicación se gestionan desde la interfaz. Para respaldar **la plataforma completa** (base de AppHub + `DATA_DIR` + `.env`):

```bash
./scripts/backup-platform.sh /ruta/destino
# cron diario recomendado:
0 2 * * * /opt/ema-apphub/scripts/backup-platform.sh /mnt/backups/apphub
```

Copie los respaldos fuera del servidor. El `.env` contiene `MASTER_KEY`: guárdelo en un lugar seguro.

## Actualización

```bash
./scripts/update.sh      # backup → git pull → build → up -d (las migraciones se aplican solas)
```

## Recuperación ante fallos

| Situación | Acción |
|---|---|
| Deploy fallido | Automático: rollback a la última versión exitosa. Revise el log en *Deployments*. |
| App caída | *Reiniciar* o *Recrear* desde la app; ver *Logs*. Docker la reinicia sola (`restart: unless-stopped`). |
| Base de una app dañada | *Backups → Restaurar* el `.dump` deseado. |
| Reinicio del servidor | Todos los contenedores vuelven solos. Deploys interrumpidos quedan marcados como fallidos. |
| Servidor perdido | Nuevo servidor → instalar → `./scripts/restore-platform.sh <dump> <data.tar.gz>` con el `.env` original → *Deploy* de cada app (las imágenes se reconstruyen desde las versiones guardadas). |
| Se perdió `MASTER_KEY` | Los secretos no pueden recuperarse: recargue variables secretas y rote contraseñas de bases. |

## Seguridad

* Sesión JWT en cookie `httpOnly` + `SameSite=Strict`, token CSRF de doble envío, contraseñas bcrypt, rate limiting (login: 10 intentos / 15 min).
* RBAC granular por permiso; producción requiere `apps.deploy.prod`.
* Secretos cifrados (AES-256-GCM) y nunca devueltos por la API.
* El socket Docker sólo lo ve el backend; los comandos se ejecutan sin shell y sólo sobre contenedores con label `ema.managed=true`.
* Validación de ZIP (zip-slip, zip-bomb, enlaces simbólicos), límites de tamaño, URLs/refs Git validadas.
* Auditoría de todas las acciones (usuario, fecha, IP, app, acción, resultado), incluidos los comandos de la terminal.
* Endurecimiento opcional: `docker-socket-proxy`, firewall que sólo exponga 80/443, `TERMINAL_ENABLED=false` en producción, `COOKIE_SECURE=true` con HTTPS.

## Desarrollo local

```bash
# PostgreSQL local y Docker en ejecución
cd backend && npm install && DATABASE_URL=postgres://apphub:apphub@localhost:5432/apphub npm run dev
cd frontend && npm install && npm run dev      # http://localhost:5173 (proxy a :4000)
```

## Escalabilidad futura

El acceso al runtime está concentrado en `backend/src/services/docker.ts`, lo que permite agregar múltiples hosts Docker (`DOCKER_HOST` por servidor), un driver Kubernetes, réplicas balanceadas por Traefik, exportación de métricas a Prometheus/Grafana y alertas (email, Slack, Teams, webhooks) a partir de los eventos ya persistidos (deployments, health checks, auditoría).
