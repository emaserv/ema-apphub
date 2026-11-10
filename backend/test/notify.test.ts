import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { backupFailedNotice, deployFailedNotice, healthNotice, healthTransition } from '../src/services/notify';

const app = { id: 'abc-123', name: 'Hola EMA' };

describe('healthTransition: cuándo avisar caída / recuperación', () => {
  test('avisa caída recién al segundo chequeo fallido seguido', () => {
    assert.equal(healthTransition(['unhealthy', 'healthy', 'healthy']), null, 'una sola falla no alcanza');
    assert.equal(healthTransition(['unhealthy', 'unhealthy', 'healthy']), 'down');
  });

  test('no repite el aviso mientras sigue caída', () => {
    assert.equal(healthTransition(['unhealthy', 'unhealthy', 'unhealthy']), null);
  });

  test('avisa recuperación sólo si antes se había avisado la caída', () => {
    assert.equal(healthTransition(['healthy', 'unhealthy', 'unhealthy']), 'recovered');
    assert.equal(healthTransition(['healthy', 'unhealthy', 'healthy']), null, 'falla aislada: no se avisó caída');
    assert.equal(healthTransition(['healthy', 'healthy', 'unhealthy']), null);
  });

  test('una app que nunca estuvo sana (primer deploy fallido) no avisa caída', () => {
    assert.equal(healthTransition(['unhealthy', 'unhealthy']), null);
    assert.equal(healthTransition(['unhealthy']), null);
    assert.equal(healthTransition([]), null);
  });
});

describe('textos de los avisos', () => {
  test('deploy fallido con rollback: advertencia que dice a qué versión volvió', () => {
    const n = deployFailedNotice({ app, env: 'production', version: '1.0.5', error: 'Health check falló', by: 'ecorrea', rolledBackTo: '1.0.4' });
    assert.equal(n.kind, 'deploy_rolled_back');
    assert.equal(n.severity, 'warn');
    assert.equal(n.appId, 'abc-123');
    assert.match(n.title, /Hola EMA 1\.0\.5.*se volvió a 1\.0\.4/);
    assert.match(n.body, /Health check falló/);
    assert.match(n.body, /Iniciado por: ecorrea/);
  });

  test('deploy fallido sin rollback: error que advierte que puede estar fuera de servicio', () => {
    const n = deployFailedNotice({ app, env: 'production', version: '1.0.0', error: 'x'.repeat(5000) });
    assert.equal(n.kind, 'deploy_failed');
    assert.equal(n.severity, 'error');
    assert.match(n.body, /fuera de servicio/);
    assert.doesNotMatch(n.body, /Iniciado por/);
    assert.ok(n.body.length < 1300, 'el error largo se recorta');
  });

  test('caída, recuperación y backup', () => {
    const down = healthNotice({ app, env: 'production', kind: 'down', detail: 'HTTP 502' });
    assert.equal(down.severity, 'error');
    assert.match(down.body, /HTTP 502/);
    const ok = healthNotice({ app, env: 'production', kind: 'recovered' });
    assert.equal(ok.severity, 'ok');
    assert.match(ok.title, /se recuperó/);
    assert.match(backupFailedNotice({ app, env: 'production', type: 'database', error: 'pg_dump falló' }).body, /base de datos[\s\S]*pg_dump falló/);
  });
});
