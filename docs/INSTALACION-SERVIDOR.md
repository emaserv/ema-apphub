# Instalación de EMA AppHub en el servidor de producción

Guía para instalar AppHub en un servidor Linux nuevo y dejarlo verificado. Lleva unas 2 a 4 horas, sin contar el pedido de DNS o de reglas de firewall.
Para el detalle de cada variable y de la operación diaria, ver el [README](../README.md).

---

## 1. Antes de empezar

Conviene tener resuelto lo siguiente antes de tocar el servidor:

- [ ] **Servidor**: Linux x86_64 (recomendado Ubuntu 24.04 LTS), 4+ vCPU, 8+ GB de RAM, 100+ GB de disco.
- [ ] **Docker Engine 24+** con Compose v2 y Buildx (`docker compose version` debe responder). No usar Docker Desktop.
- [ ] **Acceso al repositorio** `emaserv/ema-apphub` (es privado): cuenta de GitHub con acceso a la organización, o una *deploy key* de sólo lectura.
- [ ] **Decidir cómo se va a acceder** (cambia la configuración del `.env`):
  - **A. Con dominio y HTTPS** (`https://apphub.emaservicios.com.ar`): el DNS tiene que apuntar al servidor y el **puerto 80 tiene que ser accesible desde internet** para que Let's Encrypt emita el certificado.
  - **B. Sólo red interna**, por IP: `http://IP-DEL-SERVIDOR:8080`, sin certificado.
- [ ] **Salida a internet** desde el servidor hacia: Docker Hub, `ghcr.io` y `mirror.gcr.io` (base de vulnerabilidades de Trivy), `registry.npmjs.org` y los repositorios de paquetes que usen las apps (PyPI, Maven, NuGet, etc.).
- [ ] **Gestor de contraseñas** de la empresa con una entrada para la `MASTER_KEY`, accesible por al menos dos personas.

## 2. Instalación

```bash
sudo git clone <url-del-repositorio> /opt/ema-apphub
cd /opt/ema-apphub
sudo ./scripts/install.sh
```

La **primera** ejecución sólo crea el `.env` con secretos aleatorios, muestra la contraseña inicial de `admin` y se detiene. No levanta nada todavía.

### 2.1 Revisar el `.env`

```bash
sudo nano /opt/ema-apphub/.env
```

| Variable | Opción A (dominio + HTTPS) | Opción B (sólo IP interna) |
|---|---|---|
| `PLATFORM_DOMAIN` | `apphub.emaservicios.com.ar` | dejar el valor: no se usa |
| `ACME_EMAIL` | casilla real de sistemas (avisos de vencimiento) | dejar el valor: no se usa |
| `COOKIE_SECURE` | `true` | `false` |
| `PUBLIC_HOST` | IP o nombre del servidor (el instalador pone la primera IP; verificarla) | igual |
| `APPS_BASE_DOMAIN` | dominio base para las apps, ej. `emaservicios.com.ar` | dejar el valor |
| `DATA_DIR` | `/opt/ema-apphub/data` (disco con espacio y persistente) | igual |
| `TERMINAL_ENABLED` | `true` o `false` según se quiera permitir la terminal web | igual |

> **Puertos:** si el servidor ya usa el 80, 443 u 8080, cambiarlos con `HTTP_PORT`, `HTTPS_PORT` y `PLATFORM_HTTP_PORT`. Ajustar también
> `PORT_RANGE_START`/`PORT_RANGE_END` para que el rango de las apps no incluya puertos ya ocupados: AppHub sólo detecta los puertos usados
> por otros contenedores, **no** los de programas instalados directamente en el servidor (por ejemplo, un Nginx).
>
> Con `COOKIE_SECURE=true` el login **sólo funciona por HTTPS**: entrando por `http://IP:8080` la sesión no se guarda.
> No modificar `POSTGRES_PASSWORD`, `JWT_SECRET` ni `MASTER_KEY`: ya vienen generados.

### 2.2 Guardar la MASTER_KEY (obligatorio, antes de seguir)

1. Copiar el valor de `MASTER_KEY` del `.env`.
2. Guardarlo en el gestor de contraseñas como **"EMA AppHub – MASTER_KEY (producción)"**.
3. Confirmar que otra persona puede verlo.

`MASTER_KEY` cifra todos los secretos que guarda AppHub (variables, contraseñas de las bases, credenciales de Git). **Si se pierde, esos secretos no se recuperan**, ni siquiera con los backups. Una vez instalado **no se cambia**: si el `.env` tiene otra clave, el backend no arranca.

### 2.3 Levantar la plataforma

```bash
sudo ./scripts/install.sh
```

La segunda ejecución construye las imágenes (puede tardar 5–10 minutos la primera vez), levanta todo y espera a que la API responda. Si el `.env` todavía tiene valores `CAMBIAR_…`, se detiene y dice cuáles.

## 3. Verificación

Marcar cada punto. Si alguno falla, ver la sección 6.

- [ ] `docker compose ps` muestra `traefik`, `platform-db`, `backend` y `frontend` en estado `running` (`platform-db` además `healthy`).
- [ ] Se abre la interfaz (opción A: `https://apphub.emaservicios.com.ar` con candado válido; opción B: `http://IP:8080`).
- [ ] Ingreso con `admin` y la contraseña inicial; pide cambiarla y el cambio funciona.
- [ ] **App de prueba**: *Nueva aplicación* → subir un ZIP chico (ej. una página HTML o la app "Hola EMA") → deploy en **Desarrollo** → queda *Running* y responde en su URL.
- [ ] **Escaneo de vulnerabilidades**: en el log de ese deploy aparece el paso de escaneo con Trivy y un resumen (cantidad de críticas / altas). Si dice que Trivy no pudo correr, revisar la salida a internet (sección 1).
- [ ] **Bloqueo en Producción**: hacer deploy de la misma app en **Producción**. Si no tiene vulnerabilidades críticas, debe pasar. *(Este punto no se pudo probar de punta a punta en la PC de desarrollo; es importante confirmarlo acá.)*
- [ ] **Avisos**: simular una caída con `docker kill ema-<app>-development` (con `docker stop` AppHub la toma como detenida a propósito y no avisa); en 1–2 minutos aparece el aviso de "app caída" en la campanita. Al iniciarla desde AppHub (*Iniciar*), aparece "recuperada".
- [ ] **Backup de una app**: desde la app → pestaña *Backups* → *Completo* → aparece en el historial y se puede descargar.
- [ ] **Reinicio del servidor**: `sudo reboot`; al volver, la plataforma y la app de prueba arrancan solas.
- [ ] Borrar la app de prueba (o dejarla en Desarrollo, a criterio).

## 4. Backup de la plataforma

Respalda la base de AppHub, `DATA_DIR` y el `.env`. Programarlo con cron:

```bash
sudo mkdir -p /var/backups/apphub
sudo crontab -e
# agregar:
0 2 * * * /opt/ema-apphub/scripts/backup-platform.sh /var/backups/apphub >> /var/log/apphub-backup.log 2>&1
```

- [ ] Correrlo una vez a mano (`sudo /opt/ema-apphub/scripts/backup-platform.sh /var/backups/apphub`) y verificar que se crean `apphub-db-*.dump`, `apphub-data-*.tar.gz` y `apphub-env-*.env`.

> **Pendiente:** hoy estos backups quedan en el mismo servidor. La copia fuera del servidor (NAS o almacenamiento en la nube) y el simulacro de restauración se van a configurar en una etapa siguiente.

## 5. Seguridad recomendada

- **Firewall**: exponer sólo lo necesario.
  - Opción A: 80 y 443 abiertos; el **8080 cerrado** hacia afuera (o sólo red interna), porque por ahí se entra sin HTTPS.
  - Opción B: 8080 sólo para la red interna.
  - El rango de puertos de las apps (`8100–8999`) sólo hacia donde haga falta.
- **SSH** con clave, sin login de root por contraseña.
- **Actualizaciones** del sistema operativo y de Docker al día.

## 6. Si algo falla

| Síntoma | Qué revisar |
|---|---|
| `install.sh` dice "La API no respondió" | `docker compose logs backend` |
| El backend no arranca y el log menciona `MASTER_KEY` | El `.env` tiene una clave distinta a la que cifró los datos. Ver README → *MASTER_KEY*. **No** usar `MASTER_KEY_ACCEPT_NEW` sin consultar. |
| No hay certificado HTTPS (opción A) | `docker compose logs traefik`: DNS que no apunta al servidor o puerto 80 cerrado desde internet |
| El login vuelve a pedir usuario y contraseña | `COOKIE_SECURE=true` entrando por `http://`: usar HTTPS o poner `false` |
| El build de una app falla al descargar dependencias | Salida a internet / proxy de la empresa |

Para actualizar AppHub más adelante: `sudo ./scripts/update.sh` (hace backup, baja la versión nueva y reinicia).
