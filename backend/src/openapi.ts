/**
 * Especificación OpenAPI 3 de la API (servida en /api/docs).
 * Se construye a partir de una tabla de rutas para mantenerla sincronizada y compacta.
 */
type Route = [method: string, path: string, tag: string, summary: string, perm?: string, body?: Record<string, unknown>];

const envQ = { name: 'environment', in: 'query', schema: { type: 'string', enum: ['development', 'test', 'staging', 'production'] }, description: 'Ambiente (por defecto el principal)' };

const S = {
  login: { type: 'object', required: ['username', 'password'], properties: { username: { type: 'string' }, password: { type: 'string', format: 'password' } } },
  createApp: {
    type: 'object', required: ['name', 'technology', 'internalPort', 'environment'],
    properties: {
      name: { type: 'string', example: 'CRM Clientes' }, slug: { type: 'string', example: 'crm-clientes' }, description: { type: 'string' },
      technology: { type: 'string', example: 'react' }, internalPort: { type: 'integer', example: 80 }, healthcheckPath: { type: 'string', example: '/api/health' },
      stagingId: { type: 'string', description: 'Devuelto por /applications/analyze' }, dockerfile: { type: 'string' }, version: { type: 'string', example: '1.0.0' },
      environment: { type: 'object', properties: { name: { type: 'string', example: 'production' }, externalPort: { type: 'integer', example: 8085 }, domain: { type: 'string', example: 'crm.empresa.com' },
        variables: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' }, isSecret: { type: 'boolean' } } } } } },
      createDatabase: { type: 'boolean' }, deploy: { type: 'boolean' },
      repository: { type: 'object', properties: { url: { type: 'string' }, authType: { type: 'string', enum: ['none', 'token', 'basic', 'ssh'] }, credential: { type: 'string' }, branch: { type: 'string' }, tag: { type: 'string' }, commit: { type: 'string' } } },
    },
  },
  analyze: { type: 'object', description: 'multipart/form-data: method=zip + file, method=files + files[] + paths[]; o JSON method=git + git{url,branch,...}' },
  envOnly: { type: 'object', properties: { environment: { type: 'string' } } },
  deploy: { type: 'object', properties: { environment: { type: 'string' }, versionId: { type: 'string', format: 'uuid' }, forceRebuild: { type: 'boolean' } } },
  vars: { type: 'object', properties: { variables: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' }, isSecret: { type: 'boolean' } } } } } },
  backup: { type: 'object', properties: { environment: { type: 'string' }, type: { type: 'string', enum: ['app', 'database', 'both'] }, notes: { type: 'string' } } },
};

const routes: Route[] = [
  ['post', '/auth/login', 'Auth', 'Iniciar sesión (cookie httpOnly + token CSRF)', undefined, S.login],
  ['post', '/auth/logout', 'Auth', 'Cerrar sesión'],
  ['get', '/auth/me', 'Auth', 'Usuario actual y permisos'],
  ['post', '/auth/change-password', 'Auth', 'Cambiar contraseña'],
  ['get', '/users', 'Usuarios', 'Listar usuarios', 'users.manage'],
  ['post', '/users', 'Usuarios', 'Crear usuario', 'users.manage'],
  ['put', '/users/:uid', 'Usuarios', 'Modificar usuario / rol / reset de contraseña', 'users.manage'],
  ['delete', '/users/:uid', 'Usuarios', 'Desactivar usuario', 'users.manage'],
  ['get', '/roles', 'Usuarios', 'Roles y permisos (RBAC)'],

  ['get', '/applications', 'Aplicaciones', 'Listar aplicaciones (?status=running|stopped|error&search=&stats=1)', 'apps.view'],
  ['post', '/applications/analyze', 'Aplicaciones', 'Subir ZIP/archivos/Git, detectar tecnología y proponer Dockerfile', 'apps.create', S.analyze],
  ['post', '/applications/dockerfile/preview', 'Aplicaciones', 'Generar Dockerfile para una tecnología', 'apps.create'],
  ['get', '/applications/technologies', 'Aplicaciones', 'Tecnologías soportadas'],
  ['post', '/applications', 'Aplicaciones', 'Crear aplicación (opcional: base de datos y deploy)', 'apps.create', S.createApp],
  ['get', '/applications/:id', 'Aplicaciones', 'Detalle de aplicación', 'apps.view'],
  ['put', '/applications/:id', 'Aplicaciones', 'Modificar aplicación', 'apps.edit'],
  ['delete', '/applications/:id', 'Aplicaciones', 'Eliminar aplicación (?purge=true borra archivos y volúmenes)', 'apps.delete'],
  ['post', '/applications/:id/upload', 'Aplicaciones', 'Subir nueva versión (ZIP o archivos, multipart)', 'versions.create'],
  ['post', '/applications/:id/clone', 'Aplicaciones', 'Clonar aplicación', 'apps.create'],

  ['get', '/applications/:id/versions', 'Versiones', 'Listar versiones', 'apps.view'],
  ['post', '/applications/:id/versions', 'Versiones', 'Crear versión a partir de otra', 'versions.create'],
  ['get', '/applications/:id/versions/:vid', 'Versiones', 'Detalle de versión (Dockerfile y árbol de archivos)', 'apps.view'],
  ['delete', '/applications/:id/versions/:vid', 'Versiones', 'Eliminar versión no desplegada', 'apps.edit'],
  ['put', '/applications/:id/versions/:vid/dockerfile', 'Versiones', 'Editar Dockerfile', 'versions.create'],
  ['get', '/applications/:id/versions/:vid/file', 'Versiones', 'Leer archivo (?path=)', 'apps.view'],
  ['put', '/applications/:id/versions/:vid/file', 'Versiones', 'Editar archivo', 'versions.create'],

  ['post', '/applications/:id/deploy', 'Despliegue', 'Desplegar versión en un ambiente (pipeline asíncrono)', 'apps.deploy.*', S.deploy],
  ['post', '/applications/:id/rollback', 'Despliegue', 'Volver a una versión anterior', 'apps.deploy.*', S.deploy],
  ['post', '/applications/:id/start', 'Despliegue', 'Iniciar', 'apps.operate', S.envOnly],
  ['post', '/applications/:id/stop', 'Despliegue', 'Detener', 'apps.operate', S.envOnly],
  ['post', '/applications/:id/restart', 'Despliegue', 'Reiniciar', 'apps.operate', S.envOnly],
  ['post', '/applications/:id/recreate', 'Despliegue', 'Recrear contenedor', 'apps.operate', S.envOnly],
  ['get', '/applications/:id/status', 'Despliegue', 'Estado, consumo y health checks', 'apps.view'],
  ['get', '/applications/:id/logs', 'Despliegue', 'Logs (?service=app|db&tail=&since=&until=&download=1). Tiempo real: WS /ws/logs', 'apps.logs'],
  ['post', '/applications/:id/healthcheck', 'Despliegue', 'Ejecutar health check ahora', 'apps.view'],
  ['get', '/applications/:id/deployments', 'Despliegue', 'Historial de deployments', 'apps.view'],
  ['get', '/deployments', 'Despliegue', 'Deployments de todas las apps', 'apps.view'],
  ['get', '/deployments/:did', 'Despliegue', 'Detalle y log del pipeline', 'apps.view'],

  ['get', '/applications/:id/environments', 'Ambientes', 'Listar ambientes', 'apps.view'],
  ['post', '/applications/:id/environments', 'Ambientes', 'Crear ambiente', 'apps.edit'],
  ['put', '/applications/:id/environments/:name', 'Ambientes', 'Modificar puertos, dominio, volúmenes, límites', 'apps.edit'],
  ['delete', '/applications/:id/environments/:name', 'Ambientes', 'Eliminar ambiente', 'apps.delete'],
  ['get', '/applications/:id/compose', 'Ambientes', 'docker-compose.yml generado', 'apps.view'],
  ['get', '/system/ports/check', 'Ambientes', 'Verificar conflicto de puerto (?port=)', 'apps.view'],

  ['get', '/applications/:id/env', 'Variables', 'Variables (secretas enmascaradas)', 'apps.view'],
  ['put', '/applications/:id/env', 'Variables', 'Guardar variables', 'apps.edit', S.vars],
  ['get', '/applications/:id/env/export', 'Variables', 'Exportar .env (sin secretos)', 'apps.view'],
  ['post', '/applications/:id/env/import', 'Variables', 'Importar .env', 'apps.edit'],

  ['get', '/applications/:id/database', 'Bases de datos', 'Estado y conexión (contraseña enmascarada)', 'db.view'],
  ['post', '/applications/:id/database', 'Bases de datos', 'Crear PostgreSQL para el ambiente', 'db.manage'],
  ['delete', '/applications/:id/database', 'Bases de datos', 'Eliminar base (?confirm=<slug>)', 'db.manage'],
  ['post', '/applications/:id/database/restart', 'Bases de datos', 'Reiniciar', 'db.manage'],
  ['post', '/applications/:id/database/users', 'Bases de datos', 'Crear usuario de base', 'db.manage'],
  ['delete', '/applications/:id/database/users/:uid', 'Bases de datos', 'Eliminar usuario de base', 'db.manage'],
  ['post', '/applications/:id/database/users/:uid/password', 'Bases de datos', 'Rotar contraseña', 'db.manage'],
  ['get', '/databases', 'Bases de datos', 'Todas las bases', 'db.view'],

  ['get', '/backups', 'Backups', 'Historial (?applicationId=)', 'backups.view'],
  ['post', '/applications/:id/backup', 'Backups', 'Backup manual (app / database / both)', 'backups.manage', S.backup],
  ['post', '/applications/:id/restore', 'Backups', 'Restaurar backup', 'backups.manage'],
  ['get', '/backups/:bid/download', 'Backups', 'Descargar backup', 'backups.manage'],
  ['delete', '/backups/:bid', 'Backups', 'Eliminar backup', 'backups.manage'],
  ['get', '/applications/:id/backup-schedules', 'Backups', 'Programaciones', 'backups.view'],
  ['post', '/applications/:id/backup-schedules', 'Backups', 'Programar backup (cron)', 'backups.manage'],
  ['delete', '/applications/:id/backup-schedules/:sid', 'Backups', 'Eliminar programación', 'backups.manage'],

  ['put', '/applications/:id/repository', 'Git', 'Configurar repositorio (URL, token/SSH, branch/tag/commit)', 'git.manage'],
  ['delete', '/applications/:id/repository', 'Git', 'Quitar repositorio', 'git.manage'],
  ['post', '/applications/:id/git/pull', 'Git', 'Actualizar desde Git: pull → build → test → deploy', 'versions.create'],
  ['post', '/git/refs', 'Git', 'Listar branches/tags remotos (prueba credenciales)', 'git.manage'],
  ['get', '/repositories', 'Git', 'Repositorios configurados', 'apps.view'],
  ['post', '/webhooks/git/:id', 'Git', 'Webhook (GitHub X-Hub-Signature-256, GitLab X-Gitlab-Token o ?token=)'],

  ['get', '/docker/info', 'Docker', 'Información del daemon', 'docker.view'],
  ['get', '/docker/containers', 'Docker', 'Contenedores administrados (?stats=1)', 'docker.view'],
  ['post', '/docker/containers/:cid/:action', 'Docker', 'start | stop | restart | remove', 'docker.manage'],
  ['get', '/docker/images', 'Docker', 'Imágenes de la plataforma', 'docker.view'],
  ['post', '/docker/images/prune', 'Docker', 'Eliminar imágenes huérfanas', 'docker.manage'],

  ['get', '/system/dashboard', 'Sistema', 'Resumen del dashboard', 'apps.view'],
  ['get', '/system/metrics', 'Sistema', 'CPU / RAM / disco / Docker', 'apps.view'],
  ['get', '/system/info', 'Sistema', 'Configuración de la plataforma', 'apps.view'],
  ['get', '/notifications', 'Sistema', 'Mis avisos (últimos 50 y cantidad sin leer)', ''],
  ['post', '/notifications/:nid/read', 'Sistema', 'Marcar un aviso como leído', ''],
  ['post', '/notifications/read-all', 'Sistema', 'Marcar todos mis avisos como leídos', ''],
  ['get', '/system/registries', 'Sistema', 'Docker registries', 'apps.view'],
  ['post', '/system/registries', 'Sistema', 'Agregar registry', 'settings.manage'],
  ['delete', '/system/registries/:rid', 'Sistema', 'Eliminar registry', 'settings.manage'],
  ['get', '/audit', 'Auditoría', 'Auditoría (?user=&action=&application=&result=&from=&to=)', 'audit.view'],
  ['get', '/health', 'Sistema', 'Salud de la plataforma (público)'],
];

const paths: Record<string, any> = {};
for (const [method, p, tag, summary, perm, body] of routes) {
  const oaPath = p.replace(/:(\w+)/g, '{$1}');
  const params = [...p.matchAll(/:(\w+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
  if (p.startsWith('/applications/:id/') && !p.includes('/versions') && !p.includes('/clone') && !p.includes('/upload')) params.push(envQ as any);
  paths[oaPath] ??= {};
  paths[oaPath][method] = {
    tags: [tag], summary, description: perm ? `Permiso requerido: \`${perm}\`` : undefined, parameters: params,
    ...(body ? { requestBody: { content: { 'application/json': { schema: body } } } } : {}),
    responses: { 200: { description: 'OK' }, 400: { description: 'Datos inválidos' }, 401: { description: 'No autenticado' }, 403: { description: 'Sin permiso / CSRF' }, 404: { description: 'No encontrado' }, 409: { description: 'Conflicto (puerto, dominio, versión)' } },
    ...(p === '/auth/login' || p === '/health' || p.startsWith('/webhooks') ? { security: [] } : {}),
  };
}

export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'EMA AppHub API', version: '1.0.0',
    description: 'API de la plataforma interna de EMA Servicios para registrar, versionar, configurar y desplegar aplicaciones Docker.\n\n' +
      'Autenticación: `POST /api/auth/login` crea la cookie de sesión. Las operaciones que modifican requieren el header `X-CSRF-Token` con el valor de la cookie `ema_csrf`. ' +
      'Alternativamente puede enviarse `Authorization: Bearer <jwt>`.\n\nWebSockets: `/ws/logs?app=<id>&environment=&service=app|db` y `/ws/terminal?app=<id>&environment=` (permiso terminal.access).',
  },
  servers: [{ url: '/api' }],
  components: {
    securitySchemes: {
      cookieAuth: { type: 'apiKey', in: 'cookie', name: 'ema_session' },
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
  },
  security: [{ cookieAuth: [] }, { bearerAuth: [] }],
  paths,
};
