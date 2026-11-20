/**
 * Prompt para que quien desarrolla una app se la pida a un asistente de IA (Claude, Copilot, ChatGPT…)
 * y la deje lista para subir a EMA AppHub. Refleja cómo AppHub construye y publica las apps:
 * si cambia algo de eso (detector, templates, publicación por ruta, límites), actualizar este texto.
 */
export interface AppPromptInput {
  /** Dirección con la que se entra a AppHub (ej. https://apphub.emaservicios.com.ar). */
  baseUrl: string;
  appName?: string;
  /** Ruta de publicación ya asignada (ej. /holaema). */
  route?: string | null;
}

export function buildAppPrompt({ baseUrl, appName, route }: AppPromptInput): string {
  const r = route ? `/${route.replace(/^\/+|\/+$/g, '')}` : null;
  const ruta = r ?? '/<ruta>';
  const nombre = appName ? `"${appName}"` : 'esta aplicación';
  const rutaDato = r
    ? `La app se publica en la ruta **${r}** → \`${baseUrl}${r}/\`.`
    : 'Todavía no sé en qué ruta se va a publicar: **preguntame cuál usar antes de configurar la ruta base** (debe ser un solo tramo en minúsculas, ej. `/crm`; si no la sé, proponé una a partir del nombre de la app).';

  return `# Preparar ${nombre} para EMA AppHub

Actuá como desarrollador senior. Necesito que revises este proyecto y lo dejes listo para publicarlo en **EMA AppHub**, la plataforma interna de la empresa que construye cada app en un contenedor Docker y la publica. Aplicá los cambios necesarios en el código y, al final, dame el resumen que pido en la última sección.

${rutaDato}

## Cómo funciona AppHub (contexto)

- Se sube el proyecto como **ZIP**, **carpeta** o desde un **repositorio Git**. AppHub detecta la tecnología y genera un Dockerfile; si el proyecto trae su propio \`Dockerfile\` en la raíz, usa ese.
- Tecnologías que detecta solo: HTML/CSS/JS estático (\`index.html\`), React / Vue / Svelte / Angular (se compilan y se sirven con nginx), Next.js, Nuxt, NestJS, Node.js (Express, Fastify…), Python (Django, FastAPI, Flask), PHP / Laravel, Java (Maven, Gradle), .NET y Go. Para otra tecnología hay que incluir un \`Dockerfile\`.
- Cada app corre en su propio contenedor, con **512 MB de memoria** por defecto (se puede ampliar).
- Las apps se publican en una **ruta** del dominio de AppHub: \`${baseUrl}${ruta}/\`. Esto tiene consecuencias importantes (ver más abajo).
- Antes de publicar en Producción, AppHub **escanea la imagen con Trivy**: si hay vulnerabilidades **críticas** que tienen arreglo, el deploy se bloquea.

## Requisitos que tiene que cumplir la app

1. **Escuchar en \`0.0.0.0\`** (no en \`localhost\` ni \`127.0.0.1\`) y leer el puerto de la variable **\`PORT\`**, con un valor por defecto. Puertos habituales: Node 3000, Python 8000, Java/.NET/Go 8080; los sitios estáticos y SPA usan 80 (nginx).
2. **Health check**: una ruta que responda **HTTP 200** sin login (ej. \`/health\` o \`/api/health\`; para sitios estáticos alcanza con \`/\`). Si no responde al desplegar, AppHub vuelve atrás la versión.
3. **Configuración por variables de entorno**: nada de contraseñas, tokens ni URLs de servidores en el código. Agregá un \`.env.example\` con todas las variables (sin valores secretos). El \`.env\` real **no** se sube: las variables se cargan en AppHub.
4. **Variables al compilar**: AppHub pasa las variables al contenedor **cuando corre**, no al compilar. En SPA (Vite, CRA, Angular) las variables tipo \`VITE_*\` / \`REACT_APP_*\` se fijan en el build: no dependas de ellas para datos que cambian entre ambientes. Usá direcciones relativas (ver ruta) o un archivo de configuración que se lea en tiempo de ejecución.
5. **Base de datos**: la única base permitida en AppHub es **PostgreSQL**. Si el proyecto guarda datos de otra forma, adaptalo a PostgreSQL. La conexión se lee de **\`DATABASE_URL\`** (o \`DATABASE_HOST\`, \`DATABASE_PORT\`, \`DATABASE_NAME\`, \`DATABASE_USER\`, \`DATABASE_PASSWORD\`): AppHub las crea solas. **La app tiene que crear sus tablas si no existen** (o correr las migraciones) al arrancar, antes de usarlas: no asumas que la base ya viene armada.
6. **Archivos que deben persistir** (subidas de usuarios, adjuntos, exportaciones): guardarlos en **una sola carpeta fija** (ej. \`/app/uploads\`), que se declara como volumen. Todo lo demás del contenedor se pierde en cada deploy.
7. **Builds reproducibles**: Node con \`package-lock.json\` (o \`yarn.lock\` / \`pnpm-lock.yaml\`) y scripts \`build\` / \`start\`; Python con \`requirements.txt\` o \`pyproject.toml\` con versiones fijadas; Java/.NET con la versión de SDK declarada.
8. **No incluir** en lo que se sube: \`node_modules\`, \`vendor\`, \`bin/obj\`, \`target\`, \`dist\`/\`build\`, \`.venv\`, \`.git\`, \`.env\`. Si hay \`.gitignore\`, que los cubra.
9. **Dependencias al día**, sin vulnerabilidades críticas conocidas (\`npm audit\`, \`pip-audit\`, etc.).
10. **Un proyecto por app**: si es un monorepo (por ejemplo \`frontend/\` y \`backend/\`), cada parte se publica como una app separada, indicando su subcarpeta. Decime cómo queda cada una.

## Publicación en una ruta (muy importante)

La app se abre en \`${baseUrl}${ruta}/\`, no en la raíz de un dominio propio. AppHub funciona así:

- **Le quita la ruta a cada pedido**: \`${ruta}/clientes\` le llega a la app como \`/clientes\`. La ruta original viene en el encabezado **\`X-Forwarded-Prefix: ${ruta}\`**, y el protocolo original (https) en \`X-Forwarded-Proto\`.
- Si se entra a \`${ruta}\` sin barra final, se redirige a \`${ruta}/\`.
- Por eso, **todo enlace, archivo, redirección o llamada a la API que empiece con \`/\` sin la ruta se rompe** (\`/login\` iría a la raíz del dominio, que es AppHub; lo correcto es \`${ruta}/login\` o \`login\`). Hay que usar **direcciones relativas** o configurar la **ruta base** \`${ruta}/\`:
  - HTML estático: direcciones relativas (\`estilos.css\`, no \`/estilos.css\`) o \`<base href="${ruta}/">\`.
  - React + Vite: \`base: '${ruta}/'\` en \`vite.config\` y \`basename="${ruta}"\` en el router.
  - Create React App: \`"homepage": "${ruta}"\` y \`basename\` en el router.
  - Angular: \`ng build --base-href ${ruta}/\`.
  - Vue (Vite): \`base: '${ruta}/'\` y \`createWebHistory('${ruta}/')\`.
  - ASP.NET Core: \`app.UsePathBase("${ruta}")\` o *Forwarded Headers* leyendo \`X-Forwarded-Prefix\`.
  - Express / Node: rutas relativas en las vistas, o armar los enlaces con \`req.headers['x-forwarded-prefix']\`; \`app.set('trust proxy', true)\`.
  - FastAPI: \`root_path\` desde \`X-Forwarded-Prefix\` (o \`--root-path ${ruta}\` en uvicorn) y \`--proxy-headers\`.
  - Django: \`FORCE_SCRIPT_NAME = '${ruta}'\` y \`USE_X_FORWARDED_HOST = True\`.
  - Laravel: \`APP_URL=${baseUrl}${ruta}\` y *TrustProxies*.
  - **Next.js no es compatible** con este modo (su \`basePath\` espera recibir la ruta): si el proyecto es Next.js, avisame antes de cambiar nada.
- **Cookies**: todas las apps comparten el dominio con AppHub. Poneles a las cookies de la app un nombre propio (ej. \`${(r ?? '/miapp').slice(1)}_session\`) y \`Path=${ruta}/\`, para que no choquen con las de AppHub ni con las de otras apps. No uses nombres que empiecen con \`ema_\`.
- **Frontend y backend como apps separadas**: el frontend llama al backend por su ruta, con dirección relativa al dominio (ej. \`fetch('/miapp-api/clientes')\`). Como están en el mismo dominio, **no hace falta CORS**.
- Las redirecciones del servidor (después del login, por ejemplo) tienen que respetar la ruta y el https.

## Qué espero de vos

1. Revisá el proyecto y aplicá los cambios necesarios para cumplir todo lo anterior. Si algo no se puede cumplir, explicá por qué y qué alternativa hay.
2. No cambies la funcionalidad de la app ni agregues dependencias que no hagan falta.
3. Al final, dame este resumen para cargar en AppHub:

| Dato | Valor |
|---|---|
| Tecnología | |
| Subcarpeta (si es monorepo) | |
| Puerto interno | |
| Ruta de health check | |
| Ruta de publicación | ${r ?? ''} |
| Variables de entorno (nombre, ¿secreta?, para qué sirve) | |
| ¿Necesita PostgreSQL? | |
| Volúmenes (carpeta que debe persistir) | |
| Comando de tests (opcional) | |
| Cambios que hiciste y cómo probarlos localmente | |
`;
}

/** Descarga el prompt como archivo Markdown. */
export function downloadAppPrompt(input: Omit<AppPromptInput, 'baseUrl'> & { baseUrl?: string }) {
  const text = buildAppPrompt({ baseUrl: input.baseUrl ?? window.location.origin, appName: input.appName, route: input.route });
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const slug = input.route?.replace(/[^a-z0-9-]/g, '') || 'apphub';
  const a = document.createElement('a');
  a.href = url;
  a.download = `prompt-${slug}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
