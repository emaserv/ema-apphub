import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, api, login, newApp, one, Session, start, stop } from './helpers';

let s: Session;
before(async () => {
  await start();
  s = await login(ADMIN.username, ADMIN.password);
});
after(stop);

describe('ciclo de vida de una aplicación (sin deploy)', () => {
  let id = '';

  test('crear: genera el identificador y el ambiente production, y queda en la auditoría', async () => {
    const r = await api('POST', '/applications', { session: s, body: newApp('Gestión de Órdenes') });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    id = r.body.application.id;
    assert.equal(r.body.application.slug, 'gestion-de-ordenes');
    assert.equal(r.body.environment.name, 'production');
    assert.equal(r.body.deployment, null);
    assert.ok(await one(`SELECT 1 FROM audit_logs WHERE action = 'app_create' AND entity_id = $1`, [id]));
  });

  test('no permite dos apps con el mismo identificador ni datos inválidos', async () => {
    assert.equal((await api('POST', '/applications', { session: s, body: newApp('gestion de ordenes') })).status, 409);
    assert.equal((await api('POST', '/applications', { session: s, body: newApp('Puerto malo', { internalPort: 70000 }) })).status, 400);
    assert.equal((await api('POST', '/applications', { session: s, body: newApp('X') })).status, 400, 'nombre muy corto');
  });

  test('listar y ver el detalle', async () => {
    const lista = await api('GET', '/applications?search=ordenes', { session: s });
    assert.equal(lista.status, 200);
    assert.deepEqual(lista.body.map((a: any) => a.id), [id]);
    assert.equal(lista.body[0].state, 'not_deployed');

    const det = await api('GET', `/applications/${id}`, { session: s });
    assert.equal(det.status, 200);
    assert.equal(det.body.environments.length, 1);
  });

  test('editar cambia sólo lo enviado', async () => {
    const r = await api('PUT', `/applications/${id}`, { session: s, body: { name: 'Órdenes v2', description: 'Nueva' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.name, 'Órdenes v2');
    assert.equal(r.body.description, 'Nueva');
    assert.equal(r.body.internal_port, 3000, 'lo no enviado no cambia');
    assert.equal(r.body.slug, 'gestion-de-ordenes', 'el identificador no cambia');
  });

  test('eliminar la borra de la base (con sus ambientes) y queda en la auditoría', async () => {
    assert.equal((await api('DELETE', `/applications/${id}`, { session: s })).status, 200);
    assert.equal((await api('GET', `/applications/${id}`, { session: s })).status, 404);
    assert.equal(await one(`SELECT 1 FROM application_environments WHERE application_id = $1`, [id]), null);
    const log = await one(`SELECT application_name FROM audit_logs WHERE action = 'app_delete' AND entity_id = $1`, [id]);
    assert.ok(log, 'el borrado queda en la auditoría');
    assert.equal(log.application_name, 'Órdenes v2', 'conserva el nombre de la app borrada');
  });
});

describe('variables secretas', () => {
  let id = '';
  before(async () => {
    const r = await api('POST', '/applications', { session: s, body: newApp('App Secretos', { environment: {
      name: 'production', externalPort: null,
      variables: [{ key: 'DB_PASSWORD', value: 'superSecreta123', isSecret: true }, { key: 'LOG_LEVEL', value: 'info' }],
    } }) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    id = r.body.application.id;
  });

  test('se guardan cifradas en la base, nunca en texto plano', async () => {
    const v = await one(`SELECT value, value_enc FROM environment_variables WHERE key = 'DB_PASSWORD'`);
    assert.equal(v.value, null);
    assert.ok(v.value_enc);
    assert.ok(!String(v.value_enc).includes('superSecreta123'));
  });

  test('la API las muestra enmascaradas y el export .env las deja vacías', async () => {
    const vars = (await api('GET', `/applications/${id}/env`, { session: s })).body;
    const secreta = vars.find((v: any) => v.key === 'DB_PASSWORD');
    assert.notEqual(secreta.value, 'superSecreta123');
    assert.equal(vars.find((v: any) => v.key === 'LOG_LEVEL').value, 'info');

    const exp = await api('GET', `/applications/${id}/env/export`, { session: s });
    assert.equal(exp.status, 200);
    assert.ok(!exp.body.includes('superSecreta123'));
    assert.match(exp.body, /^DB_PASSWORD=\s+# secreto/m);
  });

  test('guardar con el valor enmascarado conserva la secreta original', async () => {
    const vars = (await api('GET', `/applications/${id}/env`, { session: s })).body;
    const r = await api('PUT', `/applications/${id}/env`, { session: s,
      body: { variables: vars.map((v: any) => ({ key: v.key, value: v.value, isSecret: v.isSecret })) } });
    assert.equal(r.status, 200);
    const antes = await one(`SELECT value_enc FROM environment_variables WHERE key = 'DB_PASSWORD'`);
    assert.ok(antes.value_enc, 'la secreta sigue guardada');
    const { decrypt } = await import('../../src/lib/crypto');
    assert.equal(decrypt(antes.value_enc), 'superSecreta123');
  });

  test('importar el propio export conserva la secreta y actualiza el resto', async () => {
    const exp = (await api('GET', `/applications/${id}/env/export`, { session: s })).body as string;
    const r = await api('POST', `/applications/${id}/env/import`, { session: s,
      body: { content: exp.replace('LOG_LEVEL=info', 'LOG_LEVEL=debug') } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.imported, 1, 'sólo LOG_LEVEL; la secreta vacía se saltea');
    assert.equal(r.body.restartRequired, false, 'no está desplegada');
    const { decrypt } = await import('../../src/lib/crypto');
    assert.equal(decrypt((await one(`SELECT value_enc FROM environment_variables WHERE key = 'DB_PASSWORD'`)).value_enc), 'superSecreta123');
    assert.equal((await one(`SELECT value FROM environment_variables WHERE key = 'LOG_LEVEL'`)).value, 'debug');
  });
});
