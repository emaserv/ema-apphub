import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, api, createUser, login, newApp, one, Session, start, stop } from './helpers';

/**
 * Permisos por aplicación: Desarrollador y Consulta ven sólo sus apps asignadas (o todas con "Todas las aplicaciones");
 * Superadmin y Admin ven todas. Una app no asignada responde 404, como si no existiera.
 */
let su: Session;
let admin: Session;
let appA = '';
let appB = '';
let dev: { id: string; username: string; password: string };
let devS: Session;

const ids = (list: any[]) => list.map((x) => x.application_id ?? x.id).sort();

before(async () => {
  await start();
  su = await login(ADMIN.username, ADMIN.password);
  const a = await createUser('admin', 'admin-acc');
  admin = await login(a.username, a.password);
  appA = (await api('POST', '/applications', { session: su, body: newApp('App Alfa') })).body.application.id;
  appB = (await api('POST', '/applications', { session: su, body: newApp('App Beta') })).body.application.id;
  dev = await createUser('developer', 'dev-acc', 'Clave12345x', { allApps: false });
  devS = await login(dev.username, dev.password);
});
after(stop);

describe('usuario sin aplicaciones asignadas', () => {
  test('no ve ninguna app en el listado ni en el tablero', async () => {
    assert.deepEqual((await api('GET', '/applications', { session: devS })).body, []);
    const d = await api('GET', '/system/dashboard', { session: devS });
    assert.equal(d.body.applications.total, 0);
  });

  test('una app no asignada responde 404 (por id y por slug), incluso en subrutas', async () => {
    assert.equal((await api('GET', `/applications/${appA}`, { session: devS })).status, 404);
    assert.equal((await api('GET', '/applications/app-alfa', { session: devS })).status, 404);
    assert.equal((await api('GET', `/applications/${appA}/env`, { session: devS })).status, 404);
    assert.equal((await api('GET', `/applications/${appA}/deployments`, { session: devS })).status, 404);
  });

  test('Superadmin y Admin ven todas', async () => {
    assert.equal((await api('GET', '/applications', { session: su })).body.length, 2);
    assert.equal((await api('GET', '/applications', { session: admin })).body.length, 2);
  });
});

describe('pestaña Accesos de la app', () => {
  test('lista sólo Desarrolladores y Consultas, con su estado de asignación', async () => {
    const r = await api('GET', `/applications/${appA}/access`, { session: admin });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map((u: any) => u.role), ['developer']);
    assert.equal(r.body[0].assigned, false);
  });

  test('el Admin asigna y el desarrollador pasa a ver esa app (y sólo esa)', async () => {
    const r = await api('PUT', `/applications/${appA}/access/${dev.id}`, { session: admin, body: { assigned: true } });
    assert.equal(r.status, 200);
    assert.deepEqual(ids((await api('GET', '/applications', { session: devS })).body), [appA]);
    assert.equal((await api('GET', `/applications/${appA}`, { session: devS })).status, 200);
    assert.equal((await api('GET', `/applications/${appB}`, { session: devS })).status, 404);
    const audit = await one(`SELECT details FROM audit_logs WHERE action='app_access_grant' AND entity_id=$1`, [dev.id]);
    assert.equal(audit?.details.username, 'dev-acc');
  });

  test('un Desarrollador no puede asignar accesos (aunque vea la app)', async () => {
    const r = await api('PUT', `/applications/${appA}/access/${dev.id}`, { session: devS, body: { assigned: false } });
    assert.equal(r.status, 403);
  });

  test('no se asignan Admins: ya ven todas', async () => {
    const a = await one(`SELECT id FROM users WHERE username='admin-acc'`);
    const r = await api('PUT', `/applications/${appA}/access/${a.id}`, { session: su, body: { assigned: true } });
    assert.equal(r.status, 400);
  });

  test('al quitar el acceso la app vuelve a responder 404', async () => {
    await api('PUT', `/applications/${appA}/access/${dev.id}`, { session: su, body: { assigned: false } });
    assert.equal((await api('GET', `/applications/${appA}`, { session: devS })).status, 404);
    assert.ok(await one(`SELECT 1 FROM audit_logs WHERE action='app_access_revoke' AND entity_id=$1`, [dev.id]));
  });
});

describe('pantalla de Usuarios (Superadmin)', () => {
  test('asigna apps al editar el usuario y las devuelve en el listado', async () => {
    const r = await api('PUT', `/users/${dev.id}`, { session: su, body: { applicationIds: [appB] } });
    assert.equal(r.status, 200);
    const u = (await api('GET', '/users', { session: su })).body.find((x: any) => x.id === dev.id);
    assert.deepEqual(u.application_ids, [appB]);
    assert.equal(u.all_apps, false);
    assert.deepEqual(ids((await api('GET', '/applications', { session: devS })).body), [appB]);
  });

  test('"Todas las aplicaciones" le muestra todas sin asignarlas una por una', async () => {
    await api('PUT', `/users/${dev.id}`, { session: su, body: { allApps: true } });
    assert.equal((await api('GET', '/applications', { session: devS })).body.length, 2);
    await api('PUT', `/users/${dev.id}`, { session: su, body: { allApps: false } });
    assert.deepEqual(ids((await api('GET', '/applications', { session: devS })).body), [appB], 'conserva sus asignaciones');
  });

  test('un usuario nuevo arranca sin aplicaciones', async () => {
    const r = await api('POST', '/users', { session: su,
      body: { username: 'nuevo-acc', email: 'nuevo-acc@test.local', fullName: 'Nuevo', role: 'viewer', password: 'Clave12345x' } });
    assert.equal(r.status, 201);
    const u = await one(`SELECT all_apps FROM users WHERE id=$1`, [r.body.id]);
    assert.equal(u.all_apps, false);
  });
});

describe('creación y listados generales', () => {
  test('quien crea una app queda asignado y la ve', async () => {
    const r = await api('POST', '/applications', { session: devS, body: newApp('App Propia') });
    assert.equal(r.status, 201);
    const mias = ids((await api('GET', '/applications', { session: devS })).body);
    assert.ok(mias.includes(r.body.application.id));
    assert.ok(!mias.includes(appA));
  });

  test('deployments, backups, bases y repos de apps no asignadas no aparecen', async () => {
    const envA = await one(`SELECT id FROM application_environments WHERE application_id=$1`, [appA]);
    const d = await one(`INSERT INTO deployments (application_id, environment_id, status, trigger) VALUES ($1,$2,'success','manual') RETURNING id`, [appA, envA.id]);
    await one(`INSERT INTO repositories (application_id, provider, url) VALUES ($1,'github','https://example.com/a.git') RETURNING id`, [appA]);
    assert.ok(!ids((await api('GET', '/deployments', { session: devS })).body).includes(appA));
    assert.equal((await api('GET', `/deployments/${d.id}`, { session: devS })).status, 404);
    assert.equal((await api('GET', `/deployments/${d.id}`, { session: su })).status, 200);
    assert.deepEqual((await api('GET', '/repositories', { session: devS })).body, []);
    assert.equal((await api('GET', '/repositories', { session: su })).body.length, 1);
    assert.equal((await api('GET', '/backups', { session: devS })).status, 200);
    assert.equal((await api('GET', '/databases', { session: devS })).status, 200);
  });
});

describe('aviso de puerto ocupado', () => {
  test('a un usuario limitado no le dice qué aplicación usa el puerto; a un Admin sí', async () => {
    await one(`UPDATE application_environments SET external_port=8177 WHERE application_id=$1 RETURNING id`, [appA]);
    const limitado = await api('GET', '/system/ports/check?port=8177', { session: devS });
    assert.equal(limitado.body.free, false);
    assert.equal(limitado.body.reason, 'El puerto 8177 ya está asignado a otra aplicación');
    const deAdmin = await api('GET', '/system/ports/check?port=8177', { session: admin });
    assert.match(deAdmin.body.reason, /App Alfa/);
  });

  test('al crear una app con un puerto ocupado, el error tampoco nombra la otra app', async () => {
    const r = await api('POST', '/applications', { session: devS, body: newApp('App Choque', { environment: { name: 'development', externalPort: 8177 } }) });
    assert.equal(r.status, 409);
    assert.doesNotMatch(r.body.error, /App Alfa/);
  });
});

