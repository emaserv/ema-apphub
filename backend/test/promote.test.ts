import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promotionError, PromotionCheck } from '../src/services/promote';

/** Situación típica: v1.3 funcionando en Test, Producción con v1.2. */
const BASE: PromotionCheck = {
  source: { name: 'test', status: 'running', deployed_version_id: 'v13' },
  target: { name: 'production', status: 'running', deployed_version_id: 'v12' },
  sourceImageId: 'sha256:abc',
  versionDirty: false,
  versionLabel: '1.3',
};
const check = (over: Partial<PromotionCheck> = {}) => promotionError({ ...BASE, ...over });

describe('promotionError: cuándo se puede pasar una versión a otro ambiente', () => {
  test('versión funcionando en el origen y con imagen registrada: se puede', () => {
    assert.equal(check(), null);
    assert.equal(check({ target: { name: 'production', status: 'not_deployed', deployed_version_id: null } }), null, 'destino sin deploys');
    assert.equal(check({ target: { name: 'production', status: 'error', deployed_version_id: 'v12' } }), null, 'destino con error');
  });

  test('origen y destino iguales', () => {
    assert.match(check({ target: { ...BASE.source } })!, /distinto/);
  });

  test('origen sin versión desplegada', () => {
    assert.match(check({ source: { name: 'test', status: 'not_deployed', deployed_version_id: null } })!, /Test no tiene ninguna versión/);
  });

  test('origen detenido o con error: no se sabe si la versión funciona', () => {
    assert.match(check({ source: { ...BASE.source, status: 'stopped' } })!, /no está funcionando/);
    assert.match(check({ source: { ...BASE.source, status: 'error' } })!, /no está funcionando/);
  });

  test('destino con un deploy en curso', () => {
    assert.match(check({ target: { ...BASE.target, status: 'deploying' } })!, /deploy en curso en Producción/);
  });

  test('destino que ya tiene esa versión', () => {
    assert.match(check({ target: { ...BASE.target, deployed_version_id: 'v13' } })!, /ya tiene la versión 1\.3/);
  });

  test('versión modificada después de probarla: hay que volver a probarla', () => {
    assert.match(check({ versionDirty: true })!, /se modificó después de desplegarse en Test/);
  });

  test('deploy anterior a esta función (sin imagen registrada)', () => {
    assert.match(check({ sourceImageId: null })!, /No hay registro de la imagen/);
  });
});
