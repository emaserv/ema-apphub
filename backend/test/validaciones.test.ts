import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateSource, detectProvider, newWebhookSecret, GitSource } from '../src/services/git';
import { validateVolume, stagingPath } from '../src/services/apps';
import { HttpError } from '../src/lib/http';

const isBadRequest = (e: unknown) => e instanceof HttpError && e.status === 400;
const ok = (s: Partial<GitSource>) => assert.doesNotThrow(() => validateSource({ url: 'https://github.com/emaserv/app.git', ...s }), JSON.stringify(s));
const bad = (s: Partial<GitSource>) => assert.throws(() => validateSource({ url: 'https://github.com/emaserv/app.git', ...s }), isBadRequest, JSON.stringify(s));

describe('git: URL del repositorio', () => {
  test('acepta HTTPS, SSH y formato git@host:repo', () => {
    for (const url of [
      'https://github.com/emaserv/app.git',
      'http://gitlab.interno.local/equipo/app',
      'ssh://git@github.com/emaserv/app.git',
      'git@github.com:emaserv/app.git',
      'git@bitbucket.org:ema/app.git',
    ]) ok({ url });
  });

  test('rechaza rutas locales y protocolos que permiten ejecutar comandos o leer el servidor', () => {
    for (const url of [
      'file:///etc/passwd',
      '/var/lib/apphub',
      '../otro-repo',
      'ext::sh -c touch% /tmp/x',
      'fd::17',
      'ftp://x.com/repo.git',
    ]) bad({ url });
  });

  test('rechaza URLs que git interpretaría como opciones o con espacios', () => {
    for (const url of ['--upload-pack=touch /tmp/x', '-oProxyCommand=x', 'https://x.com/a b', '', 'https://x.com/a\nb']) bad({ url });
  });
});

describe('git: branch, tag y commit', () => {
  test('acepta referencias comunes', () => {
    ok({ branch: 'main' });
    ok({ branch: 'feature/login-v2' });
    ok({ tag: 'v1.2.3' });
    ok({ commit: 'a1b2c3d' });
    ok({ commit: 'a'.repeat(40) });
  });

  test('rechaza referencias que git interpretaría como opciones o con caracteres raros', () => {
    for (const branch of ['-x', '--upload-pack=x', 'main; rm -rf /', 'a b', 'main:otra', 'x'.repeat(201)]) bad({ branch });
    for (const tag of ['-v1', 'v1 2', 'v1$(id)']) bad({ tag });
  });

  test('el commit debe ser un hash hexadecimal de 7 a 40 caracteres', () => {
    for (const commit of ['abc', 'g1234567', 'a'.repeat(41), 'HEAD', 'main']) bad({ commit });
  });

  test('autenticación SSH exige una URL SSH', () => {
    bad({ authType: 'ssh', url: 'https://github.com/emaserv/app.git' });
    ok({ authType: 'ssh', url: 'git@github.com:emaserv/app.git' });
    ok({ authType: 'ssh', url: 'ssh://git@github.com/emaserv/app.git' });
  });
});

describe('git: utilidades', () => {
  test('detecta el proveedor por la URL', () => {
    assert.equal(detectProvider('https://github.com/a/b'), 'github');
    assert.equal(detectProvider('git@GitHub.com:a/b.git'), 'github');
    assert.equal(detectProvider('https://gitlab.ema.com.ar/a/b'), 'gitlab');
    assert.equal(detectProvider('git@bitbucket.org:a/b.git'), 'bitbucket');
    assert.equal(detectProvider('https://git.interno.local/a/b'), 'git');
  });

  test('el secreto de webhook es aleatorio: 40 caracteres hexadecimales', () => {
    const a = newWebhookSecret();
    assert.match(a, /^[0-9a-f]{40}$/);
    assert.notEqual(a, newWebhookSecret());
  });
});

describe('volúmenes', () => {
  const vol = (source: string, target = '/data') => () => validateVolume({ type: 'volume', source, target });
  const bind = (source: string, target = '/data') => () => validateVolume({ type: 'bind', source, target });

  test('el destino dentro del contenedor debe ser una ruta absoluta', () => {
    assert.doesNotThrow(vol('datos', '/app/uploads'));
    assert.throws(vol('datos', 'app/uploads'), isBadRequest);
    assert.throws(vol('datos', ''), isBadRequest);
  });

  test('nombres de volumen válidos', () => {
    for (const s of ['datos', 'uploads_2', 'cache.v1', 'a-b']) assert.doesNotThrow(vol(s), s);
  });

  test('nombres de volumen inválidos', () => {
    for (const s of ['Datos', '-x', '_x', 'a/b', 'a b', 'a:b', 'x'.repeat(62)]) assert.throws(vol(s), isBadRequest, s);
  });

  test('bind mount: no puede salir de la carpeta de la app', () => {
    // Un bind mount permitiría a la app leer o escribir en el servidor: solo rutas simples y sin ".."
    for (const s of ['config', 'data/uploads', '/config']) assert.doesNotThrow(bind(s), s);
    for (const s of ['../../etc', 'a/../../b', '/var/run/docker.sock:x', 'a b', '$HOME']) assert.throws(bind(s), isBadRequest, s);
  });
});

describe('identificador de carga (stagingPath)', () => {
  test('rechaza identificadores con formato inválido antes de tocar el disco', () => {
    for (const id of ['../../etc', 'zip-1-ABCDEFGH', 'otro-123-abcdef12', 'zip-1-abcdef12/../x', '']) {
      assert.throws(() => stagingPath(id), isBadRequest, id);
    }
  });

  test('un identificador válido pero inexistente da 404', () => {
    assert.throws(() => stagingPath('zip-1700000000000-abcdef12'), (e: unknown) => e instanceof HttpError && e.status === 404);
  });
});
