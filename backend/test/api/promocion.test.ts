import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, api, createUser, login, newApp, one, Session, start, stop } from './helpers';

/**
 * Promoción entre ambientes (Test → Producción) con la misma imagen. Los datos se arman directo en la base
 * (versiones, ambientes y deploys) porque los tests de API no construyen imágenes Docker.
 */
let s: Session;
let appId = '';
let testEnvId = '';
let prodEnvId = '';
let v12 = '';
let v13 = '';

const promote = (body: unknown, session = s) => api('POST', `/applications/${appId}/promote`, { session, body });

async function version(label: string) {
  const v = await one(
    `INSERT INTO application_versions (application_id, version, source_type, source_path, dockerfile)
     VALUES ($1,$2,'zip','/no/existe','FROM scratch') RETURNING id`, [appId, label]);
  return v.id as string;
}

/** Deja v1.3 funcionando en Test (con su imagen registrada) y v1.2 en Producción. */
async function escenario() {
  await one(`UPDATE application_versions SET build_config='{}'::jsonb WHERE id=$1`, [v13]);
  await one(`UPDATE application_environments SET status='running', deployed_version_id=$2 WHERE id=$1`, [testEnvId, v13]);
  await one(`UPDATE application_environments SET status='running', deployed_version_id=$2 WHERE id=$1`, [prodEnvId, v12]);
  await one(`DELETE FROM deployments WHERE application_id=$1`, [appId]);
  await one(
    `INSERT INTO deployments (application_id, environment_id, version_id, trigger, status, image_id, finished_at)
     VALUES ($1,$2,$3,'manual','success','sha256:probada',now())`, [appId, testEnvId, v13]);
}

before(async () => {
  await start();
  s = await login(ADMIN.username, ADMIN.password);
  const r = await api('POST', '/applications', { session: s, body: newApp('App Promocion') });
  appId = r.body.application.id;
  prodEnvId = (await one(`SELECT id FROM application_environments WHERE application_id=$1 AND name='production'`, [appId])).id;
  testEnvId = (await one(
    `INSERT INTO application_environments (application_id, name) VALUES ($1,'test') RETURNING id`, [appId])).id;
  v12 = await version('1.2');
  v13 = await version('1.3');
});
after(stop);

describe('pasar una versión de Test a Producción', () => {
  test('un desarrollador no puede pasar a Producción, pero sí a otros ambientes', async () => {
    const u = await createUser('developer', 'dev-promo');
    const dev = await login(u.username, u.password);
    assert.equal((await promote({ from: 'test', to: 'production' }, dev)).status, 403);
    // Hacia Test sí tiene permiso: llega a la validación (no hay ambiente Desarrollo) en vez de 403
    assert.equal((await promote({ from: 'development', to: 'test' }, dev)).status, 404);
  });

  test('ambientes inválidos o iguales', async () => {
    assert.equal((await promote({ from: 'test', to: 'otro' })).status, 400);
    const r = await promote({ from: 'test', to: 'test' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /distinto/);
  });

  test('Test sin versión desplegada', async () => {
    await escenario();
    await one(`UPDATE application_environments SET status='not_deployed', deployed_version_id=NULL WHERE id=$1`, [testEnvId]);
    const r = await promote({ from: 'test', to: 'production' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Test no tiene ninguna versión/);
  });

  test('la versión se modificó después de probarla en Test', async () => {
    await escenario();
    await one(`UPDATE application_versions SET build_config='{"dirty":true}'::jsonb WHERE id=$1`, [v13]);
    const r = await promote({ from: 'test', to: 'production' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /se modificó después/);
  });

  test('el deploy en Test no registró la imagen', async () => {
    await escenario();
    await one(`UPDATE deployments SET image_id=NULL WHERE environment_id=$1`, [testEnvId]);
    const r = await promote({ from: 'test', to: 'production' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /No hay registro de la imagen/);
  });

  test('si la imagen probada ya no existe, no recompila: el deploy falla y Producción no cambia', async () => {
    await escenario();
    const r = await promote({ from: 'test', to: 'production' });
    assert.equal(r.status, 202);
    let dep: any;
    for (let i = 0; i < 100; i++) {
      dep = await one(`SELECT * FROM deployments WHERE id=$1`, [r.body.id]);
      if (['failed', 'rolled_back'].includes(dep.status)) break;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    assert.equal(dep.trigger, 'promote');
    assert.equal(dep.promoted_from, 'test');
    assert.ok(['failed', 'rolled_back'].includes(dep.status), `estado: ${dep.status}`);
    assert.match(dep.error, /ya no está disponible/);
    const audit = await one(`SELECT details FROM audit_logs WHERE action='promote' ORDER BY created_at DESC LIMIT 1`);
    assert.deepEqual({ from: audit.details.from, to: audit.details.to, version: audit.details.version }, { from: 'test', to: 'production', version: '1.3' });
    const prod = await one(`SELECT deployed_version_id FROM application_environments WHERE id=$1`, [prodEnvId]);
    assert.equal(prod.deployed_version_id, v12, 'Producción sigue con v1.2');
  });
});
