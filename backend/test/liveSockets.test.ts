import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { closeUserSockets, openSocketCount, SESSION_CLOSED_CODE, setSocketApp, trackSocket } from '../src/services/liveSockets';
import { seesAllApps } from '../src/services/appAccess';

/** WebSocket de mentira: al cerrarlo registra el código y emite 'close', como el real. */
class FakeSocket extends EventEmitter {
  closedWith: { code?: number; reason?: string } | null = null;
  close(code?: number, reason?: string) {
    this.closedWith = { code, reason };
    this.emit('close');
  }
}

describe('liveSockets: cortar terminal y logs al cerrar sesión', () => {
  test('cierra todos los sockets del usuario con el código de sesión cerrada', () => {
    const a = new FakeSocket(), b = new FakeSocket();
    trackSocket('u1', a);
    trackSocket('u1', b);
    assert.equal(closeUserSockets('u1'), 2);
    assert.deepEqual(a.closedWith, { code: SESSION_CLOSED_CODE, reason: 'Sesión cerrada' });
    assert.deepEqual(b.closedWith, { code: SESSION_CLOSED_CODE, reason: 'Sesión cerrada' });
    assert.equal(openSocketCount('u1'), 0);
  });

  test('no toca los sockets de otros usuarios', () => {
    const mio = new FakeSocket(), otro = new FakeSocket();
    trackSocket('u2', mio);
    trackSocket('u3', otro);
    closeUserSockets('u2');
    assert.equal(otro.closedWith, null);
    assert.equal(openSocketCount('u3'), 1);
    otro.close();
  });

  test('un socket que se cerró solo deja de estar registrado', () => {
    const s = new FakeSocket();
    trackSocket('u4', s);
    s.close(1000);
    assert.equal(openSocketCount('u4'), 0);
    assert.equal(closeUserSockets('u4'), 0);
  });

  test('usuario sin sockets abiertos: no hace nada', () => {
    assert.equal(closeUserSockets('nadie'), 0);
  });
});

describe('liveSockets: quitar el acceso a una aplicación', () => {
  test('con appId corta sólo los sockets de esa app', () => {
    const deA = new FakeSocket(), deB = new FakeSocket();
    trackSocket('u5', deA); setSocketApp(deA, 'app-a');
    trackSocket('u5', deB); setSocketApp(deB, 'app-b');
    assert.equal(closeUserSockets('u5', 'Ya no tiene acceso a esta aplicación', 'app-a'), 1);
    assert.deepEqual(deA.closedWith, { code: SESSION_CLOSED_CODE, reason: 'Ya no tiene acceso a esta aplicación' });
    assert.equal(deB.closedWith, null);
    assert.equal(openSocketCount('u5'), 1);
    deB.close();
  });
});

describe('seesAllApps: quién ve todas las aplicaciones', () => {
  test('Superadmin y Admin siempre', () => {
    assert.equal(seesAllApps('superadmin', false), true);
    assert.equal(seesAllApps('admin', false), true);
  });
  test('Desarrollador y Consulta sólo con "Todas las aplicaciones"', () => {
    assert.equal(seesAllApps('developer', false), false);
    assert.equal(seesAllApps('viewer', false), false);
    assert.equal(seesAllApps('developer', true), true);
    assert.equal(seesAllApps('viewer', true), true);
  });
});
