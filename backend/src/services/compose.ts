import YAML from 'yaml';
import { config } from '../config';
import { dbContainerName, projectName } from '../lib/util';

export interface VolumeSpec { source: string; target: string; type: 'volume' | 'bind'; readOnly?: boolean }
export interface PortSpec { internal: number; external: number; protocol?: 'tcp' | 'udp' }

export interface ComposeInput {
  slug: string;
  env: string;
  image: string;
  internalPort: number;
  externalPort?: number | null;
  extraPorts?: PortSpec[];
  domain?: string | null;
  httpsEnabled?: boolean;
  /** Publicación por ruta ("/holaema"): ya normalizada (ver lib/appPath). */
  pathPrefix?: string | null;
  volumes?: VolumeSpec[];
  memoryLimitMb?: number | null;
  cpuLimit?: number | null;
  replicas?: number;
  database?: { engine: string; version: string; databaseName: string } | null;
}

/** Genera el docker-compose.yml de un ambiente. Las credenciales nunca se escriben aquí: van en .env / db.env (0600). */
export function generateCompose(i: ComposeInput): string {
  const proj = projectName(i.slug, i.env);
  const router = proj.replace(/[^a-z0-9-]/g, '');
  const labels: Record<string, string> = {
    'ema.managed': 'true',
    'ema.app': i.slug,
    'ema.env': i.env,
    'ema.service': 'app',
  };
  if (config.traefikEnabled && (i.domain || i.pathPrefix)) {
    Object.assign(labels, {
      'traefik.enable': 'true',
      'traefik.docker.network': config.appsNetwork,
      [`traefik.http.services.${router}.loadbalancer.server.port`]: String(i.internalPort),
      [`traefik.http.routers.${router}.rule`]: `Host(\`${i.domain}\`)`,
      [`traefik.http.routers.${router}.service`]: router,
    });
    if (i.pathPrefix) {
      // Por ruta: "/holaema" y todo lo que esté debajo; la app recibe la dirección sin la ruta ("/holaema/x" → "/x")
      // y la ruta original en X-Forwarded-Prefix. Va por http: el HTTPS lo pone el proxy que está adelante
      // (nginx de AppHub o el de la empresa).
      const pathRule = `(Path(\`${i.pathPrefix}\`) || PathPrefix(\`${i.pathPrefix}/\`))`;
      Object.assign(labels, {
        [`traefik.http.routers.${router}.rule`]: i.domain ? `Host(\`${i.domain}\`) && ${pathRule}` : pathRule,
        [`traefik.http.routers.${router}.entrypoints`]: 'web',
        [`traefik.http.routers.${router}.middlewares`]: `${router}-strip`,
        [`traefik.http.middlewares.${router}-strip.stripprefix.prefixes`]: i.pathPrefix,
      });
    } else if (i.httpsEnabled !== false) {
      Object.assign(labels, {
        [`traefik.http.routers.${router}.entrypoints`]: 'websecure',
        [`traefik.http.routers.${router}.tls`]: 'true',
        [`traefik.http.routers.${router}.tls.certresolver`]: config.traefikCertResolver,
        [`traefik.http.routers.${router}-http.rule`]: `Host(\`${i.domain}\`)`,
        [`traefik.http.routers.${router}-http.entrypoints`]: 'web',
        [`traefik.http.routers.${router}-http.middlewares`]: 'redirect-to-https@file',
        [`traefik.http.routers.${router}-http.service`]: router,
      });
    } else {
      labels[`traefik.http.routers.${router}.entrypoints`] = 'web';
    }
  } else {
    labels['traefik.enable'] = 'false';
  }

  const ports: string[] = [];
  if (i.externalPort) ports.push(`${i.externalPort}:${i.internalPort}`);
  for (const p of i.extraPorts || []) ports.push(`${p.external}:${p.internal}${p.protocol === 'udp' ? '/udp' : ''}`);

  const namedVolumes: Record<string, unknown> = {};
  const vols = (i.volumes || []).map((v) => {
    if (v.type === 'volume') {
      const name = `${proj}-${v.source}`;
      namedVolumes[v.source] = { name };
    }
    return `${v.source}:${v.target}${v.readOnly ? ':ro' : ''}`;
  });

  const app: any = {
    image: i.image,
    container_name: proj,
    restart: 'unless-stopped',
    env_file: ['.env'],
    labels,
    networks: ['ema_apps', 'internal'],
    logging: { driver: 'json-file', options: { 'max-size': '20m', 'max-file': '5' } },
  };
  if (ports.length) app.ports = ports;
  if (vols.length) app.volumes = vols;
  if (i.memoryLimitMb || i.cpuLimit) {
    app.deploy = { resources: { limits: { ...(i.memoryLimitMb ? { memory: `${i.memoryLimitMb}M` } : {}), ...(i.cpuLimit ? { cpus: String(i.cpuLimit) } : {}) } } };
  }

  const services: Record<string, unknown> = { app };

  if (i.database) {
    app.depends_on = { db: { condition: 'service_healthy' } };
    namedVolumes.dbdata = { name: `${proj}-dbdata` };
    services.db = {
      image: `postgres:${i.database.version}-alpine`,
      container_name: dbContainerName(i.slug, i.env),
      restart: 'unless-stopped',
      env_file: ['db.env'],
      volumes: ['dbdata:/var/lib/postgresql/data'],
      networks: ['internal'],
      labels: { 'ema.managed': 'true', 'ema.app': i.slug, 'ema.env': i.env, 'ema.service': 'db' },
      healthcheck: {
        test: ['CMD-SHELL', 'pg_isready -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"'],
        interval: '5s', timeout: '5s', retries: 20,
      },
      logging: { driver: 'json-file', options: { 'max-size': '20m', 'max-file': '3' } },
    };
  }

  const doc: any = {
    name: proj,
    services,
    networks: {
      ema_apps: { external: true, name: config.appsNetwork },
      internal: { name: `${proj}-net` },
    },
  };
  if (Object.keys(namedVolumes).length) doc.volumes = namedVolumes;
  return `# Generado por EMA AppHub — ${i.slug} (${i.env})\n` + YAML.stringify(doc, { lineWidth: 0 });
}
