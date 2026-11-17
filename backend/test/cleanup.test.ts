import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { VersionImageInfo, versionsToClean } from '../src/services/cleanup';
import { diskNotice, diskTransition } from '../src/services/notify';

/** Versión de prueba: `n` = antigüedad (1 = la más nueva). Por defecto se puede recompilar y no está en uso. */
const v = (n: number, extra: Partial<VersionImageInfo> = {}): VersionImageInfo => ({
  id: `v${n}`, createdAt: new Date(Date.UTC(2026, 0, 100 - n)), deployed: false, rollbackTarget: false, sourceExists: true, pushed: false, ...extra,
});

describe('qué imágenes de versiones viejas se borran', () => {
  test('conserva las últimas N y borra las anteriores', () => {
    const versions = [v(1), v(2), v(3), v(4), v(5), v(6), v(7)];
    assert.deepEqual(versionsToClean(versions, 5).sort(), ['v6', 'v7']);
  });

  test('no depende del orden en que vienen', () => {
    assert.deepEqual(versionsToClean([v(7), v(1), v(6), v(2)], 2).sort(), ['v6', 'v7']);
  });

  test('nunca borra la de una versión desplegada ni la del rollback, aunque sean viejas', () => {
    const versions = [v(1), v(2), v(8, { deployed: true }), v(9, { rollbackTarget: true }), v(10)];
    assert.deepEqual(versionsToClean(versions, 2), ['v10']);
  });

  test('si la versión no tiene el código en disco, su imagen es la única copia: se conserva, salvo que esté en un registry', () => {
    const versions = [v(1), v(5, { sourceExists: false }), v(6, { sourceExists: false, pushed: true })];
    assert.deepEqual(versionsToClean(versions, 1), ['v6']);
  });

  test('con menos versiones que el límite no borra nada', () => {
    assert.deepEqual(versionsToClean([v(1), v(2)], 5), []);
  });
});

describe('aviso de disco', () => {
  test('avisa una sola vez al pasar el límite', () => {
    assert.equal(diskTransition(86, false, 85), 'full');
    assert.equal(diskTransition(90, true, 85), null, 'ya avisado: no repite');
    assert.equal(diskTransition(70, false, 85), null);
  });

  test('avisa que se recuperó recién con 5 puntos de margen (evita avisos repetidos al oscilar)', () => {
    assert.equal(diskTransition(83, true, 85), null);
    assert.equal(diskTransition(79, true, 85), 'ok');
  });

  test('el mensaje dice el uso, lo liberado y qué hacer', () => {
    const n = diskNotice({ kind: 'full', percent: 88, free: 12 * 1024 ** 3, total: 100 * 1024 ** 3, threshold: 85, freedBytes: 3 * 1024 ** 3 });
    assert.equal(n.kind, 'disk_full');
    assert.equal(n.severity, 'error');
    assert.match(n.title, /88 %/);
    assert.match(n.body, /12\.0 GB libres de 100\.0 GB/);
    assert.match(n.body, /liberó 3\.0 GB/);
    const ok = diskNotice({ kind: 'ok', percent: 70, free: 30 * 1024 ** 3, total: 100 * 1024 ** 3, threshold: 85 });
    assert.equal(ok.kind, 'disk_ok');
    assert.equal(ok.severity, 'ok');
  });
});
