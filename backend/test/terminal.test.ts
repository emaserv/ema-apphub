import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { TERMINAL_MARK, terminalCleanupScript } from '../src/services/docker';

describe('cierre de sesiones de la terminal web', () => {
  test('el script busca sólo los procesos marcados con esa sesión y los termina (HUP y después KILL)', () => {
    const id = randomUUID();
    const s = terminalCleanupScript(id);
    assert.ok(s.includes(`grep -qx '${TERMINAL_MARK}=${id}'`), 'coincidencia exacta con la marca de la sesión');
    assert.match(s, /kill -HUP \$pids/);
    assert.match(s, /sleep 2; .*kill -KILL \$pids/);
    assert.match(s, /exit 0$/, 'no falla si ya no queda ningún proceso');
  });

  test('rechaza ids que no sean un UUID (el id va dentro de un comando de shell)', () => {
    assert.throws(() => terminalCleanupScript("x'; rm -rf / #"), /inválido/);
    assert.throws(() => terminalCleanupScript(''), /inválido/);
    assert.throws(() => terminalCleanupScript('ABC-DEF-GHI'), /inválido/);
  });
});
