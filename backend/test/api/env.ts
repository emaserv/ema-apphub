/**
 * Variables de entorno de los tests de API. Se importa ANTES que cualquier módulo de src/,
 * porque src/config.ts lee las variables una sola vez al cargarse.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error(
    'Falta TEST_DATABASE_URL. Ejemplo local:\n' +
    '  docker run -d --name apphub-test-db -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=apphub_test postgres:16-alpine\n' +
    '  TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/apphub_test npm run test:api',
  );
}
// Los tests BORRAN la base: se exige que su nombre termine en _test para no tocar nunca una base real.
if (!/_test$/.test(new URL(url).pathname.slice(1))) {
  throw new Error(`TEST_DATABASE_URL debe apuntar a una base cuyo nombre termine en "_test" (se borra en cada corrida): ${url}`);
}

process.env.DATABASE_URL = url;
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'apphub-test-'));
process.env.ADMIN_PASSWORD = 'AdminTest12345';
// Socket inexistente: los tests de API nunca hablan con Docker (eso es la etapa 4)
process.env.DOCKER_SOCKET = path.join(os.tmpdir(), 'apphub-test-sin-docker.sock');
delete process.env.DOCKER_HOST;
