import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, api, createUser, login, newApp, one, Session, start, stop } from './helpers';

/**
 * Rol Usuario: sube y despliega sus propias aplicaciones y sólo ve las que creó él.
 * No se le pueden asignar apps de otros, ni con "Todas las aplicaciones".
 */
let su: Session;
let u1: { id: string; username: string; password: string };
let u1S: Session;
let u2S: Session;
let appAdmin = '';
let appU1 = '';

const ids = (list: any[]) => list.map((x) => x.id).sort();

before(async () => {
  await start();
  su = await login(ADMIN.username, ADMIN.password);
  // allApps: true a propósito: para un Usuario se ignora
  u1 = await createUser('user', 'usuario-uno', 'Clave12345x', { allApps: true });
  const u2 = await createUser('user', 'usuario-dos', 'Clave12345x', { allApps: false });
  u1S = await login(u1.username, u1.password);
  u2S = await login(u2.username, u2.password);
  appAdmin = (await api('POST', '/applications', { session: su, body: newApp('App del Admin') })).body.application.id;
});
after(stop);

describe('rol Usuario', () => {
  test('el rol existe con sus permisos', async () => {
    const roles = (await api('GET', '/roles', { session: su })).body;
    const r = roles.find((x: any) => x.code === 'user');
    assert.ok(r, 'falta el rol user');
    assert.ok(r.permissions.includes('apps.create'));
    assert.ok(!r.permissions.includes('users.manage'));
    assert.ok(!r.permissions.includes('apps.access'));
  });

  test('sin apps propias no ve ninguna (aunque tenga all_apps)', async () => {
    assert.deepEqual((await api('GET', '/applications', { session: u1S })).body, []);
    assert.equal((await api('GET', `/applications/${appAdmin}`, { session: u1S })).status, 404);
    assert.equal((await api('GET', '/applications/app-del-admin', { session: u1S })).status, 404);
  });

  test('crea una app y pasa a verla (sólo esa)', async () => {
    const r = await api('POST', '/applications', { session: u1S, body: newApp('App de Uno') });
    assert.equal(r.status, 201);
    appU1 = r.body.application.id;
    assert.deepEqual(ids((await api('GET', '/applications', { session: u1S })).body), [appU1]);
    assert.equal((await api('GET', `/applications/${appU1}`, { session: u1S })).status, 200);
    assert.equal((await api('GET', '/applications/app-de-uno', { session: u1S })).status, 200);
    assert.equal((await api('GET', `/applications/${appAdmin}`, { session: u1S })).status, 404);
  });

  test('otro Usuario no ve la app ajena', async () => {
    assert.deepEqual((await api('GET', '/applications', { session: u2S })).body, []);
    assert.equal((await api('GET', `/applications/${appU1}`, { session: u2S })).status, 404);
    assert.equal((await api('GET', `/applications/${appU1}/env`, { session: u2S })).status, 404);
  });

  test('el Superadmin ve todas', async () => {
    assert.deepEqual(ids((await api('GET', '/applications', { session: su })).body), [appAdmin, appU1].sort());
  });

  test('no se le pueden asignar apps de otros desde Accesos', async () => {
    const r = await api('PUT', `/applications/${appAdmin}/access/${u1.id}`, { session: su, body: { assigned: true } });
    assert.equal(r.status, 400);
    const list = (await api('GET', `/applications/${appAdmin}/access`, { session: su })).body;
    assert.ok(!list.some((x: any) => x.id === u1.id), 'un Usuario no debe aparecer en Accesos');
  });

  test('ni desde la edición de usuarios', async () => {
    const r = await api('PUT', `/users/${u1.id}`, { session: su, body: { applicationIds: [appAdmin], allApps: true } });
    assert.equal(r.status, 200);
    assert.deepEqual(ids((await api('GET', '/applications', { session: u1S })).body), [appU1]);
  });

  test('se puede crear un Usuario desde la API', async () => {
    const r = await api('POST', '/users', { session: su,
      body: { username: 'usuario-tres', email: 'u3@test.local', fullName: 'Usuario Tres', role: 'user', password: 'Clave12345x' } });
    assert.equal(r.status, 201);
    const u = await one(`SELECT r.code FROM users u JOIN roles r ON r.id=u.role_id WHERE u.username='usuario-tres'`);
    assert.equal(u.code, 'user');
  });
});
