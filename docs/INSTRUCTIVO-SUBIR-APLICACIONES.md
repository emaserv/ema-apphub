# Instructivo: cómo subir y desplegar aplicaciones en EMA AppHub

Este instructivo explica, paso a paso, cómo preparar una aplicación, subirla a la plataforma, configurarla y publicarla. Está pensado para desarrolladores y administradores de EMA Servicios.

---

## 1. Antes de empezar: checklist de la aplicación

Cualquier tecnología funciona si puede ejecutarse dentro de Docker. Para que el deploy sea exitoso al primer intento, verifique:

| # | Requisito | Por qué |
|---|---|---|
| 1 | La app **escucha en `0.0.0.0`** (no en `localhost`/`127.0.0.1`) | Dentro del contenedor, `localhost` no es accesible desde afuera |
| 2 | El **puerto** se lee de la variable `PORT` (o es fijo y conocido) | La plataforma necesita saber el *puerto interno* |
| 3 | Existe una ruta de **health check** que responde HTTP 200 (ej. `/api/health`, o `/` para sitios) | El deploy se considera exitoso sólo si responde; si no, hay rollback automático |
| 4 | La configuración se toma de **variables de entorno** (no hay contraseñas en el código) | Las variables se cargan y cifran desde la plataforma |
| 5 | La base de datos se lee de `DATABASE_URL` (o `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USER`, `DATABASE_PASSWORD`) | Si crea PostgreSQL desde la plataforma, esas variables se inyectan solas |
| 6 | Los archivos que deben persistir (uploads, adjuntos, exportaciones) se guardan en **una carpeta fija** (ej. `/app/uploads`) | Esa carpeta se declara como volumen; el resto del contenedor se recrea en cada deploy |
| 7 | El proyecto **no incluye** `node_modules`, `vendor`, `bin/obj`, `target`, `.git`, `.env` | Pesan, se regeneran en el build y pueden contener secretos |
| 8 | Para Node.js: está `package-lock.json` (o `yarn.lock` / `pnpm-lock.yaml`) y el script `build`/`start` correspondiente | Builds reproducibles |

Ejemplo mínimo de health check en Node/Express:

```js
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.listen(process.env.PORT || 3000, '0.0.0.0');
```

---

## 2. Roles: ¿quién puede hacer qué?

| Acción | Super Admin | Administrador | Desarrollador | Consulta |
|---|:-:|:-:|:-:|:-:|
| Ver aplicaciones y estado | ✔ | ✔ | ✔ | ✔ |
| Crear aplicaciones / subir versiones | ✔ | ✔ | ✔ | — |
| Deploy en Desarrollo / Test / Staging | ✔ | ✔ | ✔ | — |
| Deploy y rollback en **Producción** | ✔ | ✔ | — | — |
| Variables, puertos, dominios | ✔ | ✔ | (ver) | — |
| Bases de datos y backups | ✔ | ✔ | (ver) | — |
| Terminal web | ✔ | — | — | — |
| Usuarios y roles | ✔ | — | — | — |
| Asignar quién trabaja en cada aplicación (pestaña **Accesos**) | ✔ | ✔ | — | — |

**¿Qué aplicaciones ve cada uno?** Super Admin y Administrador ven todas. Desarrollador y Consulta ven **sólo las aplicaciones que tienen asignadas** (las demás no les aparecen en ningún lado), salvo que en *Usuarios* tengan marcado **"Todas las aplicaciones"**. Quien crea una aplicación queda asignado automáticamente. Las asignaciones se hacen desde *Usuarios* (Super Admin) o desde la pestaña *Accesos* de cada aplicación (Super Admin y Administrador). El rol sigue diciendo qué puede hacer en esas aplicaciones.

---

## 3. Crear una aplicación nueva

Ingrese a EMA AppHub y presione **+ Nueva aplicación** (arriba a la derecha). El asistente tiene 4 pasos.

### Paso 1 — Origen del código

1. Complete **Nombre** (ej. `CRM Clientes`). El **Identificador** se genera solo (`crm-clientes`); se usa en contenedores, imágenes y carpetas y no conviene cambiarlo luego.
2. Elija el **método de carga**:

#### Opción A — Subir ZIP

1. Comprima la **carpeta del proyecto** (puede estar en la raíz del ZIP o dentro de una única carpeta: se detecta sola).
   * Windows: clic derecho sobre la carpeta → *Enviar a → Carpeta comprimida (zip)*.
   * Linux/macOS: `zip -r mi-aplicacion.zip mi-aplicacion -x "*/node_modules/*" "*/.git/*"`
2. Arrástrelo al recuadro o haga clic para seleccionarlo.
3. Presione **Subir y analizar**.

> Límite por defecto: 500 MB. Los ZIP se validan (estructura, rutas peligrosas, tamaño descomprimido).

#### Opción B — Repositorio Git

1. Pegue la **URL**:
   * HTTPS: `https://github.com/emaservicios/crm.git`
   * SSH: `git@github.com:emaservicios/crm.git`
2. Elija **autenticación**:
   * *Repositorio público*: sin credenciales.
   * *Token (PAT)*: recomendado para repos privados. GitHub → *Settings → Developer settings → Personal access tokens* (permiso de lectura de contenido). GitLab → *Access Tokens* (`read_repository`). Bitbucket → *App passwords* / *Access tokens*.
   * *Usuario y contraseña*: para servidores Git propios.
   * *Clave SSH privada*: pegue la clave completa (`-----BEGIN OPENSSH PRIVATE KEY-----…`). Registre la clave pública como *Deploy key* de sólo lectura en el repositorio.
3. Elija **Branch**, **Tag** o **Commit** (hash). Con **Probar conexión** verá la lista de branches y tags.
4. **Subdirectorio** (opcional): para monorepos, ej. `apps/frontend`.
5. Presione **Subir y analizar**.

> Las credenciales se guardan cifradas y no vuelven a mostrarse. No quedan grabadas en el código descargado.

#### Opción C — Carpeta / archivos

1. Haga clic en el recuadro y seleccione la **carpeta del proyecto** desde su PC.
2. Se excluyen automáticamente `node_modules` y `.git`.
3. Presione **Subir y analizar**.

#### Opción D — Proyecto vacío

Registra la aplicación sin código; podrá subirlo después desde la pestaña **Versiones**.

### Paso 2 — Tecnología y Docker

La plataforma muestra:

* **Tecnología detectada** y nivel de confianza.
* **Archivos detectados** (`package.json`, `requirements.txt`, `pom.xml`, `*.csproj`, `index.html`…).
* **Advertencias** (falta de lockfile, falta de script `build`, etc.).

Revise y ajuste:

| Campo | Qué poner |
|---|---|
| **Tecnología** | Corrija si la detección no es la esperada; el puerto sugerido se actualiza |
| **Puerto interno** | Puerto donde escucha la app *dentro* del contenedor (React/Vue/Angular/HTML/PHP: `80`; Node: `3000`; Python: `8000`; Java/.NET/Go: `8080`) |
| **Health check** | Ruta que responde 200 (ej. `/api/health`; para sitios estáticos `/`) |
| **Comando de test** | Opcional (ej. `npm test`). Active *Ejecutar tests en cada deploy* para que un test fallido cancele el deploy |
| **Dockerfile** | Propuesto automáticamente. Puede editarlo. Si el proyecto ya trae un `Dockerfile`, se usa ese |

Si cambia la tecnología, use **Regenerar Dockerfile**.

### Paso 3 — Configuración

1. **Ambiente**: normalmente *Producción* para la primera publicación (o *Desarrollo* para pruebas).
2. **Puerto externo**: se sugiere uno libre (rango 8100–8999). La app quedará en `http://IP-DEL-SERVIDOR:PUERTO`. Al salir del campo se verifica que no esté en uso. Puede dejarlo vacío si sólo se accederá por dominio.
3. **Dominio** (opcional): ej. `crm.emaservicios.com.ar`. Antes, pida a Sistemas que cree el registro DNS apuntando al servidor. Con **HTTPS** activo se emite el certificado Let's Encrypt y se redirige HTTP→HTTPS.
   **Ruta** (obligatoria): publica la app dentro del dominio de AppHub, ej. `/crm` → `https://apphub.emaservicios.com.ar/crm/`. No requiere DNS. Se propone `/<identificador>` y se puede cambiar. Ver [Apps publicadas por ruta](#apps-publicadas-por-ruta).
   *(Mientras las apps se publiquen por ruta, los campos Dominio y HTTPS están ocultos.)*
4. **Variables de entorno**:
   * *Agregar variable* o *Pegar / importar .env* (pegue el contenido de su `.env`).
   * Marque como **Secreta** toda contraseña, token o clave (se detectan automáticamente las que contienen PASSWORD, SECRET, TOKEN o KEY).
   * No cargue `DATABASE_*` si va a crear la base desde la plataforma: se generan solas.
5. **Volúmenes persistentes** (si la app guarda archivos):
   * *Volumen Docker* → Origen `uploads`, Destino `/app/uploads`.
   * *Carpeta del servidor* → se crea en `/opt/ema-apphub/data/applications/<app>/data/<origen>`; útil si otros procesos deben leer esos archivos.
6. **Versión** (ej. `1.0.0`) y **comentario**.

### Paso 4 — Base de datos y deploy

1. Active **Crear base de datos PostgreSQL** si la app la necesita. Defina nombre de base y usuario propietario. La contraseña se genera sola y se inyecta en:

   ```
   DATABASE_URL=postgresql://usuario:****@ema-<app>-<ambiente>-db:5432/<base>
   DATABASE_HOST, DATABASE_PORT, DATABASE_NAME, DATABASE_USER, DATABASE_PASSWORD
   ```

2. Deje activo **Construir imagen y desplegar ahora**.
3. Presione **Crear y desplegar**.

Verá el **pipeline** en vivo:

```
Código → Validación → Build → Tests → Imagen → Deploy → Health check
```

* ✔ **Exitoso**: la aplicación queda *Ejecutando*. Use **Abrir** para verla.
* ✖ **Fallido**: el log muestra el error (ver sección 9). Si había una versión anterior funcionando, se hace **rollback automático**.

> Las migraciones de base de datos de su aplicación (Prisma, Sequelize, Django, Laravel, Flyway…) deben ejecutarse al iniciar la app o desde la **Terminal**; la plataforma crea la base vacía.

---

## 4. Publicar una nueva versión

### Por ZIP o carpeta

1. Abra la aplicación → pestaña **Versiones** → **Subir nueva versión**.
2. Seleccione el ZIP o la carpeta.
3. **Versión**: déjela vacía para incrementar automáticamente (1.0.0 → 1.0.1) o escriba una (ej. `2.0.0`).
4. **Comentario**: qué cambia (queda en el historial).
5. *Regenerar Dockerfile*: sólo si cambió la tecnología o la estructura. Si no, se reutiliza el Dockerfile de la versión anterior (o el que traiga el ZIP).
6. *Desplegar en <ambiente> al finalizar*: actívelo para publicar inmediatamente.

### Desde Git

1. Pestaña **Git** → verifique URL y referencia (branch/tag/commit).
2. Presione **Actualizar desde Git**: descarga el código, crea la versión, construye, prueba, despliega y verifica salud.

### Automático con webhook (CI/CD)

1. Pestaña **Git** → *Auto-deploy por webhook*: elija el ambiente (ej. *Staging*). Guarde.
2. Copie **URL** y **Secreto** del bloque *Webhook*.
3. En GitHub: *Settings → Webhooks → Add webhook* → Payload URL = URL, Content type = `application/json`, Secret = Secreto, evento *push*.
   En GitLab: *Settings → Webhooks* → URL + *Secret token*, evento *Push events*.
   Otros: agregue `?token=<secreto>` a la URL.
4. Cada push al branch configurado crea una versión y la despliega en ese ambiente.

---

## 5. Ambientes (Desarrollo, Test, Staging, Producción)

* En la ficha de la app, junto a **Ambiente**, presione **+ Ambiente**.
* Puede **copiar variables** desde otro ambiente; se asigna un puerto libre.
* Cada ambiente tiene contenedor, variables, base de datos, puerto y dominio **propios**.
* Flujo recomendado: subir versión → *Deploy* en **Staging** → probar → seleccionar **Producción** → pestaña **Versiones** → *Deploy a Producción* sobre la misma versión (no se recompila: se reutiliza la imagen).

### Apps publicadas por ruta

Cada ambiente se publica en una ruta del dominio de AppHub (**Puertos y dominio → Ruta**, obligatoria), por ejemplo `/crm` → `https://apphub.emaservicios.com.ar/crm/`. No hace falta pedir DNS. Cada ruta se usa en **un solo ambiente**: si no se indica, AppHub propone `/<identificador>` para el primero y `/<identificador>-<ambiente>` para los siguientes (ej. `/crm` y `/crm-staging`). Para cambiarla: editar, **Guardar configuración** y **Aplicar ahora**. No se pueden usar las rutas de la propia AppHub (`/api`, `/aplicaciones`, `/login`, etc.).

**Qué recibe la app.** AppHub le quita la ruta a cada pedido: `/crm/clientes` llega como `/clientes`, y la ruta original va en el encabezado `X-Forwarded-Prefix: /crm`. Si se entra a `/crm` sin la barra final, se redirige a `/crm/`.

**La app tiene que estar preparada.** Todo enlace, archivo o llamada a la API que empiece con `/` (por ejemplo `/assets/app.js` o `/api/login`) va a la raíz del dominio, no a `/crm/`, y falla. Use direcciones **relativas** o configure la **ruta base**:

| Tecnología | Cómo configurar la ruta base `/crm/` |
|---|---|
| HTML estático | Direcciones relativas (`estilos.css`, no `/estilos.css`) o `<base href="/crm/">` en el `<head>` |
| React + Vite | `base: '/crm/'` en `vite.config` y `basename="/crm"` en el router |
| Create React App | `"homepage": "/crm"` en `package.json` y `basename` en el router |
| Angular | `ng build --base-href /crm/` |
| Vue (Vite) | `base: '/crm/'` y `createWebHistory('/crm/')` |
| Next.js | `basePath: '/crm'` **no es compatible** (espera recibir la ruta): pida que se publique por dominio |
| ASP.NET Core | `app.UsePathBase("/crm")` o leer `X-Forwarded-Prefix` con *Forwarded Headers* |
| Express | Rutas relativas en las vistas, o armar los enlaces con `req.headers['x-forwarded-prefix']` |
| Django | `FORCE_SCRIPT_NAME = '/crm'` |
| Laravel | `APP_URL=https://apphub.emaservicios.com.ar/crm` |

> **Seguridad:** las apps publicadas por ruta comparten el dominio con AppHub, y el navegador las trata como el mismo sitio.
> Una app con código malicioso o una vulnerabilidad podría usar la sesión de quien la abra para operar AppHub en su nombre.
> Úselo sólo con apps de confianza y por un período acotado. Lo recomendado es un dominio exclusivo para las apps
> (ej. `apps.emaservicios.com.ar`, configurando el dominio y la ruta en el ambiente) o un subdominio por app.

---

## 6. Operación diaria

| Necesidad | Dónde |
|---|---|
| Ver si la app funciona | **Resumen** → *Health check* (barra verde/roja) y consumo CPU/RAM |
| Reiniciar / detener / iniciar | Botones superiores de la ficha |
| Volver a la versión anterior | **Rollback** (última exitosa) o **Versiones** → *Deploy* de cualquier versión |
| Ver logs en vivo | **Logs** (Aplicación / PostgreSQL): pausar, buscar, filtrar por fecha, descargar |
| Cambiar variables | **Variables** → Guardar → **Aplicar ahora** (recrea el contenedor) |
| Cambiar puerto, dominio, volúmenes o límites | **Puertos y dominio** → Guardar → **Aplicar ahora** |
| Editar Dockerfile o un archivo | **Docker** → editar → *Guardar en vX* o *Guardar como nueva versión* |
| Ejecutar comandos (migraciones, diagnóstico) | **Terminal** (sólo Super Admin; queda auditado) |
| Clonar Producción para Desarrollo | **Avanzado** → *Clonar aplicación* |

---

## 7. Bases de datos

Pestaña **Base de datos**:

* **Conexión**: host, puerto, base y usuario (la contraseña nunca se muestra).
* **Usuarios**: cree usuarios de *sólo lectura* (ej. para reportes/BI) o *lectura-escritura*.
* **Cambiar contraseña**: genera una nueva; si es el propietario, se actualiza `DATABASE_URL` y se recrea la app automáticamente.
* **Reiniciar**, **Backup ahora**, **Eliminar** (pide confirmación escribiendo el identificador).
* Para conectarse con una herramienta externa (DBeaver, pgAdmin), solicite a un administrador un usuario de sólo lectura y el acceso de red correspondiente: por seguridad el puerto 5432 de las apps no se publica.

---

## 8. Backups y restauración

Pestaña **Backups**:

* **Aplicación**: código + Dockerfile + compose + variables (cifradas).
* **Base de datos**: `pg_dump` en formato custom.
* **Completo**: ambos.
* **Programar**: elija tipo, frecuencia (diaria 03:00, cada 6 h, semanal, mensual o cron personalizado) y cantidad de copias a conservar.
* **Restaurar**:
  * *Base*: reemplaza el contenido actual (pide confirmación).
  * *Aplicación*: crea una versión nueva con el contenido del backup y la despliega.
* **Descargar**: obtiene el archivo para guardarlo fuera del servidor.

---

## 9. Problemas frecuentes

| Síntoma en el log del deploy | Causa probable | Solución |
|---|---|---|
| `Health check falló … ECONNREFUSED` | La app escucha en otro puerto o en `127.0.0.1` | Ajuste *Puerto interno* o haga que la app escuche en `0.0.0.0:$PORT` |
| `Health check falló … HTTP 404` | La ruta de health no existe | Cambie la ruta en **Avanzado → Health check URL** (o use `/`) |
| `El contenedor se detuvo (exit 1)` + error de la app | Falta una variable, error al iniciar | Revise el log mostrado; cargue variables faltantes |
| `npm ci … package-lock.json` | Lockfile desactualizado o ausente | Ejecute `npm install` localmente y suba el `package-lock.json` |
| `No se encontró script "build"` | SPA sin script de build | Agregue `"build": "vite build"` (o el que corresponda) |
| `El puerto 8150 ya está asignado…` | Puerto ocupado | Use el puerto sugerido |
| Error de compilación Java/.NET | Versión de SDK distinta | Edite la línea `FROM` del Dockerfile (ej. `maven:3.9-eclipse-temurin-17`) |
| `No se pudo obtener refs/heads/main` | Branch inexistente o credencial inválida | *Probar conexión* en el paso Git; verifique el token |
| Página en blanco en React/Vue/Angular | Ruta base o carpeta de salida distinta | Revise `base` en `vite.config` / `outputPath` de Angular; el Dockerfile busca `index.html` automáticamente |
| La app pierde archivos subidos tras un deploy | Se guardan dentro del contenedor | Declare un **volumen** para esa carpeta |
| Certificado HTTPS no se emite | DNS no apunta al servidor o puerto 80 cerrado | Verifique DNS y firewall; mientras tanto use `http://IP:puerto` |

---

## 10. Referencia rápida por tecnología

| Tecnología | Se detecta por | Imagen generada | Puerto interno | Notas |
|---|---|---|---|---|
| HTML/CSS/JS | `index.html` | `nginx` | 80 | Se publica la carpeta tal cual |
| React / Vue / Svelte (Vite, CRA) | `package.json` con `react`/`vue`/`svelte` | `node` (build) → `nginx` | 80 | Requiere script `build`; soporta rutas SPA |
| Angular | `@angular/core` + `angular.json` | `node` (build) → `nginx` | 80 | Usa `outputPath` de `angular.json` |
| Next.js / Nuxt | `next` / `nuxt` | `node` | 3000 | `npm run build` + `start` |
| NestJS | `@nestjs/core` | `node` | 3000 | `start:prod` o `node dist/main.js` |
| Node.js (Express, Fastify…) | `package.json` | `node` | 3000 | Script `start` o `main` |
| Python Django | `manage.py` / `django` | `python` + gunicorn | 8000 | Detecta el módulo `wsgi.py` |
| Python FastAPI | `fastapi` en requirements | `python` + uvicorn | 8000 | Detecta `FastAPI()` |
| Python Flask | `flask` en requirements | `python` + gunicorn | 8000 | Detecta `Flask(__name__)` |
| PHP / Laravel | `composer.json` / `*.php` / `artisan` | `php:apache` + composer | 80 | Laravel publica `public/`; incluye pdo_pgsql y mysqli |
| Java Maven / Gradle | `pom.xml` / `build.gradle` | `maven`/`gradle` → `temurin-jre` | 8080 | Ejecuta el `.jar` generado |
| .NET | `*.csproj` | `dotnet/sdk` → `dotnet/aspnet` | 8080 | `ASPNETCORE_URLS=http://+:8080` |
| Go | `go.mod` | `golang` → `alpine` | 8080 | Binario estático |
| Otra (Ruby, Rust, Elixir…) | `Dockerfile` propio | La que defina | La del `EXPOSE` | Incluya su Dockerfile en el proyecto |

---

## 11. Buenas prácticas

* Use **Staging** antes de **Producción** y despliegue en producción la *misma versión* probada.
* Comente cada versión (qué cambió, ticket asociado).
* Nunca suba `.env` dentro del ZIP: cargue las variables en la plataforma.
* Programe al menos un **backup diario de la base** en producción y descargue periódicamente una copia.
* Si una variable sensible se filtró, cámbiela en **Variables** (y en el sistema externo) y presione **Aplicar ahora**.
