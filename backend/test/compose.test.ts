import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { generateCompose, ComposeInput } from '../src/services/compose';
import { config } from '../src/config';

const BASE: ComposeInput = { slug: 'tienda', env: 'production', image: 'ema/tienda:1.0.0', internalPort: 3000 };

/** Genera el compose y lo devuelve ya parseado, para verificar la estructura y no el texto. */
const compose = (over: Partial<ComposeInput> = {}) => YAML.parse(generateCompose({ ...BASE, ...over }));
const app = (over: Partial<ComposeInput> = {}) => compose(over).services.app;

/** Cambia la configuración global solo durante `fn` y la restaura después. */
function withConfig(over: Partial<typeof config>, fn: () => void) {
  const saved = { ...config };
  Object.assign(config, over);
  try { fn(); } finally { Object.assign(config, saved); }
}

describe('estructura básica', () => {
  test('encabezado y YAML válido', () => {
    const text = generateCompose(BASE);
    assert.ok(text.startsWith('# Generado por EMA AppHub — tienda (production)\n'));
    assert.doesNotThrow(() => YAML.parse(text));
  });

  test('nombre de proyecto y contenedor: ema-<slug>-<ambiente>', () => {
    const doc = compose();
    assert.equal(doc.name, 'ema-tienda-production');
    assert.equal(doc.services.app.container_name, 'ema-tienda-production');
    assert.equal(doc.services.app.image, 'ema/tienda:1.0.0');
  });

  test('reinicio automático y logs con rotación (no llenan el disco)', () => {
    const a = app();
    assert.equal(a.restart, 'unless-stopped');
    assert.deepEqual(a.logging, { driver: 'json-file', options: { 'max-size': '20m', 'max-file': '5' } });
  });

  test('etiquetas para que AppHub reconozca sus contenedores', () => {
    const l = app().labels;
    assert.equal(l['ema.managed'], 'true');
    assert.equal(l['ema.app'], 'tienda');
    assert.equal(l['ema.env'], 'production');
    assert.equal(l['ema.service'], 'app');
  });

  test('redes: la compartida de apps (externa) y una interna propia', () => {
    const doc = compose();
    assert.deepEqual(doc.services.app.networks, ['ema_apps', 'internal']);
    assert.deepEqual(doc.networks.ema_apps, { external: true, name: config.appsNetwork });
    assert.deepEqual(doc.networks.internal, { name: 'ema-tienda-production-net' });
  });
});

describe('secretos', () => {
  test('las variables se leen de .env, nunca se escriben en el compose', () => {
    const doc = compose({ database: { engine: 'postgres', version: '16', databaseName: 'tienda' } });
    assert.deepEqual(doc.services.app.env_file, ['.env']);
    assert.deepEqual(doc.services.db.env_file, ['db.env']);
    assert.equal(doc.services.app.environment, undefined);
    assert.equal(doc.services.db.environment, undefined);
  });
});

describe('Traefik (dominio y HTTPS)', () => {
  test('sin dominio: Traefik desactivado', () => {
    assert.equal(app().labels['traefik.enable'], 'false');
  });

  test('con dominio y HTTPS (por defecto): certificado y redirección de http a https', () => {
    withConfig({ traefikEnabled: true, traefikCertResolver: 'letsencrypt' }, () => {
      const l = app({ domain: 'tienda.ema.com.ar' }).labels;
      const r = 'traefik.http.routers.ema-tienda-production';
      assert.equal(l['traefik.enable'], 'true');
      assert.equal(l['traefik.http.services.ema-tienda-production.loadbalancer.server.port'], '3000');
      assert.equal(l[`${r}.rule`], 'Host(`tienda.ema.com.ar`)');
      assert.equal(l[`${r}.entrypoints`], 'websecure');
      assert.equal(l[`${r}.tls`], 'true');
      assert.equal(l[`${r}.tls.certresolver`], 'letsencrypt');
      assert.equal(l[`${r}-http.entrypoints`], 'web');
      assert.equal(l[`${r}-http.middlewares`], 'redirect-to-https@file');
    });
  });

  test('con dominio y HTTPS desactivado: solo http, sin certificado', () => {
    withConfig({ traefikEnabled: true }, () => {
      const l = app({ domain: 'tienda.local', httpsEnabled: false }).labels;
      const r = 'traefik.http.routers.ema-tienda-production';
      assert.equal(l[`${r}.entrypoints`], 'web');
      assert.equal(l[`${r}.tls`], undefined);
      assert.equal(l[`${r}-http.rule`], undefined);
    });
  });

  test('con Traefik desactivado en el servidor, el dominio se ignora', () => {
    withConfig({ traefikEnabled: false }, () => {
      const l = app({ domain: 'tienda.ema.com.ar' }).labels;
      assert.equal(l['traefik.enable'], 'false');
      assert.equal(Object.keys(l).filter((k) => k.startsWith('traefik.http')).length, 0);
    });
  });

  test('usa la red de apps configurada', () => {
    withConfig({ traefikEnabled: true, appsNetwork: 'otra_red' }, () => {
      const doc = compose({ domain: 'x.com' });
      assert.equal(doc.services.app.labels['traefik.docker.network'], 'otra_red');
      assert.equal(doc.networks.ema_apps.name, 'otra_red');
    });
  });
});

describe('puertos', () => {
  test('sin puerto externo no publica nada', () => {
    assert.equal(app().ports, undefined);
    assert.equal(app({ externalPort: null }).ports, undefined);
  });

  test('puerto externo → interno', () => {
    assert.deepEqual(app({ externalPort: 8100 }).ports, ['8100:3000']);
  });

  test('puertos extra, con soporte UDP', () => {
    const ports = app({ externalPort: 8100, extraPorts: [{ internal: 9000, external: 8101 }, { internal: 53, external: 8153, protocol: 'udp' }] }).ports;
    assert.deepEqual(ports, ['8100:3000', '8101:9000', '8153:53/udp']);
  });
});

describe('volúmenes', () => {
  test('volumen con nombre: se declara con el prefijo del proyecto', () => {
    const doc = compose({ volumes: [{ type: 'volume', source: 'uploads', target: '/app/uploads' }] });
    assert.deepEqual(doc.services.app.volumes, ['uploads:/app/uploads']);
    assert.deepEqual(doc.volumes.uploads, { name: 'ema-tienda-production-uploads' });
  });

  test('bind mount: no se declara como volumen; solo lectura con ":ro"', () => {
    const doc = compose({ volumes: [{ type: 'bind', source: '/data/apps/tienda/data/cfg', target: '/cfg', readOnly: true }] });
    assert.deepEqual(doc.services.app.volumes, ['/data/apps/tienda/data/cfg:/cfg:ro']);
    assert.equal(doc.volumes, undefined);
  });

  test('sin volúmenes no agrega la sección', () => {
    const doc = compose();
    assert.equal(doc.services.app.volumes, undefined);
    assert.equal(doc.volumes, undefined);
  });
});

describe('límites de recursos', () => {
  test('memoria y CPU', () => {
    assert.deepEqual(app({ memoryLimitMb: 512, cpuLimit: 1.5 }).deploy, { resources: { limits: { memory: '512M', cpus: '1.5' } } });
  });

  test('solo uno de los dos', () => {
    assert.deepEqual(app({ memoryLimitMb: 256 }).deploy.resources.limits, { memory: '256M' });
    assert.deepEqual(app({ cpuLimit: 2 }).deploy.resources.limits, { cpus: '2' });
  });

  test('sin límites no agrega la sección', () => {
    assert.equal(app().deploy, undefined);
    assert.equal(app({ memoryLimitMb: null, cpuLimit: null }).deploy, undefined);
  });
});

describe('base de datos PostgreSQL', () => {
  const withDb = () => compose({ database: { engine: 'postgres', version: '16', databaseName: 'tienda' } });

  test('sin base de datos solo existe el servicio app', () => {
    assert.deepEqual(Object.keys(compose().services), ['app']);
  });

  test('servicio db con la versión pedida y nombre de contenedor propio', () => {
    const db = withDb().services.db;
    assert.equal(db.image, 'postgres:16-alpine');
    assert.equal(db.container_name, 'ema-tienda-production-db');
    assert.equal(db.labels['ema.service'], 'db');
  });

  test('la app espera a que la base esté lista', () => {
    const doc = withDb();
    assert.deepEqual(doc.services.app.depends_on, { db: { condition: 'service_healthy' } });
    // "$$" es como Compose escapa un "$": la variable la resuelve el contenedor, no Compose
    assert.deepEqual(doc.services.db.healthcheck.test, ['CMD-SHELL', 'pg_isready -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"']);
  });

  test('la base solo está en la red interna (no accesible desde otras apps)', () => {
    const db = withDb().services.db;
    assert.deepEqual(db.networks, ['internal']);
    assert.equal(db.ports, undefined);
  });

  test('los datos persisten en un volumen propio', () => {
    const doc = withDb();
    assert.deepEqual(doc.services.db.volumes, ['dbdata:/var/lib/postgresql/data']);
    assert.deepEqual(doc.volumes.dbdata, { name: 'ema-tienda-production-dbdata' });
  });

  test('convive con volúmenes de la app', () => {
    const doc = compose({ database: { engine: 'postgres', version: '17', databaseName: 'x' }, volumes: [{ type: 'volume', source: 'files', target: '/files' }] });
    assert.deepEqual(Object.keys(doc.volumes).sort(), ['dbdata', 'files']);
  });
});
