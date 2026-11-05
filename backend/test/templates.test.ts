import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { generateDockerfile, writeSupportFiles } from '../src/services/templates';
import { TECHNOLOGIES } from '../src/services/detector';
import { NODE_DEFAULT } from '../src/services/nodeVersion';

/** Puerto "raro" para comprobar que la plantilla usa el puerto recibido y no uno fijo. */
const PORT = 5123;

/** Tecnologías cuya imagen siempre escucha en el 80 (nginx/apache), sin importar el puerto recibido. */
const ALWAYS_80 = ['react', 'vue', 'angular', 'svelte', 'static', 'php', 'php-laravel'];

/** Devuelve el array JSON de la línea `CMD [...]` o `ENTRYPOINT [...]` (forma exec de Docker). */
function execForm(df: string, instr: 'CMD' | 'ENTRYPOINT'): string[] {
  const line = df.split('\n').find((l) => l.startsWith(`${instr} [`));
  assert.ok(line, `falta ${instr} en forma exec`);
  return JSON.parse(line.slice(instr.length + 1));
}

describe('invariantes de todas las plantillas', () => {
  for (const tech of Object.keys(TECHNOLOGIES)) {
    test(tech, () => {
      const df = generateDockerfile(tech, {}, PORT);

      // Encabezado con el nombre legible de la tecnología.
      // "docker" (Dockerfile propio) no tiene plantilla: si la app no trae Dockerfile, cae en la genérica.
      const label = TECHNOLOGIES[tech === 'docker' ? 'unknown' : tech].label;
      assert.ok(df.startsWith(`# Generado por EMA AppHub · ${label}\n`), 'encabezado');
      // Sin valores "colados" por un campo faltante del buildConfig ("/dev/null" es válido)
      assert.doesNotMatch(df, /\bundefined\b|(?<!\/dev\/)\bnull\b|\bNaN\b|\[object Object\]/);
      // La primera instrucción real es un FROM
      const firstInstr = df.split('\n').find((l) => l.trim() && !l.startsWith('#'));
      assert.match(firstInstr ?? '', /^FROM \S+/);
      // Expone el puerto correcto
      assert.match(df, new RegExp(`^EXPOSE ${ALWAYS_80.includes(tech) ? 80 : PORT}$`, 'm'));
      // CMD / ENTRYPOINT, si están en forma exec, son JSON válido
      for (const instr of ['CMD', 'ENTRYPOINT'] as const) {
        if (df.includes(`\n${instr} [`)) assert.ok(execForm(df, instr).length > 0);
      }
    });
  }
});

describe('Node.js (servidor)', () => {
  test('usa la versión de Node indicada, o la por defecto', () => {
    assert.match(generateDockerfile('node', { nodeVersion: '22' }, PORT), /^FROM node:22-alpine$/m);
    assert.match(generateDockerfile('node', {}, PORT), new RegExp(`^FROM node:${NODE_DEFAULT}-alpine$`, 'm'));
  });

  test('instala con el gestor de paquetes correcto', () => {
    assert.match(generateDockerfile('node', { packageManager: 'pnpm' }, PORT), /^RUN corepack enable && pnpm install --frozen-lockfile$/m);
    assert.match(generateDockerfile('node', { packageManager: 'yarn' }, PORT), /^RUN corepack enable && yarn install$/m);
    // npm: usa "npm ci" si hay lockfile, si no "npm install"
    assert.match(generateDockerfile('node', { packageManager: 'npm' }, PORT), /npm ci; else npm install/);
  });

  test('agrega el paso de build solo si hay comando de build', () => {
    assert.match(generateDockerfile('nextjs', { buildCommand: 'npm run build' }, PORT), /^RUN npm run build$/m);
    assert.doesNotMatch(generateDockerfile('node', {}, PORT), /run build/);
  });

  test('el comando de inicio va escapado dentro del CMD', () => {
    const start = 'node server.js --name "mi app"';
    const df = generateDockerfile('node', { startCommand: start }, PORT);
    assert.deepEqual(execForm(df, 'CMD'), ['sh', '-c', start]);
    assert.deepEqual(execForm(generateDockerfile('node', {}, PORT), 'CMD'), ['sh', '-c', 'npm start']);
  });

  test('configura el puerto y escucha en todas las interfaces', () => {
    const df = generateDockerfile('node', {}, PORT);
    assert.match(df, new RegExp(`PORT=${PORT}`));
    assert.match(df, /HOST=0\.0\.0\.0/);
    assert.deepEqual(execForm(df, 'ENTRYPOINT'), ['/sbin/tini', '--']);
  });
});

describe('SPA (React, Vue, Angular, Svelte)', () => {
  test('compila con Node y sirve con nginx', () => {
    const df = generateDockerfile('react', { nodeVersion: '22' }, PORT);
    assert.match(df, /^FROM node:22-alpine AS build$/m);
    assert.match(df, /^FROM nginx:\S+$/m);
    assert.match(df, /^COPY \.ema\/nginx-spa\.conf /m);
  });

  test('usa la carpeta de salida y el comando de build indicados', () => {
    const df = generateDockerfile('angular', { outputDir: 'dist/mi-app', buildCommand: 'yarn build' }, PORT);
    assert.match(df, /d="dist\/mi-app"/);
    assert.match(df, /^RUN yarn build$/m);
  });

  test('por defecto: salida "dist" y "npm run build"', () => {
    const df = generateDockerfile('vue', {}, PORT);
    assert.match(df, /d="dist"/);
    assert.match(df, /^RUN npm run build$/m);
  });
});

describe('Sitio estático', () => {
  test('sin docRoot copia la raíz del proyecto', () => {
    assert.match(generateDockerfile('static', {}, PORT), /^COPY \. \/usr\/share\/nginx\/html$/m);
  });

  test('con docRoot copia esa carpeta, limpiando barras sobrantes', () => {
    for (const docRoot of ['public', '/public/', 'public/']) {
      assert.match(generateDockerfile('static', { docRoot }, PORT), /^COPY public\/ \/usr\/share\/nginx\/html$/m, docRoot);
    }
  });

  test('no publica los archivos internos de AppHub', () => {
    assert.match(generateDockerfile('static', {}, PORT), /rm -rf \/usr\/share\/nginx\/html\/\.ema/);
  });
});

describe('Python', () => {
  test('versión indicada o 3.12 por defecto', () => {
    assert.match(generateDockerfile('python', { pythonVersion: '3.11' }, PORT), /^FROM python:3\.11-slim$/m);
    assert.match(generateDockerfile('python', {}, PORT), /^FROM python:3\.12-slim$/m);
  });

  test('instala el servidor que corresponde a cada framework', () => {
    assert.match(generateDockerfile('python-fastapi', {}, PORT), /^RUN pip install uvicorn\[standard\]$/m);
    assert.match(generateDockerfile('python-flask', {}, PORT), /^RUN pip install gunicorn$/m);
    assert.match(generateDockerfile('python-django', {}, PORT), /^RUN pip install gunicorn$/m);
    assert.doesNotMatch(generateDockerfile('python', {}, PORT), /pip install (gunicorn|uvicorn)/);
  });

  test('reemplaza el puerto 8000 del comando de inicio por el puerto real', () => {
    const df = generateDockerfile('python-fastapi', { startCommand: 'uvicorn main:app --host 0.0.0.0 --port 8000' }, PORT);
    assert.deepEqual(execForm(df, 'CMD'), ['sh', '-c', `uvicorn main:app --host 0.0.0.0 --port ${PORT}`]);
  });

  test('solo Django ejecuta collectstatic', () => {
    assert.match(generateDockerfile('python-django', {}, PORT), /manage\.py collectstatic/);
    assert.doesNotMatch(generateDockerfile('python-flask', {}, PORT), /collectstatic/);
  });
});

describe('PHP', () => {
  test('versión indicada o 8.3 por defecto', () => {
    assert.match(generateDockerfile('php', { phpVersion: '8.2' }, PORT), /^FROM php:8\.2-apache$/m);
    assert.match(generateDockerfile('php', {}, PORT), /^FROM php:8\.3-apache$/m);
  });

  test('document root según docRoot', () => {
    assert.match(generateDockerfile('php-laravel', { docRoot: 'public' }, PORT), /^ENV APACHE_DOCUMENT_ROOT=\/var\/www\/html\/public$/m);
    assert.match(generateDockerfile('php', {}, PORT), /^ENV APACHE_DOCUMENT_ROOT=\/var\/www\/html$/m);
  });

  test('deja la variable de Apache literal (no la reemplaza JavaScript)', () => {
    assert.match(generateDockerfile('php', {}, PORT), /s!\/var\/www\/html!\$\{APACHE_DOCUMENT_ROOT\}!g/);
  });

  test('solo Laravel prepara storage y bootstrap/cache', () => {
    assert.match(generateDockerfile('php-laravel', {}, PORT), /mkdir -p storage bootstrap\/cache/);
    assert.doesNotMatch(generateDockerfile('php', {}, PORT), /bootstrap\/cache/);
  });
});

describe('Java', () => {
  test('Maven: misma versión de Java para compilar y ejecutar', () => {
    const df = generateDockerfile('java-maven', { javaVersion: '17' }, PORT);
    assert.match(df, /^FROM maven:3\.9-eclipse-temurin-17 AS build$/m);
    assert.match(df, /^FROM eclipse-temurin:17-jre$/m);
    assert.match(df, new RegExp(`^ENV SERVER_PORT=${PORT} PORT=${PORT}$`, 'm'));
  });

  test('Gradle: usa gradlew si existe y Java 21 por defecto', () => {
    const df = generateDockerfile('java-gradle', {}, PORT);
    assert.match(df, /^FROM gradle:8-jdk21 AS build$/m);
    assert.match(df, /if \[ -f gradlew \]/);
    assert.match(df, /^FROM eclipse-temurin:21-jre$/m);
  });
});

describe('.NET', () => {
  test('publica el proyecto indicado y ejecuta su dll', () => {
    const df = generateDockerfile('dotnet', { dotnetVersion: '9.0', dotnetProject: 'src/Api/Api.csproj' }, PORT);
    assert.match(df, /^FROM mcr\.microsoft\.com\/dotnet\/sdk:9\.0 AS build$/m);
    assert.match(df, /^RUN dotnet publish "src\/Api\/Api\.csproj" /m);
    assert.deepEqual(execForm(df, 'ENTRYPOINT'), ['dotnet', 'Api.dll']);
    assert.match(df, new RegExp(`ASPNETCORE_URLS=http://\\+:${PORT}`));
  });

  test('respeta el entry explícito', () => {
    const df = generateDockerfile('dotnet', { dotnetProject: 'Api.csproj', entry: 'Otro.dll' }, PORT);
    assert.deepEqual(execForm(df, 'ENTRYPOINT'), ['dotnet', 'Otro.dll']);
  });
});

describe('Go', () => {
  test('versión indicada y binario estático', () => {
    const df = generateDockerfile('go', { goVersion: '1.23' }, PORT);
    assert.match(df, /^FROM golang:1\.23-alpine AS build$/m);
    assert.match(df, /CGO_ENABLED=0 go build/);
    assert.deepEqual(execForm(df, 'CMD'), ['/app/app']);
  });
});

describe('tecnología desconocida', () => {
  test('genera un Dockerfile genérico para completar', () => {
    for (const tech of ['unknown', 'docker', 'cobol']) {
      const df = generateDockerfile(tech, {}, PORT);
      assert.match(df, /Complete este Dockerfile/, tech);
      assert.match(df, new RegExp(`^EXPOSE ${PORT}$`, 'm'), tech);
    }
  });
});

describe('writeSupportFiles', () => {
  const withTempDir = (fn: (dir: string) => void) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'templates-'));
    try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  const readIn = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), 'utf8');

  test('crea las configuraciones de nginx y el .dockerignore', () => withTempDir((dir) => {
    writeSupportFiles(dir);
    // SPA: las rutas desconocidas vuelven a index.html (necesario para el router del frontend)
    assert.match(readIn(dir, '.ema/nginx-spa.conf'), /try_files \$uri \$uri\/ \/index\.html;/);
    // Estático: las rutas desconocidas dan 404
    assert.match(readIn(dir, '.ema/nginx-static.conf'), /try_files \$uri \$uri\/ =404;/);
    // Nunca se copian secretos ni dependencias a la imagen
    const di = readIn(dir, '.dockerignore').split('\n');
    for (const entry of ['.env', '.env.*', 'node_modules', '.git']) assert.ok(di.includes(entry), entry);
  }));

  test('no pisa un .dockerignore que ya tenga la app', () => withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, '.dockerignore'), 'propio\n');
    writeSupportFiles(dir);
    assert.equal(readIn(dir, '.dockerignore'), 'propio\n');
  }));

  test('se puede llamar dos veces sin error', () => withTempDir((dir) => {
    writeSupportFiles(dir);
    writeSupportFiles(dir);
    assert.ok(fs.existsSync(path.join(dir, '.ema/nginx-spa.conf')));
  }));
});
