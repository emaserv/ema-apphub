import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, api, createUser, login, newApp, Session, start, stop } from './helpers';
import { healthNotice, notifySuperadmins } from '../../src/services/notify';

let superadmin: Session;
let admin: Session;
let appId = '';
before(async () => {
  await start();
  superadmin = await login(ADMIN.username, ADMIN.password);
  await createUser('admin', 'admin-avisos');
  admin = await login('admin-avisos', 'Clave12345x');
  const r = await api('POST', '/applications', { session: superadmin, body: newApp('App Avisos') });
  appId = r.body.application.id;
});
after(stop);

test('los avisos llegan sólo a los superadministradores', async () => {
  await notifySuperadmins(healthNotice({ app: { id: appId, name: 'App Avisos' }, env: 'production', kind: 'down', detail: 'HTTP 502' }));

  const s = await api('GET', '/notifications', { session: superadmin });
  assert.equal(s.status, 200);
  assert.equal(s.body.unread, 1);
  assert.equal(s.body.items[0].title, 'App Avisos (production) está caída');
  assert.equal(s.body.items[0].severity, 'error');
  assert.equal(s.body.items[0].applicationId, appId);

  const a = await api('GET', '/notifications', { session: admin });
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, { unread: 0, items: [] });
});

test('marcar como leído: uno, todos, y no se pueden tocar los de otro usuario', async () => {
  await notifySuperadmins(healthNotice({ app: { id: appId, name: 'App Avisos' }, env: 'production', kind: 'recovered' }));
  const [ultimo] = (await api('GET', '/notifications', { session: superadmin })).body.items;

  assert.equal((await api('POST', `/notifications/${ultimo.id}/read`, { session: admin })).status, 404, 'de otro usuario');
  assert.equal((await api('POST', '/notifications/no-es-un-id/read', { session: superadmin })).status, 404);

  assert.equal((await api('POST', `/notifications/${ultimo.id}/read`, { session: superadmin })).status, 200);
  assert.equal((await api('GET', '/notifications', { session: superadmin })).body.unread, 1);

  assert.equal((await api('POST', '/notifications/read-all', { session: superadmin })).status, 200);
  const fin = (await api('GET', '/notifications', { session: superadmin })).body;
  assert.equal(fin.unread, 0);
  assert.ok(fin.items.every((n: any) => n.readAt));
});

test('sin sesión no se pueden ver avisos', async () => {
  assert.equal((await api('GET', '/notifications')).status, 401);
});
