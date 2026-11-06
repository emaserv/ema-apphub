import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, api, createUser, login, newApp, Role, Session, start, stop } from './helpers';

/**
 * Matriz de permisos: qué rol puede usar cada endpoint (según database/seeds/001_roles_permissions.sql).
 * Para no crear ni borrar nada, las modificaciones se mandan con datos inválidos o sobre una app sin
 * versiones: quien TIENE permiso recibe el error de validación (400) y quien NO lo tiene, 403.
 * El permiso se revisa antes que los datos, así que el 400 prueba que el acceso fue concedido.
 */
type Caso = { nombre: string; method: string; path: (appId: string) => string; body?: unknown; permitido: Role[]; ok: number };

const TODOS: Role[] = ['superadmin', 'admin', 'developer', 'viewer'];

const CASOS: Caso[] = [
  { nombre: 'ver aplicaciones', method: 'GET', path: () => '/applications', permitido: TODOS, ok: 200 },
  { nombre: 'ver detalle de una app', method: 'GET', path: (id) => `/applications/${id}`, permitido: TODOS, ok: 200 },
  { nombre: 'crear aplicación', method: 'POST', path: () => '/applications', body: {}, permitido: ['superadmin', 'admin', 'developer'], ok: 400 },
  { nombre: 'editar aplicación', method: 'PUT', path: (id) => `/applications/${id}`, body: { internalPort: 0 }, permitido: ['superadmin', 'admin'], ok: 400 },
  { nombre: 'eliminar aplicación', method: 'DELETE', path: () => '/applications/00000000-0000-0000-0000-000000000000', permitido: ['superadmin', 'admin'], ok: 404 },
  { nombre: 'ver variables de entorno', method: 'GET', path: (id) => `/applications/${id}/env`, permitido: ['superadmin', 'admin', 'developer'], ok: 200 },
  { nombre: 'modificar variables de entorno', method: 'PUT', path: (id) => `/applications/${id}/env`, body: {}, permitido: ['superadmin', 'admin'], ok: 400 },
  { nombre: 'desplegar en producción', method: 'POST', path: (id) => `/applications/${id}/deploy`, body: { environment: 'production' }, permitido: ['superadmin', 'admin'], ok: 400 },
  { nombre: 'listar usuarios', method: 'GET', path: () => '/users', permitido: ['superadmin'], ok: 200 },
  { nombre: 'crear usuario', method: 'POST', path: () => '/users', body: {}, permitido: ['superadmin'], ok: 400 },
  { nombre: 'ver auditoría', method: 'GET', path: () => '/audit', permitido: ['superadmin', 'admin'], ok: 200 },
  { nombre: 'agregar registry Docker', method: 'POST', path: () => '/system/registries', body: {}, permitido: ['superadmin', 'admin'], ok: 400 },
  { nombre: 'administrar bases de datos', method: 'DELETE', path: () => '/applications/00000000-0000-0000-0000-000000000000/database', permitido: ['superadmin', 'admin'], ok: 404 },
  { nombre: 'crear backup', method: 'POST', path: () => '/applications/00000000-0000-0000-0000-000000000000/backup', body: {}, permitido: ['superadmin', 'admin'], ok: 404 },
];

const sesiones = {} as Record<Role, Session>;
let appId = '';

before(async () => {
  await start();
  sesiones.superadmin = await login(ADMIN.username, ADMIN.password);
  for (const role of ['admin', 'developer', 'viewer'] as const) {
    const u = await createUser(role);
    sesiones[role] = await login(u.username, u.password);
  }
  const creada = await api('POST', '/applications', { session: sesiones.superadmin, body: newApp('App Permisos') });
  assert.equal(creada.status, 201);
  appId = creada.body.application.id;
});
after(stop);

for (const c of CASOS) {
  describe(c.nombre, () => {
    for (const role of TODOS) {
      const puede = c.permitido.includes(role);
      test(`${role}: ${puede ? 'permitido' : 'denegado (403)'}`, async () => {
        const r = await api(c.method, c.path(appId), { session: sesiones[role], body: c.body });
        assert.equal(r.status, puede ? c.ok : 403, JSON.stringify(r.body));
      });
    }
  });
}
