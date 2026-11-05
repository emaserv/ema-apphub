import fs from 'fs';
import path from 'path';
import { resolveNodeVersion } from './nodeVersion';
import { DOTNET_DEFAULT, DOTNET_SUPPORTED, resolveGoVersion } from './imageVersions';

export interface BuildConfig {
  packageManager?: 'npm' | 'yarn' | 'pnpm';
  nodeVersion?: string;
  pythonVersion?: string;
  phpVersion?: string;
  javaVersion?: string;
  dotnetVersion?: string;
  goVersion?: string;
  installCommand?: string;
  buildCommand?: string;
  startCommand?: string;
  testCommand?: string;
  outputDir?: string;
  docRoot?: string;
  entry?: string;          // módulo python (main:app), dll .NET, etc.
  wsgiModule?: string;
  dotnetProject?: string;
}

export interface Detection {
  technology: string;
  label: string;
  confidence: 'alta' | 'media' | 'baja';
  markers: string[];
  internalPort: number;
  healthcheckPath: string;
  buildConfig: BuildConfig;
  hasDockerfile: boolean;
  hasCompose: boolean;
  warnings: string[];
}

export const TECHNOLOGIES: Record<string, { label: string; port: number; family: string }> = {
  static:          { label: 'HTML / CSS / JavaScript', port: 80, family: 'web' },
  react:           { label: 'React (SPA)', port: 80, family: 'node-spa' },
  vue:             { label: 'Vue (SPA)', port: 80, family: 'node-spa' },
  angular:         { label: 'Angular (SPA)', port: 80, family: 'node-spa' },
  svelte:          { label: 'Svelte (SPA)', port: 80, family: 'node-spa' },
  nextjs:          { label: 'Next.js', port: 3000, family: 'node' },
  nuxt:            { label: 'Nuxt', port: 3000, family: 'node' },
  nestjs:          { label: 'NestJS', port: 3000, family: 'node' },
  node:            { label: 'Node.js', port: 3000, family: 'node' },
  'python-django': { label: 'Python · Django', port: 8000, family: 'python' },
  'python-fastapi':{ label: 'Python · FastAPI', port: 8000, family: 'python' },
  'python-flask':  { label: 'Python · Flask', port: 8000, family: 'python' },
  python:          { label: 'Python', port: 8000, family: 'python' },
  'php-laravel':   { label: 'PHP · Laravel', port: 80, family: 'php' },
  php:             { label: 'PHP', port: 80, family: 'php' },
  'java-maven':    { label: 'Java · Maven', port: 8080, family: 'java' },
  'java-gradle':   { label: 'Java · Gradle', port: 8080, family: 'java' },
  dotnet:          { label: '.NET', port: 8080, family: 'dotnet' },
  go:              { label: 'Go', port: 8080, family: 'go' },
  docker:          { label: 'Dockerfile propio', port: 8080, family: 'docker' },
  unknown:         { label: 'Desconocida', port: 8080, family: 'docker' },
};

const exists = (root: string, f: string) => fs.existsSync(path.join(root, f));
const read = (root: string, f: string) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } };

function findFiles(root: string, pred: (name: string) => boolean, maxDepth = 3): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (['node_modules', '.git', 'vendor', 'bin', 'obj', 'target', 'dist', 'build', '.venv', 'venv'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (pred(e.name)) out.push(path.relative(root, p));
    }
  };
  walk(root, 0);
  return out;
}

function exposePort(dockerfile: string): number | null {
  const m = dockerfile.match(/^\s*EXPOSE\s+(\d+)/im);
  return m ? Number(m[1]) : null;
}

export function detect(root: string): Detection {
  const markers: string[] = [];
  const warnings: string[] = [];
  const mark = (f: string) => { if (exists(root, f)) markers.push(f); return exists(root, f); };

  const hasDockerfile = mark('Dockerfile');
  const hasCompose = mark('docker-compose.yml') || mark('docker-compose.yaml') || mark('compose.yaml');
  [ 'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'vite.config.js', 'vite.config.ts', 'next.config.js',
    'next.config.mjs', 'angular.json', 'nuxt.config.ts', 'requirements.txt', 'pyproject.toml', 'Pipfile', 'manage.py',
    'composer.json', 'artisan', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'go.mod', 'index.html' ].forEach(mark);
  const csproj = findFiles(root, (n) => n.endsWith('.csproj'), 2);
  markers.push(...csproj);

  const base = (technology: string, confidence: Detection['confidence'], buildConfig: BuildConfig, port?: number): Detection => ({
    technology, label: TECHNOLOGIES[technology].label, confidence, markers, buildConfig,
    internalPort: port ?? TECHNOLOGIES[technology].port, healthcheckPath: '/', hasDockerfile, hasCompose, warnings,
  });

  // ── Node.js / frameworks JS
  if (exists(root, 'package.json')) {
    let pkg: any = {};
    try { pkg = JSON.parse(read(root, 'package.json')); } catch { warnings.push('package.json inválido'); }
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const scripts = pkg.scripts || {};
    const pm: BuildConfig['packageManager'] = exists(root, 'pnpm-lock.yaml') ? 'pnpm' : exists(root, 'yarn.lock') ? 'yarn' : 'npm';
    const run = (s: string) => (pm === 'npm' ? `npm run ${s}` : `${pm} ${s}`);
    const { version: nodeVersion, warning: nodeWarning } = resolveNodeVersion(pkg.engines?.node);
    if (nodeWarning) warnings.push(nodeWarning);
    const common: BuildConfig = { packageManager: pm, nodeVersion, testCommand: scripts.test && !/no test specified/.test(scripts.test) ? run('test') : undefined };
    if (!exists(root, 'package-lock.json') && pm === 'npm') warnings.push('No hay package-lock.json: se usará "npm install" (builds menos reproducibles).');

    if (deps.next) return base('nextjs', 'alta', { ...common, buildCommand: run('build'), startCommand: scripts.start ? run('start') : 'npx next start' });
    if (deps.nuxt) return base('nuxt', 'alta', { ...common, buildCommand: run('build'), startCommand: 'node .output/server/index.mjs' });
    if (deps['@nestjs/core']) return base('nestjs', 'alta', { ...common, buildCommand: run('build'), startCommand: scripts['start:prod'] ? run('start:prod') : 'node dist/main.js' });

    const spa = (tech: string, outputDir: string) => {
      if (!scripts.build) warnings.push('No se encontró script "build" en package.json.');
      return base(tech, 'alta', { ...common, buildCommand: run('build'), outputDir });
    };
    if (deps['@angular/core']) {
      let out = 'dist';
      try {
        const aj = JSON.parse(read(root, 'angular.json'));
        const proj = aj.defaultProject || Object.keys(aj.projects || {})[0];
        const op = aj.projects?.[proj]?.architect?.build?.options?.outputPath;
        out = typeof op === 'string' ? op : op?.base || `dist/${proj}`;
      } catch { /* default */ }
      return spa('angular', out);
    }
    const serverDeps = ['express', 'fastify', 'koa', '@hapi/hapi', 'socket.io', 'pg', 'mysql2', 'mongoose', 'prisma', '@prisma/client', 'sequelize', 'typeorm'];
    const isServer = serverDeps.some((d) => pkg.dependencies?.[d]);
    if (!isServer) {
      if (deps.vue) return spa('vue', 'dist');
      if (deps.svelte && !deps['@sveltejs/kit']) return spa('svelte', 'dist');
      if (deps.react) return spa('react', deps['react-scripts'] ? 'build' : 'dist');
    }
    let start = scripts.start ? run('start') : pkg.main ? `node ${pkg.main}` : 'node index.js';
    const portGuess = (read(root, pkg.main || 'index.js') + read(root, 'server.js') + read(root, 'src/index.js') + read(root, 'src/server.ts'))
      .match(/PORT\s*\|\|\s*(\d{2,5})|listen\(\s*(\d{2,5})/);
    const port = portGuess ? Number(portGuess[1] || portGuess[2]) : 3000;
    if (!scripts.start && !pkg.main) { warnings.push('No se encontró script "start" ni "main": revise el comando de inicio.'); start = 'node index.js'; }
    return base('node', isServer ? 'alta' : 'media', { ...common, buildCommand: scripts.build ? run('build') : undefined, startCommand: start }, port);
  }

  // ── Python
  if (exists(root, 'requirements.txt') || exists(root, 'pyproject.toml') || exists(root, 'Pipfile')) {
    const reqs = (read(root, 'requirements.txt') + read(root, 'pyproject.toml') + read(root, 'Pipfile')).toLowerCase();
    const pythonVersion = '3.12';
    if (!exists(root, 'requirements.txt')) warnings.push('Sin requirements.txt: se intentará "pip install ." usando pyproject.toml.');
    if (exists(root, 'manage.py') || reqs.includes('django')) {
      const wsgi = findFiles(root, (n) => n === 'wsgi.py', 2)[0];
      const mod = wsgi ? wsgi.replace(/\.py$/, '').split(path.sep).join('.') : 'config.wsgi';
      if (!reqs.includes('gunicorn')) warnings.push('Se agregará gunicorn en la imagen.');
      return base('python-django', 'alta', { pythonVersion, wsgiModule: mod, startCommand: `gunicorn ${mod}:application --bind 0.0.0.0:8000 --workers 3` });
    }
    const pyFiles = findFiles(root, (n) => n.endsWith('.py'), 2);
    const findApp = (re: RegExp) => {
      for (const f of pyFiles) { if (re.test(read(root, f))) return f.replace(/\.py$/, '').split(path.sep).join('.'); }
      return null;
    };
    if (reqs.includes('fastapi')) {
      const mod = findApp(/FastAPI\s*\(/) || 'main';
      return base('python-fastapi', 'alta', { pythonVersion, entry: `${mod}:app`, startCommand: `uvicorn ${mod}:app --host 0.0.0.0 --port 8000` });
    }
    if (reqs.includes('flask')) {
      const mod = findApp(/Flask\s*\(/) || 'app';
      return base('python-flask', 'alta', { pythonVersion, entry: `${mod}:app`, startCommand: `gunicorn ${mod}:app --bind 0.0.0.0:8000 --workers 3` });
    }
    const main = ['main.py', 'app.py', 'server.py'].find((f) => exists(root, f)) || 'main.py';
    return base('python', 'media', { pythonVersion, startCommand: `python ${main}` });
  }

  // ── PHP
  if (exists(root, 'composer.json') || findFiles(root, (n) => n.endsWith('.php'), 1).length) {
    const composer = read(root, 'composer.json');
    if (composer.includes('laravel/framework') || exists(root, 'artisan')) {
      return base('php-laravel', 'alta', { phpVersion: '8.3', docRoot: 'public' });
    }
    return base('php', exists(root, 'composer.json') ? 'alta' : 'media', { phpVersion: '8.3', docRoot: exists(root, 'public/index.php') ? 'public' : '' });
  }

  // ── Java
  if (exists(root, 'pom.xml')) {
    const v = read(root, 'pom.xml').match(/<(?:java\.version|maven\.compiler\.release)>(\d+)</)?.[1] || '21';
    return base('java-maven', 'alta', { javaVersion: v, buildCommand: 'mvn -B -DskipTests package', testCommand: 'mvn -B test' });
  }
  if (exists(root, 'build.gradle') || exists(root, 'build.gradle.kts')) {
    return base('java-gradle', 'alta', { javaVersion: '21', buildCommand: 'gradle bootJar --no-daemon || gradle build -x test --no-daemon' });
  }

  // ── .NET
  if (csproj.length) {
    const proj = csproj[0];
    const txt = read(root, proj);
    const tf = txt.match(/<TargetFramework>net(\d+)\.\d+<\/TargetFramework>/)?.[1] || DOTNET_DEFAULT;
    const name = path.basename(proj, '.csproj');
    if (!DOTNET_SUPPORTED.includes(tf)) {
      warnings.push(`El proyecto usa .NET ${tf}.0, que no tiene soporte de Microsoft. Conviene actualizar <TargetFramework> a net${DOTNET_DEFAULT}.0.`);
    }
    if (csproj.length > 1) warnings.push(`Se encontraron ${csproj.length} proyectos .csproj; se usará ${proj}.`);
    return base('dotnet', 'alta', { dotnetVersion: `${tf}.0`, dotnetProject: proj, entry: `${name}.dll` });
  }

  // ── Go
  if (exists(root, 'go.mod')) {
    const v = resolveGoVersion(read(root, 'go.mod').match(/^go\s+(\d+\.\d+)/m)?.[1]);
    return base('go', 'alta', { goVersion: v });
  }

  // ── Dockerfile propio sin marcadores conocidos
  if (hasDockerfile) {
    const p = exposePort(read(root, 'Dockerfile')) ?? 8080;
    return base('docker', 'alta', {}, p);
  }

  // ── Estático
  if (exists(root, 'index.html') || findFiles(root, (n) => n === 'index.html', 2).length) {
    const idx = exists(root, 'index.html') ? '' : path.dirname(findFiles(root, (n) => n === 'index.html', 2)[0]);
    return base('static', exists(root, 'index.html') ? 'alta' : 'media', { docRoot: idx });
  }

  warnings.push('No se pudo detectar la tecnología. Seleccione una manualmente o provea un Dockerfile.');
  return base('unknown', 'baja', {});
}

export function existingDockerfile(root: string): string | null {
  const p = path.join(root, 'Dockerfile');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

export function exposedPort(dockerfile: string): number | null {
  return exposePort(dockerfile);
}
