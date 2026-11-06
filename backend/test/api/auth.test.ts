import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, api, createUser, login, one, Session, start, stop } from './helpers';

before(start);
after(stop);

describe('login', () => {
  test('el admin inicial entra y /auth/me devuelve su rol y permisos', async () => {
    const s = await login(ADMIN.username, ADMIN.password);
    const me = await api('GET', '/auth/me', { session: s });
    assert.equal(me.status, 200);
    assert.equal(me.body.role, 'superadmin');
    assert.ok(me.body.permissions.includes('users.manage'));
    assert.equal(me.body.mustChangePassword, true, 'el admin inicial debe cambiar la contraseña');
  });

  test('contraseña incorrecta y usuario inexistente dan el mismo error (no revela qué usuarios existen)', async () => {
    const mal = await api('POST', '/auth/login', { body: { username: 'admin', password: 'incorrecta1' } });
    const nadie = await api('POST', '/auth/login', { body: { username: 'no-existe', password: 'incorrecta1' } });
    assert.equal(mal.status, 401);
    assert.equal(nadie.status, 401);
    assert.equal(mal.body.error, nadie.body.error);
    const fallo = await one(`SELECT 1 FROM audit_logs WHERE action = 'login' AND result = 'failure' AND username = 'admin'`);
    assert.ok(fallo, 'el intento fallido queda en la auditoría');
  });

  test('sin sesión o con un token inválido la API responde 401', async () => {
    assert.equal((await api('GET', '/auth/me')).status, 401);
    assert.equal((await api('GET', '/auth/me', { token: 'no-es-un-jwt' })).status, 401);
    assert.equal((await api('GET', '/applications', { session: { cookie: 'ema_session=falso', csrf: '' } })).status, 401);
  });
});

describe('protección CSRF (cookie de sesión + token en cabecera)', () => {
  let s: Session;
  before(async () => { s = await login(ADMIN.username, ADMIN.password); });

  test('una modificación sin token CSRF o con uno distinto se rechaza con 403', async () => {
    const body = { name: 'Sin CSRF', technology: 'node', internalPort: 3000, environment: { externalPort: null } };
    assert.equal((await api('POST', '/applications', { session: s, body, csrf: false })).status, 403);
    assert.equal((await api('POST', '/applications', { session: s, body, csrf: 'x'.repeat(s.csrf.length) })).status, 403);
    assert.equal(await one(`SELECT 1 FROM applications`), null, 'no se creó nada');
  });

  test('las consultas (GET) no necesitan token CSRF', async () => {
    assert.equal((await api('GET', '/applications', { session: s })).status, 200);
  });
});

describe('cambio de contraseña', () => {
  test('exige la actual, una nueva segura, y después sólo sirve la nueva', async () => {
    const u = await createUser('viewer', 'cambia', 'Vieja12345x');
    const s = await login(u.username, u.password);
    const cambiar = (currentPassword: string, newPassword: string) =>
      api('POST', '/auth/change-password', { session: s, body: { currentPassword, newPassword } });

    assert.equal((await cambiar('Equivocada1', 'Nueva12345x')).status, 400, 'actual incorrecta');
    assert.equal((await cambiar('Vieja12345x', 'corta1')).status, 400, 'menos de 10 caracteres');
    assert.equal((await cambiar('Vieja12345x', 'sololetrasaqui')).status, 400, 'sin números');
    assert.equal((await cambiar('Vieja12345x', 'Nueva12345x')).status, 200);

    assert.equal((await api('POST', '/auth/login', { body: { username: 'cambia', password: 'Vieja12345x' } })).status, 401);
    await login('cambia', 'Nueva12345x');
  });
});

describe('usuarios desactivados', () => {
  test('no pueden entrar y su sesión abierta deja de funcionar', async () => {
    const admin = await login(ADMIN.username, ADMIN.password);
    const u = await createUser('developer', 'se-va');
    const s = await login(u.username, u.password);

    assert.equal((await api('DELETE', `/users/${u.id}`, { session: admin })).status, 200);

    assert.equal((await api('GET', '/auth/me', { session: s })).status, 401, 'la sesión abierta se corta');
    assert.equal((await api('POST', '/auth/login', { body: { username: u.username, password: u.password } })).status, 401);
  });

  test('un administrador no puede desactivarse ni quitarse el rol a sí mismo', async () => {
    const admin = await login(ADMIN.username, ADMIN.password);
    const me = (await api('GET', '/auth/me', { session: admin })).body;
    assert.equal((await api('DELETE', `/users/${me.id}`, { session: admin })).status, 400);
    assert.equal((await api('PUT', `/users/${me.id}`, { session: admin, body: { active: false } })).status, 400);
    assert.equal((await api('PUT', `/users/${me.id}`, { session: admin, body: { role: 'viewer' } })).status, 400);
    assert.equal((await api('GET', '/auth/me', { session: admin })).body.role, 'superadmin');
  });
});

describe('alta de usuarios', () => {
  test('crea el usuario, que debe cambiar la contraseña al entrar; rechaza duplicados y claves débiles', async () => {
    const admin = await login(ADMIN.username, ADMIN.password);
    const nuevo = { username: 'maria.p', email: 'maria@test.local', fullName: 'María P', role: 'developer', password: 'Inicial12345' };

    assert.equal((await api('POST', '/users', { session: admin, body: nuevo })).status, 201);
    assert.equal((await api('POST', '/users', { session: admin, body: { ...nuevo, email: 'otra@test.local' } })).status, 409, 'usuario repetido');
    assert.equal((await api('POST', '/users', { session: admin, body: { ...nuevo, username: 'otro', password: 'debil' } })).status, 400);

    const s = await login('maria.p', 'Inicial12345');
    const me = (await api('GET', '/auth/me', { session: s })).body;
    assert.equal(me.role, 'developer');
    assert.equal(me.mustChangePassword, true);
  });
});
