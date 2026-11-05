import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detect, existingDockerfile, exposedPort } from '../src/services/detector';

// ── Proyectos de prueba: cada test arma una carpeta temporal con los archivos que necesita ──
const created: string[] = [];
after(() => { for (const d of created) fs.rmSync(d, { recursive: true, force: true }); });

/** Crea un proyecto falso. Los valores que no son texto se guardan como JSON (útil para package.json). */
function project(files: Record<string, string | object>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-'));
  created.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

/** package.json + package-lock.json (para no recibir la advertencia de lockfile en cada test). */
const npmProject = (pkg: object, extra: Record<string, string | object> = {}) =>
  project({ 'package.json': pkg, 'package-lock.json': '{}', ...extra });

describe('Node.js: frameworks de servidor', () => {
  test('Next.js', () => {
    const d = detect(npmProject({ dependencies: { next: '15', react: '19' }, scripts: { build: 'next build', start: 'next start' } }));
    assert.equal(d.technology, 'nextjs');
    assert.equal(d.confidence, 'alta');
    assert.equal(d.internalPort, 3000);
    assert.equal(d.buildConfig.buildCommand, 'npm run build');
    assert.equal(d.buildConfig.startCommand, 'npm run start');
  });

  test('Next.js sin script start usa "npx next start"', () => {
    const d = detect(npmProject({ dependencies: { next: '15' }, scripts: { build: 'next build' } }));
    assert.equal(d.buildConfig.startCommand, 'npx next start');
  });

  test('Nuxt', () => {
    const d = detect(npmProject({ dependencies: { nuxt: '3' } }));
    assert.equal(d.technology, 'nuxt');
    assert.equal(d.buildConfig.startCommand, 'node .output/server/index.mjs');
  });

  test('NestJS: prefiere "start:prod"', () => {
    assert.equal(detect(npmProject({ dependencies: { '@nestjs/core': '10' }, scripts: { 'start:prod': 'node dist/main' } })).buildConfig.startCommand, 'npm run start:prod');
    assert.equal(detect(npmProject({ dependencies: { '@nestjs/core': '10' } })).buildConfig.startCommand, 'node dist/main.js');
  });

  test('Express con puerto en el código', () => {
    const d = detect(npmProject(
      { main: 'server.js', dependencies: { express: '4' }, scripts: { start: 'node server.js' } },
      { 'server.js': 'const port = process.env.PORT || 4500;\napp.listen(port);' },
    ));
    assert.equal(d.technology, 'node');
    assert.equal(d.confidence, 'alta');
    assert.equal(d.internalPort, 4500);
    assert.equal(d.buildConfig.startCommand, 'npm run start');
  });

  test('puerto en listen() literal', () => {
    const d = detect(npmProject({ dependencies: { express: '4' }, scripts: { start: 'node index.js' } }, { 'index.js': 'app.listen(8081)' }));
    assert.equal(d.internalPort, 8081);
  });

  test('sin puerto en el código usa 3000', () => {
    assert.equal(detect(npmProject({ dependencies: { express: '4' }, scripts: { start: 'node index.js' } })).internalPort, 3000);
  });

  test('sin "start" usa "main"', () => {
    const d = detect(npmProject({ main: 'app.js', dependencies: { express: '4' } }));
    assert.equal(d.buildConfig.startCommand, 'node app.js');
    assert.deepEqual(d.warnings, []);
  });

  test('sin "start" ni "main" avisa', () => {
    const d = detect(npmProject({ dependencies: { express: '4' } }));
    assert.equal(d.buildConfig.startCommand, 'node index.js');
    assert.ok(d.warnings.some((w) => w.includes('"start"')));
  });

  test('Node sin dependencias de servidor: confianza media', () => {
    assert.equal(detect(npmProject({ scripts: { start: 'node bot.js' } })).confidence, 'media');
  });
});

describe('Node.js: SPAs', () => {
  test('React con Vite: salida "dist"', () => {
    const d = detect(npmProject({ dependencies: { react: '18' }, devDependencies: { vite: '5' }, scripts: { build: 'vite build' } }));
    assert.equal(d.technology, 'react');
    assert.equal(d.internalPort, 80);
    assert.equal(d.buildConfig.outputDir, 'dist');
  });

  test('React con Create React App: salida "build"', () => {
    assert.equal(detect(npmProject({ dependencies: { react: '18', 'react-scripts': '5' }, scripts: { build: 'x' } })).buildConfig.outputDir, 'build');
  });

  test('Vue y Svelte', () => {
    assert.equal(detect(npmProject({ dependencies: { vue: '3' }, scripts: { build: 'x' } })).technology, 'vue');
    assert.equal(detect(npmProject({ devDependencies: { svelte: '4' }, scripts: { build: 'x' } })).technology, 'svelte');
  });

  test('SvelteKit no se trata como SPA', () => {
    assert.equal(detect(npmProject({ devDependencies: { svelte: '4', '@sveltejs/kit': '2' } })).technology, 'node');
  });

  test('SPA sin script build avisa', () => {
    assert.ok(detect(npmProject({ dependencies: { vue: '3' } })).warnings.some((w) => w.includes('"build"')));
  });

  test('React + Express en dependencies es un servidor Node, no una SPA', () => {
    assert.equal(detect(npmProject({ dependencies: { react: '18', express: '4' }, scripts: { start: 'node s.js' } })).technology, 'node');
  });

  test('Express solo en devDependencies (servidor de desarrollo) sigue siendo SPA', () => {
    assert.equal(detect(npmProject({ dependencies: { react: '18' }, devDependencies: { express: '4' }, scripts: { build: 'x' } })).technology, 'react');
  });

  describe('Angular: carpeta de salida desde angular.json', () => {
    const ng = (outputPath: unknown) => detect(npmProject(
      { dependencies: { '@angular/core': '17' }, scripts: { build: 'ng build' } },
      { 'angular.json': { projects: { tienda: { architect: { build: { options: { outputPath } } } } } } },
    )).buildConfig.outputDir;

    test('outputPath como texto', () => assert.equal(ng('dist/tienda-web'), 'dist/tienda-web'));
    test('outputPath como objeto (Angular 17+)', () => assert.equal(ng({ base: 'dist/x' }), 'dist/x'));
    test('sin outputPath: dist/<proyecto>', () => assert.equal(ng(undefined), 'dist/tienda'));
    test('sin angular.json: dist', () => {
      assert.equal(detect(npmProject({ dependencies: { '@angular/core': '17' } })).buildConfig.outputDir, 'dist');
    });
  });
});

describe('Node.js: gestor de paquetes y advertencias', () => {
  test('detecta pnpm y yarn por su lockfile', () => {
    const pnpm = detect(project({ 'package.json': { dependencies: { vue: '3' } }, 'pnpm-lock.yaml': '' })).buildConfig;
    assert.equal(pnpm.packageManager, 'pnpm');
    assert.equal(pnpm.buildCommand, 'pnpm build');
    const yarn = detect(project({ 'package.json': { dependencies: { vue: '3' } }, 'yarn.lock': '' })).buildConfig;
    assert.equal(yarn.packageManager, 'yarn');
    assert.equal(yarn.buildCommand, 'yarn build');
  });

  test('npm sin package-lock.json avisa', () => {
    const d = detect(project({ 'package.json': { dependencies: { express: '4' }, scripts: { start: 'x' } } }));
    assert.ok(d.warnings.some((w) => w.includes('package-lock.json')));
  });

  test('package.json inválido avisa sin romper', () => {
    const d = detect(project({ 'package.json': '{ esto no es json', 'package-lock.json': '{}' }));
    assert.equal(d.technology, 'node');
    assert.ok(d.warnings.includes('package.json inválido'));
  });

  test('comando de test: solo si es real', () => {
    assert.equal(detect(npmProject({ scripts: { start: 'x', test: 'jest' } })).buildConfig.testCommand, 'npm run test');
    // El valor que pone "npm init" por defecto no cuenta como test
    assert.equal(detect(npmProject({ scripts: { start: 'x', test: 'echo "Error: no test specified" && exit 1' } })).buildConfig.testCommand, undefined);
  });
});

describe('Python', () => {
  test('Django: encuentra el módulo wsgi', () => {
    const d = detect(project({ 'requirements.txt': 'Django==5.0\ngunicorn', 'manage.py': '', 'tienda/wsgi.py': '' }));
    assert.equal(d.technology, 'python-django');
    assert.equal(d.internalPort, 8000);
    assert.equal(d.buildConfig.wsgiModule, 'tienda.wsgi');
    assert.equal(d.buildConfig.startCommand, 'gunicorn tienda.wsgi:application --bind 0.0.0.0:8000 --workers 3');
    assert.deepEqual(d.warnings, []);
  });

  test('Django sin gunicorn avisa que se agregará', () => {
    const d = detect(project({ 'requirements.txt': 'django', 'manage.py': '' }));
    assert.equal(d.buildConfig.wsgiModule, 'config.wsgi');
    assert.ok(d.warnings.some((w) => w.includes('gunicorn')));
  });

  test('FastAPI: encuentra el archivo que crea la app', () => {
    const d = detect(project({ 'requirements.txt': 'fastapi\nuvicorn', 'api/server.py': 'from fastapi import FastAPI\napp = FastAPI()' }));
    assert.equal(d.technology, 'python-fastapi');
    assert.equal(d.buildConfig.entry, 'api.server:app');
    assert.equal(d.buildConfig.startCommand, 'uvicorn api.server:app --host 0.0.0.0 --port 8000');
  });

  test('Flask: módulo por defecto "app"', () => {
    const d = detect(project({ 'requirements.txt': 'Flask' }));
    assert.equal(d.technology, 'python-flask');
    assert.equal(d.buildConfig.entry, 'app:app');
  });

  test('Python genérico: busca main.py, app.py o server.py', () => {
    const d = detect(project({ 'requirements.txt': 'requests', 'server.py': '' }));
    assert.equal(d.technology, 'python');
    assert.equal(d.confidence, 'media');
    assert.equal(d.buildConfig.startCommand, 'python server.py');
  });

  test('solo pyproject.toml avisa que usará "pip install ."', () => {
    const d = detect(project({ 'pyproject.toml': '[project]\ndependencies = ["fastapi"]' }));
    assert.equal(d.technology, 'python-fastapi');
    assert.ok(d.warnings.some((w) => w.includes('pyproject.toml')));
  });
});

describe('PHP', () => {
  test('Laravel por composer.json o por artisan', () => {
    for (const files of [{ 'composer.json': { require: { 'laravel/framework': '^11' } } }, { 'composer.json': {}, artisan: '' }]) {
      const d = detect(project(files));
      assert.equal(d.technology, 'php-laravel');
      assert.equal(d.buildConfig.docRoot, 'public');
    }
  });

  test('PHP con composer y carpeta public', () => {
    const d = detect(project({ 'composer.json': {}, 'public/index.php': '' }));
    assert.equal(d.technology, 'php');
    assert.equal(d.confidence, 'alta');
    assert.equal(d.buildConfig.docRoot, 'public');
  });

  test('PHP suelto, sin composer: confianza media', () => {
    const d = detect(project({ 'index.php': '<?php echo 1;' }));
    assert.equal(d.technology, 'php');
    assert.equal(d.confidence, 'media');
    assert.equal(d.buildConfig.docRoot, '');
  });
});

describe('Java', () => {
  test('Maven: toma la versión de java.version', () => {
    const d = detect(project({ 'pom.xml': '<project><properties><java.version>17</java.version></properties></project>' }));
    assert.equal(d.technology, 'java-maven');
    assert.equal(d.buildConfig.javaVersion, '17');
    assert.equal(d.internalPort, 8080);
  });

  test('Maven: también maven.compiler.release, y 21 por defecto', () => {
    assert.equal(detect(project({ 'pom.xml': '<maven.compiler.release>11</maven.compiler.release>' })).buildConfig.javaVersion, '11');
    assert.equal(detect(project({ 'pom.xml': '<project/>' })).buildConfig.javaVersion, '21');
  });

  test('Gradle (Groovy y Kotlin)', () => {
    assert.equal(detect(project({ 'build.gradle': '' })).technology, 'java-gradle');
    assert.equal(detect(project({ 'build.gradle.kts': '' })).technology, 'java-gradle');
  });
});

describe('.NET', () => {
  test('toma la versión del TargetFramework y el nombre de la dll', () => {
    const d = detect(project({ 'src/Api/Api.csproj': '<Project><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>' }));
    assert.equal(d.technology, 'dotnet');
    assert.equal(d.buildConfig.dotnetVersion, '9.0');
    assert.equal(d.buildConfig.dotnetProject, path.join('src', 'Api', 'Api.csproj'));
    assert.equal(d.buildConfig.entry, 'Api.dll');
  });

  test('varios .csproj: avisa cuál usará', () => {
    const d = detect(project({ 'A.csproj': '<TargetFramework>net8.0</TargetFramework>', 'tests/B.csproj': '' }));
    assert.ok(d.warnings.some((w) => w.includes('2 proyectos')));
  });
});

describe('Go', () => {
  test('toma la versión de go.mod', () => {
    const d = detect(project({ 'go.mod': 'module ema/api\n\ngo 1.23.4\n' }));
    assert.equal(d.technology, 'go');
    assert.equal(d.buildConfig.goVersion, '1.23');
  });
});

describe('Dockerfile propio', () => {
  test('sin otra tecnología: usa el EXPOSE del Dockerfile', () => {
    const d = detect(project({ Dockerfile: 'FROM alpine\nEXPOSE 9000\nCMD ["x"]' }));
    assert.equal(d.technology, 'docker');
    assert.equal(d.internalPort, 9000);
    assert.equal(d.hasDockerfile, true);
  });

  test('sin EXPOSE: 8080', () => {
    assert.equal(detect(project({ Dockerfile: 'FROM alpine' })).internalPort, 8080);
  });

  test('con otra tecnología: la detecta igual y marca hasDockerfile', () => {
    const d = detect(npmProject({ dependencies: { express: '4' }, scripts: { start: 'x' } }, { Dockerfile: 'FROM node' }));
    assert.equal(d.technology, 'node');
    assert.equal(d.hasDockerfile, true);
  });

  test('marca hasCompose con cualquiera de sus nombres', () => {
    for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml']) {
      assert.equal(detect(project({ Dockerfile: 'FROM x', [f]: '' })).hasCompose, true, f);
    }
  });

  test('existingDockerfile y exposedPort', () => {
    assert.equal(existingDockerfile(project({ Dockerfile: 'FROM x' })), 'FROM x');
    assert.equal(existingDockerfile(project({ 'a.txt': '' })), null);
    assert.equal(exposedPort('FROM x\n  expose 7000/tcp'), 7000);
    assert.equal(exposedPort('FROM x'), null);
  });
});

describe('Sitio estático', () => {
  test('index.html en la raíz', () => {
    const d = detect(project({ 'index.html': '<h1>Hola</h1>' }));
    assert.equal(d.technology, 'static');
    assert.equal(d.confidence, 'alta');
    assert.equal(d.buildConfig.docRoot, '');
  });

  test('index.html en una subcarpeta', () => {
    const d = detect(project({ 'sitio/index.html': '' }));
    assert.equal(d.technology, 'static');
    assert.equal(d.confidence, 'media');
    assert.equal(d.buildConfig.docRoot, 'sitio');
  });
});

describe('sin tecnología reconocible', () => {
  test('carpeta vacía o con archivos desconocidos', () => {
    for (const files of [{}, { 'LEEME.txt': 'hola' }]) {
      const d = detect(project(files));
      assert.equal(d.technology, 'unknown');
      assert.equal(d.confidence, 'baja');
      assert.ok(d.warnings.some((w) => w.includes('No se pudo detectar')));
    }
  });

  test('ignora node_modules, .git, venv, etc. al buscar archivos', () => {
    const d = detect(project({ 'node_modules/x/index.html': '', '.git/a.php': '', 'venv/lib/x.csproj': '' }));
    assert.equal(d.technology, 'unknown');
  });
});

describe('prioridad entre tecnologías', () => {
  test('Node gana sobre Python cuando hay ambos', () => {
    assert.equal(detect(npmProject({ dependencies: { vue: '3' } }, { 'requirements.txt': 'flask' })).technology, 'vue');
  });

  test('Python gana sobre un index.html suelto', () => {
    assert.equal(detect(project({ 'requirements.txt': 'flask', 'index.html': '' })).technology, 'python-flask');
  });

  test('registra los archivos marcadores encontrados', () => {
    const d = detect(npmProject({ dependencies: { vue: '3' } }, { 'vite.config.ts': '' }));
    for (const m of ['package.json', 'package-lock.json', 'vite.config.ts']) assert.ok(d.markers.includes(m), m);
  });
});
