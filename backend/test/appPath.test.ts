import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { normalizeAppPath, RESERVED_PATHS } from '../src/lib/appPath';
import { appUrl } from '../src/services/core';
import { config } from '../src/config';

describe('ruta de publicación de una app', () => {
  test('se normaliza: minúsculas, con "/" adelante y sin "/" al final', () => {
    assert.equal(normalizeAppPath('holaema'), '/holaema');
    assert.equal(normalizeAppPath('/HolaEma/'), '/holaema');
    assert.equal(normalizeAppPath('  /crm-clientes  '), '/crm-clientes');
  });

  test('vacía o ausente → sin ruta', () => {
    assert.equal(normalizeAppPath(''), null);
    assert.equal(normalizeAppPath('/'), null);
    assert.equal(normalizeAppPath(null), null);
    assert.equal(normalizeAppPath(undefined), null);
  });

  test('rechaza tramos múltiples, caracteres raros y guion al principio', () => {
    for (const bad of ['a/b', 'hola ema', 'holá', 'hola.ema', '-hola', '../x', 'x'.repeat(64)]) {
      assert.throws(() => normalizeAppPath(bad), /Ruta inválida/, bad);
    }
  });

  test('rechaza las rutas que usa AppHub', () => {
    for (const r of ['api', '/ws', 'Aplicaciones', '/login/']) assert.throws(() => normalizeAppPath(r), /la usa AppHub/, r);
  });
});

describe('las rutas reservadas coinciden con la interfaz', () => {
  const root = path.resolve(__dirname, '..', '..');

  test('toda pantalla de frontend/src/main.tsx está reservada', () => {
    const main = fs.readFileSync(path.join(root, 'frontend', 'src', 'main.tsx'), 'utf8');
    const firstSegments = [...main.matchAll(/<Route path="\/?([a-z0-9-]+)/g)].map((m) => m[1]);
    assert.ok(firstSegments.length > 5, 'no se encontraron rutas en main.tsx');
    for (const s of firstSegments) assert.ok((RESERVED_PATHS as readonly string[]).includes(s), `falta "${s}" en RESERVED_PATHS`);
  });

  test('nginx.conf envía a AppHub (y no a las apps) cada ruta reservada', () => {
    const nginx = fs.readFileSync(path.join(root, 'frontend', 'nginx.conf'), 'utf8');
    const spa = nginx.match(/location ~ \^\/\(([a-z0-9|-]+)\)\(\/\|\$\)/);
    assert.ok(spa, 'no se encontró la regla de pantallas de AppHub en nginx.conf');
    const handled = new Set([...spa![1].split('|'), 'api', 'ws', 'assets']);
    for (const r of RESERVED_PATHS) assert.ok(handled.has(r), `nginx.conf no reserva /${r}`);
    for (const p of ['api', 'ws', 'assets']) assert.match(nginx, new RegExp(`location \\^~ /${p}/`));
  });
});

describe('dirección de una app publicada por ruta', () => {
  const env = { domain: null, https_enabled: true, path_prefix: '/holaema', external_port: 8100 };

  test('usa APPS_PATH_BASE_URL', () => {
    const saved = config.appsPathBaseUrl;
    config.appsPathBaseUrl = 'https://apphub.ema.com.ar';
    try { assert.equal(appUrl(env), 'https://apphub.ema.com.ar/holaema/'); } finally { config.appsPathBaseUrl = saved; }
  });

  test('con dominio propio de apps, usa ese dominio', () => {
    assert.equal(appUrl({ ...env, domain: 'apps.ema.com.ar' }), 'https://apps.ema.com.ar/holaema/');
  });

  test('sin ruta sigue igual: dominio o IP y puerto', () => {
    assert.equal(appUrl({ ...env, path_prefix: null, domain: 'crm.ema.com.ar' }), 'https://crm.ema.com.ar');
    assert.equal(appUrl({ ...env, path_prefix: null }), `http://${config.publicHost}:8100`);
  });
});
