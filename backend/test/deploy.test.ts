import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planImage } from '../src/services/deploy';

/** Situación típica: código en disco, imagen sin construir, sin registry. */
const BASE = { imageExists: false, sourceExists: true, forceRebuild: false, dirty: false, pushedToRegistry: false };
const plan = (over: Partial<typeof BASE> = {}) => planImage({ ...BASE, ...over });

describe('planImage: cómo obtener la imagen de una versión', () => {
  test('versión nueva: se construye', () => {
    assert.equal(plan(), 'build');
  });

  test('la imagen ya existe: se reutiliza sin recompilar', () => {
    assert.equal(plan({ imageExists: true }), 'reuse');
  });

  test('rollback sin el código en disco pero con la imagen: se reutiliza', () => {
    // Caso real: el código de la versión se perdió, pero su imagen Docker sigue existiendo
    assert.equal(plan({ imageExists: true, sourceExists: false }), 'reuse');
  });

  test('sin código y sin imagen: no se puede desplegar', () => {
    assert.equal(plan({ sourceExists: false }), 'missing');
  });

  test('sin imagen local pero publicada en el registry: se descarga (aunque falte el código)', () => {
    assert.equal(plan({ pushedToRegistry: true }), 'pull');
    assert.equal(plan({ pushedToRegistry: true, sourceExists: false }), 'pull');
  });

  test('"forzar recompilación" construye aunque la imagen exista', () => {
    assert.equal(plan({ imageExists: true, forceRebuild: true }), 'build');
  });

  test('versión modificada (dirty) se construye de nuevo, sin reutilizar ni descargar', () => {
    assert.equal(plan({ imageExists: true, dirty: true }), 'build');
    assert.equal(plan({ pushedToRegistry: true, dirty: true }), 'build');
  });

  test('recompilar sin el código en disco: no se puede', () => {
    assert.equal(plan({ imageExists: true, forceRebuild: true, sourceExists: false }), 'missing');
    assert.equal(plan({ imageExists: true, dirty: true, sourceExists: false }), 'missing');
  });
});
