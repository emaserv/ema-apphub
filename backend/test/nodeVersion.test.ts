import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveNodeVersion, NODE_DEFAULT } from '../src/services/nodeVersion';
import { detect } from '../src/services/detector';

const D = String(NODE_DEFAULT);
const v = (engines: unknown) => resolveNodeVersion(engines).version;

test('sin engines.node usa la versión por defecto sin advertencia', () => {
  for (const e of [undefined, null, '', '   ', 42]) {
    assert.deepEqual(resolveNodeVersion(e), { version: D });
  }
});

test('rangos abiertos eligen la LTS preferida (no la mínima)', () => {
  for (const e of ['>=18', '>= 18', '>=18.0.0', '>16', '*', 'x', '>=14 <30', '18 - 26']) {
    assert.equal(v(e), D, e);
  }
});

test('rangos que excluyen la preferida eligen otra LTS con soporte', () => {
  assert.equal(v('^22'), '22');
  assert.equal(v('~22.11'), '22');
  assert.equal(v('22.x'), '22');
  assert.equal(v('>=25'), '26');
  assert.equal(v('<24'), '22');
  assert.equal(v('^20 || ^22'), '22');
  assert.equal(v('22.11.0'), '22');
});

test('versiones sin soporte se respetan con advertencia', () => {
  for (const [e, want] of [['16.x', '16'], ['^18', '18'], ['20.11.1', '20'], ['<20', '19'], ['^23', '23']] as const) {
    const r = resolveNodeVersion(e);
    assert.equal(r.version, want, e);
    assert.match(r.warning ?? '', /no es una LTS con soporte/, e);
  }
});

test('rangos ilegibles o imposibles usan la versión por defecto con advertencia', () => {
  for (const e of ['latest', 'lts/*', '>=abc', '>=24 <22']) {
    const r = resolveNodeVersion(e);
    assert.equal(r.version, D, e);
    assert.ok(r.warning, e);
  }
});

test('detect() usa resolveNodeVersion y propaga la advertencia', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-'));
  try {
    const write = (pkg: object) => fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');

    write({ engines: { node: '>=18' }, dependencies: { express: '^4' }, scripts: { start: 'node index.js' } });
    let d = detect(dir);
    assert.equal(d.technology, 'node');
    assert.equal(d.buildConfig.nodeVersion, D);
    assert.deepEqual(d.warnings, []);

    write({ engines: { node: '16.x' }, dependencies: { express: '^4' }, scripts: { start: 'node index.js' } });
    d = detect(dir);
    assert.equal(d.buildConfig.nodeVersion, '16');
    assert.equal(d.warnings.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
