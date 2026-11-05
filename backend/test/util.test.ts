import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  slugify, bumpPatch, VERSION_RE, safeJoin, parseDotenv, toDotenvLine, SECRET_KEY_RE, dirSize, projectName, dbContainerName,
} from '../src/lib/util';
import { HttpError } from '../src/lib/http';

/** Verifica que `fn` lance un error HTTP 400 (el que ve el usuario como "datos inválidos"). */
const assertBadRequest = (fn: () => unknown, msg?: string) =>
  assert.throws(fn, (e: unknown) => e instanceof HttpError && e.status === 400, msg);

describe('slugify (nombre de la app → identificador)', () => {
  test('minúsculas, sin acentos y con guiones', () => {
    assert.equal(slugify('Gestión de Órdenes'), 'gestion-de-ordenes');
    assert.equal(slugify('  App   EMA 2.0!! '), 'app-ema-2-0');
    assert.equal(slugify('Ñandú'), 'nandu');
  });

  test('si no queda nada usable devuelve "app"', () => {
    assert.equal(slugify(''), 'app');
    assert.equal(slugify('¡¿?!'), 'app');
  });

  test('máximo 50 caracteres', () => {
    assert.equal(slugify('a'.repeat(80)).length, 50);
  });

  test('nombres de proyecto y contenedor', () => {
    assert.equal(projectName('tienda', 'staging'), 'ema-tienda-staging');
    assert.equal(dbContainerName('tienda', 'staging'), 'ema-tienda-staging-db');
  });
});

describe('versiones', () => {
  test('bumpPatch incrementa el último número', () => {
    assert.equal(bumpPatch(null), '1.0.0');
    assert.equal(bumpPatch(undefined), '1.0.0');
    assert.equal(bumpPatch('1.2.3'), '1.2.4');
    assert.equal(bumpPatch('v1.2.9'), '1.2.10');
    assert.equal(bumpPatch('2.0.0-rc1'), '2.0.1');
  });

  test('bumpPatch con versiones no numéricas agrega un sufijo', () => {
    assert.equal(bumpPatch('beta'), 'beta-1');
  });

  test('VERSION_RE acepta versiones comunes', () => {
    for (const v of ['1.0.0', 'v2.3.4', '2024.11.05', '1.0.0-rc.1', 'release_7']) assert.ok(VERSION_RE.test(v), v);
  });

  test('VERSION_RE rechaza rutas, espacios y nombres largos', () => {
    // La versión se usa como nombre de carpeta: no puede permitir salir del directorio
    for (const v of ['../etc', '1.0/2', '1.0 0', '', '.oculta', '-x', 'a'.repeat(41)]) assert.ok(!VERSION_RE.test(v), v);
  });
});

describe('safeJoin (protección contra path traversal)', () => {
  const base = path.resolve(os.tmpdir(), 'ema-base');

  test('permite rutas dentro de la carpeta base', () => {
    assert.equal(safeJoin(base, 'src/index.js'), path.join(base, 'src', 'index.js'));
    assert.equal(safeJoin(base, ''), base);
    assert.equal(safeJoin(base, 'a/../b'), path.join(base, 'b'));
  });

  test('rechaza rutas que salen de la carpeta base', () => {
    for (const rel of ['../secreto', 'a/../../secreto', '../../../etc/passwd', path.resolve('/etc/passwd')]) {
      assertBadRequest(() => safeJoin(base, rel), rel);
    }
  });

  test('rechaza una carpeta "vecina" con el mismo prefijo', () => {
    // base = .../ema-base → .../ema-base-otra empieza igual pero está afuera
    assertBadRequest(() => safeJoin(base, '../ema-base-otra/x'));
  });
});

describe('parseDotenv (importar variables)', () => {
  test('lee claves y valores, ignorando comentarios y líneas vacías', () => {
    const text = '# comentario\n\nA=1\nB = dos\r\nexport C=3\n';
    assert.deepEqual(parseDotenv(text), [{ key: 'A', value: '1' }, { key: 'B', value: 'dos' }, { key: 'C', value: '3' }]);
  });

  test('quita las comillas y respeta "=" dentro del valor', () => {
    assert.deepEqual(parseDotenv(`A="hola mundo"\nB='x=y'\nC=postgres://u:p@h/db?ssl=true`), [
      { key: 'A', value: 'hola mundo' }, { key: 'B', value: 'x=y' }, { key: 'C', value: 'postgres://u:p@h/db?ssl=true' },
    ]);
  });

  test('quita comentarios al final de valores sin comillas, pero no dentro de comillas', () => {
    assert.deepEqual(parseDotenv('A=valor # nota\nB="con # numeral"\nC=color#rojo'), [
      { key: 'A', value: 'valor' }, { key: 'B', value: 'con # numeral' }, { key: 'C', value: 'color#rojo' },
    ]);
  });

  test('descarta líneas con claves inválidas', () => {
    assert.deepEqual(parseDotenv('1A=x\nMI-VAR=x\nsin igual\n=x\nOK_1=si'), [{ key: 'OK_1', value: 'si' }]);
  });

  test('"\\n" entre comillas dobles es un salto de línea', () => {
    assert.deepEqual(parseDotenv('A="linea1\\nlinea2"'), [{ key: 'A', value: 'linea1\nlinea2' }]);
  });

  test('entre comillas simples el valor es literal', () => {
    assert.deepEqual(parseDotenv(`A='sin \\n escapes $$ "x"'`), [{ key: 'A', value: 'sin \\n escapes $$ "x"' }]);
  });

  test('comillas sin cerrar: se toma el valor tal cual', () => {
    assert.deepEqual(parseDotenv('A="abc'), [{ key: 'A', value: '"abc' }]);
  });

  // Bug: el export escribe los secretos como "CLAVE=  # secreto" y el import tomaba "# secreto" como valor,
  // pisando la contraseña real. Con valor vacío, el import conserva el secreto existente.
  test('un secreto exportado se lee como valor vacío, no como "# secreto"', () => {
    assert.deepEqual(parseDotenv('DB_PASSWORD=  # secreto\nJWT_SECRET=  # secreto (sistema)'), [
      { key: 'DB_PASSWORD', value: '' }, { key: 'JWT_SECRET', value: '' },
    ]);
  });
});

describe('exportar → importar devuelve los mismos valores', () => {
  const VALUES = [
    'simple', '', 'hola mundo', 'precio $5', 'a$$b', '${NO_EXPANDIR}', 'dijo "hola"', "it's", 'C:\\temp\\app',
    'termina en barra\\', 'l1\nl2', 'abc #123', '#empieza-con-numeral', 'color#rojo', 'postgres://u:p@h:5432/db?ssl=true',
    '  espacios alrededor  ', '\\n literal', 'ñandú 🚀', 'a=b=c',
  ];

  for (const v of VALUES) {
    test(JSON.stringify(v), () => {
      assert.deepEqual(parseDotenv(toDotenvLine('X', v)), [{ key: 'X', value: v }]);
    });
  }

  test('archivo completo, con el formato del endpoint de exportación', () => {
    const vars = { NODE_ENV: 'production', MSG: 'hola "mundo" $1', RUTA: 'C:\\x' };
    const file = ['# Tienda — production — exportado 2026-11-05T12:00:00.000Z', '# Los valores secretos no se exportan (vacíos).',
      ...Object.entries(vars).map(([k, v]) => toDotenvLine(k, v)), 'API_TOKEN=  # secreto'].join('\n') + '\n';
    assert.deepEqual(parseDotenv(file), [...Object.entries(vars).map(([key, value]) => ({ key, value })), { key: 'API_TOKEN', value: '' }]);
  });
});

describe('toDotenvLine (escribir el .env que lee Docker Compose)', () => {
  // Los valores esperados se verificaron con Docker Compose real: la app recibe exactamente el valor original.
  test('valores simples van sin comillas', () => {
    assert.equal(toDotenvLine('A', 'simple'), 'A=simple');
    assert.equal(toDotenvLine('A', ''), 'A=');
    assert.equal(toDotenvLine('URL', 'https://x.com/a?b=1'), 'URL=https://x.com/a?b=1');
  });

  test('espacios y "#" van entre comillas', () => {
    assert.equal(toDotenvLine('A', 'hola mundo'), 'A="hola mundo"');
    assert.equal(toDotenvLine('A', 'abc #123'), 'A="abc #123"');
  });

  test('escapa comillas, barras, saltos de línea y "$"', () => {
    assert.equal(toDotenvLine('A', 'dijo "hola"'), 'A="dijo \\"hola\\""');
    assert.equal(toDotenvLine('A', 'C:\\temp'), 'A="C:\\\\temp"');
    assert.equal(toDotenvLine('A', 'l1\nl2'), 'A="l1\\nl2"');
    // "$" se duplica para que Compose no lo interprete como una variable
    assert.equal(toDotenvLine('A', 'precio $5'), 'A="precio $$5"');
  });
});

describe('SECRET_KEY_RE (detección automática de secretos al importar)', () => {
  test('marca como secretas las claves sensibles', () => {
    for (const k of ['DB_PASSWORD', 'API_KEY', 'JWT_SECRET', 'GITHUB_TOKEN', 'PRIVATE_KEY_PEM', 'DATABASE_URL', 'aws_credentials']) {
      assert.ok(SECRET_KEY_RE.test(k), k);
    }
  });

  test('no marca claves comunes', () => {
    for (const k of ['PORT', 'NODE_ENV', 'APP_NAME', 'LOG_LEVEL']) assert.ok(!SECRET_KEY_RE.test(k), k);
  });
});

describe('dirSize', () => {
  test('suma el tamaño de todos los archivos, incluidas subcarpetas', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dirsize-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), '12345');
      fs.mkdirSync(path.join(dir, 'sub', 'sub2'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'sub', 'sub2', 'b.txt'), '1234567890');
      assert.equal(dirSize(dir), 15);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('carpeta inexistente: 0', () => {
    assert.equal(dirSize(path.join(os.tmpdir(), 'no-existe-' + Date.now())), 0);
  });
});
