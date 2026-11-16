import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { ADMIN, api, login, newApp, one, Session, start, stop } from './helpers';
import { paths } from '../../src/config';

/** Partes del servidor HTTP en sí (Express): documentación, rutas inexistentes y descargas de archivos. */
let s: Session;
before(async () => {
  await start();
  s = await login(ADMIN.username, ADMIN.password);
});
after(stop);

describe('servidor HTTP', () => {
  test('la documentación de la API carga (Swagger y openapi.json)', async () => {
    const base = (await api('GET', '/health')).status;
    assert.ok([200, 503].includes(base), 'health responde (503 si no hay Docker)');
    const spec = await api('GET', '/openapi.json');
    assert.equal(spec.status, 200);
    assert.ok(spec.body.openapi);
    const docs = await api('GET', '/docs/');
    assert.equal(docs.status, 200);
    assert.match(String(docs.body), /swagger-ui/i);
  });

  test('una ruta inexistente responde 404 en JSON', async () => {
    const r = await api('GET', '/no-existe/para-nada', { session: s });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'Ruta no encontrada');
  });

  test('descargar un backup entrega el archivo con su nombre', async () => {
    const app = (await api('POST', '/applications', { session: s, body: newApp('App Descarga') })).body.application;
    const dir = paths.backups(app.slug);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'app-descarga-prueba.tar.gz');
    fs.writeFileSync(file, 'contenido de prueba');
    const b = await one(`INSERT INTO backups (application_id, app_slug, type, status, file_path, size_bytes)
                         VALUES ($1,$2,'app','success',$3,19) RETURNING id`, [app.id, app.slug, file]);
    const r = await api('GET', `/backups/${b.id}/download`, { session: s });
    assert.equal(r.status, 200);
    assert.equal(r.body, 'contenido de prueba');
    assert.match(r.headers.get('content-disposition') ?? '', /app-descarga-prueba\.tar\.gz/);
  });
});
