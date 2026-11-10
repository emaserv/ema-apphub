# EMA AppHub — Diseño de la plataforma

Plataforma interna de EMA Servicios para **almacenar, versionar, configurar y desplegar** aplicaciones de cualquier tecnología sobre Docker. Combina en forma simplificada: repositorio de aplicaciones + Portainer + registry + PaaS + administrador PostgreSQL.

---

## 1. Arquitectura general

```
                         Internet / Red interna
                                  │
                       ┌──────────▼──────────┐
                       │      Traefik v3      │  :80 / :443  (Let's Encrypt, HTTP→HTTPS)
                       │  reverse proxy       │  descubre contenedores por labels
                       └───┬─────────────┬────┘
           apphub.dominio  │             │   crm.dominio / psm.dominio / ...
                ┌──────────▼───┐   ┌─────▼───────────────────────────────┐
                │  frontend    │   │  Aplicaciones desplegadas (red       │
                │  Nginx + SPA │   │  ema_apps): ema-crm-production,      │
                │  React/Vite  │   │  ema-crm-production-db (PostgreSQL)… │
                └──────┬───────┘   └─────▲───────────────────────────────┘
                       │ /api /ws        │ build / run / logs / exec / stats
                ┌──────▼─────────────────┴──┐
                │  backend (Node 20 + TS)   │──── /var/run/docker.sock (ÚNICO acceso)
                │  Express · WS · Scheduler │
                │  Docker CLI + Compose + Git│
                └──────┬───────────┬────────┘
                       │           │  /data (volumen persistente: código, versiones,
                ┌──────▼─────┐     │   compose, backups, logs)
                │ platform-db│     ▼
                │ PostgreSQL │   DATA_DIR del host
                └────────────┘
```

Principios:

* **Agnóstico de tecnología**: toda aplicación termina siendo una *imagen Docker*. La plataforma sólo necesita un Dockerfile válido; para las tecnologías conocidas lo genera, para el resto el usuario lo provee/edita.
* **Docker encapsulado**: sólo el contenedor `backend` monta el socket. Los usuarios nunca envían comandos Docker: invocan acciones de la API (start, stop, deploy…) que el backend traduce a llamadas acotadas, validadas y auditadas. La terminal web es la única excepción y requiere el permiso `terminal.access` (sólo Super Administrador por defecto).
* **Estado en PostgreSQL, archivos en `/data`**: nada persistente vive dentro de imágenes.
* **Imagen inmutable por versión**: cada versión produce `ema/<app>:<versión>`. Deploy y rollback = levantar el compose del ambiente apuntando a esa imagen (rollback sin recompilar).
* **Driver de orquestación reemplazable**: `services/docker.ts` concentra el acceso al runtime. Un futuro `KubernetesDriver` o multi-host (Docker remoto vía `DOCKER_HOST`) se incorpora implementando la misma interfaz, sin tocar rutas ni UI.

## 2. Diagrama de componentes (backend)

```
routes/ (REST, validación zod, RBAC, auditoría)
  auth · users · applications · environments · versions · deployments
  databases · backups · docker · git · audit · system · webhooks
          │
services/
  storage    → ZIP seguro (zip-slip, zip-bomb), carga de carpetas, snapshots
  detector   → detección de tecnología por archivos marcadores
  templates  → generadores de Dockerfile por tecnología
  compose    → generador docker-compose por ambiente (+ labels Traefik)
  git        → clone/fetch por branch/tag/commit con token o SSH key
  docker     → dockerode (estado, stats, logs, exec) + CLI (build, compose, push)
  deploy     → cola de pipeline: preparar → validar → build → tests → imagen
               → deploy → health check → (rollback automático)
  database   → PostgreSQL por ambiente: crear, borrar, reiniciar, usuarios, credenciales
  backup     → tar.gz de código/config + pg_dump; restauración; programación cron
  health     → chequeo HTTP periódico a cada ambiente
  ports      → asignación y detección de conflictos de puertos
  metrics    → CPU/RAM/disco del host, consumo por contenedor
ws/  → logs en tiempo real y terminal (docker exec TTY)
lib/ → cifrado AES-256-GCM, ejecución segura de procesos (sin shell), errores
```

## 3. Modelo de base de datos

```
roles 1─* role_permissions *─1 permissions
roles 1─* users
users 1─* audit_logs

applications 1─1 repositories
applications 1─* application_versions 1─* docker_images
applications 1─* application_environments
application_environments 1─* environment_variables
application_environments 1─* deployments *─1 application_versions
application_environments 1─* containers
application_environments 1─0..1 databases 1─* database_credentials
application_environments 1─* health_checks
application_environments 1─* backup_schedules
applications 1─* backups *─0..1 databases
docker_registries 1─* applications (opcional)
settings (clave/valor)
```

| Tabla | Propósito |
|---|---|
| `users`, `roles`, `permissions`, `role_permissions` | Autenticación y RBAC |
| `applications` | Ficha de la aplicación (nombre, slug, tecnología, autor, puerto interno, health path, registry) |
| `repositories` | Origen Git (URL, proveedor, auth cifrada, branch/tag/commit, secreto de webhook) |
| `application_versions` | Snapshot de código + Dockerfile + compose + variables (cifradas) + commit + comentario |
| `application_environments` | development / test / staging / production con puerto, dominio, volúmenes, versión desplegada y estado |
| `environment_variables` | Variables por ambiente; las secretas cifradas (AES-256-GCM) |
| `deployments` | Historial y log de cada pipeline |
| `containers` | Último estado conocido de los contenedores del ambiente |
| `docker_images` | Imágenes construidas por versión (tag, id, tamaño, registry) |
| `databases`, `database_credentials` | PostgreSQL del ambiente y sus usuarios (contraseñas cifradas, nunca devueltas) |
| `backups`, `backup_schedules` | Historial y programación de respaldos |
| `health_checks` | Resultados de chequeos HTTP |
| `docker_registries` | Registries (local, Docker Hub, GHCR, privado) |
| `audit_logs` | Usuario, fecha, IP, aplicación, acción, resultado |

El DDL completo está en `database/migrations/001_init.sql`.

## 4. Estructura de carpetas

```
ema-apphub/
├── backend/            API Node.js + TypeScript (Express)
├── frontend/           SPA React + TypeScript + Vite, servida por Nginx
├── database/
│   ├── migrations/     SQL versionado (se aplica automáticamente al iniciar)
│   └── seeds/          roles, permisos y super admin inicial
├── docker/traefik/     configuración estática/dinámica de Traefik
├── docs/               diseño, API, seguridad, instructivo
├── scripts/            instalación, backup de la plataforma, restore, logo
├── storage/            (DATA_DIR por defecto en desarrollo)
├── docker-compose.yml
└── .env.example
```

Almacenamiento en `DATA_DIR` (montado en el backend en la **misma ruta** que en el host, para que los bind mounts de las apps funcionen):

```
/data
├── applications/<slug>/
│   ├── versions/<versión>/source/      código + Dockerfile de esa versión
│   ├── environments/<ambiente>/        docker-compose.yml + .env (0600) generados
│   └── uploads/                        temporales de carga
├── backups/<slug>/                     *.tar.gz (app) y *.dump (pg_dump -Fc)
├── databases/<slug>/                   reservado (bind mounts opcionales)
├── logs/                               logs exportados
└── .ssh/known_hosts                    hosts Git confiables
```

## 5. Flujo de despliegue

```
Nueva aplicación ─► ZIP / Git / Archivos ─► validar y descomprimir ─► detectar tecnología
   ─► proponer Dockerfile (editable) ─► configurar ambiente (puertos, dominio, variables,
   volúmenes) ─► crear PostgreSQL (opcional) ─► crear versión v1.0.0
   ─► PIPELINE:
        1. preparar   escribir Dockerfile, compose y .env del ambiente
        2. validar    puertos libres, Dockerfile presente, compose válido (docker compose config)
        3. build      docker build -t ema/<slug>:<versión>  (se omite si la imagen ya existe)
        4. tests      comando de test opcional dentro de la imagen
        5. imagen     tag + push al registry si está configurado
        6. deploy     docker compose -p ema-<slug>-<amb> up -d --remove-orphans
        7. health     GET http://<contenedor>:<puerto><health_path> hasta 200 o timeout
        ─► OK: versión marcada como desplegada, ambiente "running"
        ─► FALLA: rollback automático a la última versión exitosa del ambiente
```

Actualizar desde Git = `fetch` del ref configurado → nueva versión (patch +1) → mismo pipeline. Puede dispararse desde la UI o por webhook (`POST /api/webhooks/git/:id` con secreto).

## 6. Diseño de API

REST bajo `/api`, JSON, documentada con OpenAPI 3 en `/api/docs`. Las acciones sobre un ambiente aceptan `?environment=production` (o en el body); por defecto se usa el ambiente principal de la app.

| Recurso | Endpoints |
|---|---|
| Auth | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/change-password` |
| Usuarios | `GET/POST /users`, `PUT/DELETE /users/:id`, `GET /roles` |
| Aplicaciones | `GET/POST /applications`, `GET/PUT/DELETE /applications/:id`, `POST /applications/analyze` (ZIP/Git/archivos → detección), `POST /applications/:id/clone` |
| Código | `POST /applications/:id/upload` (ZIP o archivos → nueva versión), `POST /applications/:id/git/pull`, `PUT /applications/:id/repository` |
| Ciclo de vida | `POST /applications/:id/deploy`, `start`, `stop`, `restart`, `recreate`, `rollback` |
| Estado | `GET /applications/:id/status`, `GET /applications/:id/logs` (descarga), WS `/ws/logs` |
| Versiones | `GET/POST /applications/:id/versions`, `GET /applications/:id/versions/:vid`, `PUT .../dockerfile` |
| Ambientes | `GET/POST /applications/:id/environments`, `PUT/DELETE .../environments/:envId`, `GET /applications/:id/compose` |
| Variables | `GET/PUT /applications/:id/env`, `GET /applications/:id/env/export`, `POST /applications/:id/env/import` |
| Base de datos | `GET/POST/DELETE /applications/:id/database`, `POST .../database/restart`, `GET/POST .../database/users`, `POST .../database/users/:uid/password` |
| Backups | `GET /backups`, `POST /applications/:id/backup`, `POST /applications/:id/restore`, `GET /backups/:id/download`, `GET/POST/DELETE /applications/:id/backup-schedules` |
| Deployments | `GET /deployments`, `GET /deployments/:id` |
| Docker | `GET /docker/containers`, `POST /docker/containers/:id/:action`, `GET /docker/images`, `GET /docker/info` |
| Sistema | `GET /system/dashboard`, `GET /system/metrics`, `GET/POST/DELETE /system/registries`, `GET /system/ports/check` |
| Auditoría | `GET /audit` |
| Health | `GET /health` (plataforma), `POST /applications/:id/healthcheck` |

## 7. Diseño de seguridad

| Amenaza | Control |
|---|---|
| Robo de sesión | JWT firmado HS256 en cookie `httpOnly`, `SameSite=Strict`, `Secure` en HTTPS; expiración 8 h |
| CSRF | Doble token: cookie `ema_csrf` + header `X-CSRF-Token` obligatorio en métodos que modifican |
| XSS | React escapa salida; `helmet` con CSP; los logs se renderizan como texto |
| Fuerza bruta | `express-rate-limit` global y estricto en `/auth/login` (10 intentos / 15 min) |
| Contraseñas | bcrypt (12 rondas); política mínima de 10 caracteres |
| Secretos | AES-256-GCM con `MASTER_KEY` (fuera del código, en `.env`); la API nunca devuelve valores secretos, sólo `********` |
| Permisos | RBAC por permiso (`apps.deploy.prod`, `db.manage`, `terminal.access`…) verificado en cada ruta |
| Docker | Sólo el backend ve el socket; procesos lanzados con `execFile` (sin shell) y argumentos validados; nombres de contenedor derivados de slugs `[a-z0-9-]`; acciones limitadas a contenedores con label `ema.managed=true` |
| Archivos | Límite de tamaño, validación de ZIP (zip-slip, cantidad de entradas, tamaño descomprimido), rutas normalizadas |
| Git | Token enviado por `http.extraHeader` (no queda en `.git/config`), claves SSH temporales 0600 borradas al terminar |
| Auditoría | Toda acción de escritura registra usuario, IP, app, acción, resultado |
| Transporte | Traefik con Let's Encrypt y redirección HTTP→HTTPS; CORS configurable por `CORS_ORIGINS` |

Endurecimiento recomendado para producción: poner el socket detrás de un `docker-socket-proxy`, backups de `/data` fuera del servidor y guardar `MASTER_KEY` fuera del servidor. La clave no se rota: AppHub la verifica al arrancar y no inicia si no coincide con la que cifró los datos (ver README, sección MASTER_KEY).

## 8. Escalabilidad futura

* `services/docker.ts` es el único punto que habla con el runtime → se puede añadir `DOCKER_HOST` por servidor (tabla `servers`) o un driver Kubernetes.
* Las imágenes versionadas en registry permiten desplegar la misma versión en varios nodos.
* Traefik ya soporta balanceo entre réplicas (`deploy.replicas`) y blue/green por labels.
* Health checks y deployments son eventos persistidos: base para webhooks, alertas por email/Slack/Teams y exportación a Prometheus (`/metrics`).
