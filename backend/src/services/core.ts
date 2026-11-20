import fs from 'fs';
import path from 'path';
import { config, paths } from '../config';
import { one, q } from '../db/pool';
import { RESERVED_PATHS } from '../lib/appPath';
import { decrypt, encrypt } from '../lib/crypto';
import { conflict, notFound } from '../lib/http';
import { projectName, toDotenvLine } from '../lib/util';
import { generateCompose, VolumeSpec, PortSpec } from './compose';
import * as dockerSvc from './docker';

export interface AppRow {
  id: string; slug: string; name: string; description: string | null; technology: string; detected_technology: string | null;
  framework_label: string | null; internal_port: number; healthcheck_path: string | null; build_config: any;
  registry_id: string | null; current_version_id: string | null; storage_path: string; author_id: string | null;
  created_at: string; updated_at: string;
}
export interface EnvRow {
  id: string; application_id: string; name: string; is_default: boolean; internal_port: number | null; external_port: number | null;
  domain: string | null; https_enabled: boolean; path_prefix: string | null; volumes: VolumeSpec[]; extra_ports: PortSpec[]; replicas: number;
  memory_limit_mb: number | null; cpu_limit: string | null; deployed_version_id: string | null; status: string;
  health_status: string; health_checked_at: string | null;
}
export interface VersionRow {
  id: string; application_id: string; version: string; source_type: string; source_path: string; dockerfile: string;
  compose_file: string | null; technology: string | null; build_config: any; env_snapshot_enc: string | null;
  commit_sha: string | null; comment: string | null; size_bytes: string | null; created_by: string | null; created_at: string;
}

export async function getApp(idOrSlug: string): Promise<AppRow> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(idOrSlug);
  const app = await one<AppRow>(`SELECT * FROM applications WHERE ${isUuid ? 'id' : 'slug'} = $1`, [idOrSlug]);
  if (!app) throw notFound('Aplicación no encontrada');
  return app;
}

/** Ambiente por nombre; sin nombre devuelve el ambiente por defecto. */
export async function getEnv(appId: string, name?: string | null): Promise<EnvRow> {
  const env = name
    ? await one<EnvRow>(`SELECT * FROM application_environments WHERE application_id=$1 AND name=$2`, [appId, name])
    : await one<EnvRow>(`SELECT * FROM application_environments WHERE application_id=$1 ORDER BY is_default DESC, created_at LIMIT 1`, [appId]);
  if (!env) throw notFound(`Ambiente ${name ?? 'por defecto'} no encontrado`);
  return env;
}

export async function getVersion(appId: string, versionId: string): Promise<VersionRow> {
  const v = await one<VersionRow>(`SELECT * FROM application_versions WHERE application_id=$1 AND id=$2`, [appId, versionId]);
  if (!v) throw notFound('Versión no encontrada');
  return v;
}

export const imageTag = (slug: string, version: string) => `${config.imagePrefix}/${slug}:${version.replace(/^v/, '')}`;

export async function registryTag(app: AppRow, version: string): Promise<{ tag: string; registry: any } | null> {
  if (!app.registry_id) return null;
  const r = await one(`SELECT * FROM docker_registries WHERE id=$1`, [app.registry_id]);
  if (!r) return null;
  const host = r.kind === 'dockerhub' ? '' : `${r.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}/`;
  const ns = r.namespace ? `${r.namespace}/` : '';
  return { tag: `${host}${ns}${app.slug}:${version.replace(/^v/, '')}`, registry: r };
}

// ───────── variables de entorno ─────────

export interface EnvVarRow { id: string; key: string; value: string | null; value_enc: string | null; is_secret: boolean; is_system: boolean; updated_at: string }

export async function listVars(envId: string): Promise<EnvVarRow[]> {
  return q<EnvVarRow>(`SELECT id, key, value, value_enc, is_secret, is_system, updated_at FROM environment_variables WHERE environment_id=$1 ORDER BY is_system DESC, key`, [envId]);
}

export async function runtimeEnv(envId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const v of await listVars(envId)) out[v.key] = v.is_secret ? decrypt(v.value_enc) : v.value ?? '';
  return out;
}

export async function upsertVar(envId: string, key: string, value: string, isSecret: boolean, isSystem = false) {
  await q(
    `INSERT INTO environment_variables (environment_id, key, value, value_enc, is_secret, is_system)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (environment_id, key) DO UPDATE SET value=EXCLUDED.value, value_enc=EXCLUDED.value_enc,
       is_secret=EXCLUDED.is_secret, is_system=EXCLUDED.is_system, updated_at=now()`,
    [envId, key, isSecret ? null : value, isSecret ? encrypt(value) : null, isSecret, isSystem],
  );
}

/** Snapshot cifrado de las variables (se guarda con cada versión). */
export async function envSnapshot(envId: string): Promise<string> {
  return encrypt(JSON.stringify(await runtimeEnv(envId)));
}

// ───────── puertos ─────────

export async function hostPortsInUse(): Promise<Map<number, string>> {
  const used = new Map<number, string>();
  try {
    const list = await dockerSvc.docker.listContainers({ all: false });
    for (const c of list) for (const p of c.Ports || []) if (p.PublicPort) used.set(p.PublicPort, c.Names?.[0]?.replace(/^\//, '') ?? c.Id);
  } catch { /* docker no disponible */ }
  return used;
}

/**
 * Verifica que un puerto externo no esté asignado a otro ambiente ni usado por otro contenedor.
 * Con `revealOwner = false` el error no nombra la app ni el contenedor que lo ocupa: es para usuarios
 * limitados a sus apps asignadas (no deben enterarse de que existen otras) y para el log de deploy, que lee cualquiera con acceso a la app.
 */
export async function assertPortFree(port: number, envId?: string | null, ownContainer?: string, revealOwner = true) {
  const reserved = [22, 80, 443, Number(process.env.PLATFORM_HTTP_PORT || 0), Number(process.env.TRAEFIK_DASHBOARD_PORT || 0)].filter(Boolean);
  if (reserved.includes(port)) throw conflict(`El puerto ${port} está reservado por la plataforma`);
  const other = await one(`SELECT e.name, a.name AS app FROM application_environments e JOIN applications a ON a.id=e.application_id
                           WHERE e.external_port=$1 AND ($2::uuid IS NULL OR e.id <> $2)`, [port, envId ?? null]);
  if (other) throw conflict(revealOwner ? `El puerto ${port} ya está asignado a ${other.app} (${other.name})` : `El puerto ${port} ya está asignado a otra aplicación`);
  const used = await hostPortsInUse();
  const by = used.get(port);
  if (by && by !== ownContainer) throw conflict(revealOwner ? `El puerto ${port} está en uso por el contenedor ${by}` : `El puerto ${port} ya está en uso en el servidor`);
}

/** Verifica que la ruta de publicación (ya normalizada) no la use otro ambiente. */
export async function assertPathFree(pathPrefix: string, envId: string | null) {
  const other = await one(`SELECT 1 FROM application_environments WHERE lower(path_prefix)=lower($1) AND ($2::uuid IS NULL OR id <> $2)`,
    [pathPrefix, envId]);
  if (other) throw conflict(`La ruta ${pathPrefix} ya está asignada a otra aplicación`);
}

/**
 * Ruta que se propone a un ambiente que no indicó ninguna: "/<app>" y, si ya está usada (otro ambiente de la misma app)
 * o es de AppHub, "/<app>-<ambiente>", "/<app>-2", "/<app>-3"…
 */
export async function defaultAppPath(slug: string, envName: string): Promise<string> {
  const base = slug.slice(0, 50);
  const candidates = [base, `${base}-${envName}`.slice(0, 63), ...Array.from({ length: 50 }, (_, i) => `${base}-${i + 2}`)];
  for (const c of candidates) {
    if ((RESERVED_PATHS as readonly string[]).includes(c)) continue;
    if (!(await one(`SELECT 1 FROM application_environments WHERE lower(path_prefix)=lower($1)`, [`/${c}`]))) return `/${c}`;
  }
  throw conflict('No se pudo proponer una ruta libre: indique una');
}

export async function nextFreePort(): Promise<number> {
  const taken = new Set((await q(`SELECT external_port FROM application_environments WHERE external_port IS NOT NULL`)).map((r) => r.external_port));
  const used = await hostPortsInUse();
  for (let p = config.portRangeStart; p <= config.portRangeEnd; p++) if (!taken.has(p) && !used.has(p)) return p;
  throw conflict('No hay puertos libres en el rango configurado');
}

// ───────── archivos del ambiente ─────────

export async function databaseFor(envId: string) {
  return one(`SELECT * FROM databases WHERE environment_id=$1`, [envId]);
}

/** Escribe docker-compose.yml, .env y db.env del ambiente para la imagen indicada. */
export async function writeEnvFiles(app: AppRow, env: EnvRow, image: string): Promise<string> {
  const dir = paths.envDir(app.slug, env.name);
  fs.mkdirSync(dir, { recursive: true });
  const db = await databaseFor(env.id);
  const compose = generateCompose({
    slug: app.slug, env: env.name, image,
    internalPort: env.internal_port || app.internal_port,
    externalPort: env.external_port, extraPorts: env.extra_ports, domain: env.domain, httpsEnabled: env.https_enabled,
    pathPrefix: env.path_prefix,
    volumes: (env.volumes || []).map((v) => {
      if (v.type !== 'bind') return v;
      // Los bind mounts quedan confinados a DATA_DIR/applications/<slug>/data/<ruta>
      const src = path.join(paths.app(app.slug), 'data', v.source.replace(/^\/+/, '').replace(/\.\./g, ''));
      fs.mkdirSync(src, { recursive: true });
      return { ...v, source: src };
    }),
    memoryLimitMb: env.memory_limit_mb, cpuLimit: env.cpu_limit ? Number(env.cpu_limit) : null,
    replicas: env.replicas,
    database: db ? { engine: db.engine, version: db.engine_version, databaseName: db.database_name } : null,
  });
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), compose);
  const vars = await runtimeEnv(env.id);
  const envText = Object.entries(vars).map(([k, v]) => toDotenvLine(k, v)).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, '.env'), envText, { mode: 0o600 });
  if (db) {
    const owner = await one(`SELECT * FROM database_credentials WHERE database_id=$1 AND is_owner`, [db.id]);
    const dbEnv = [
      toDotenvLine('POSTGRES_DB', db.database_name),
      toDotenvLine('POSTGRES_USER', owner?.username ?? 'app'),
      toDotenvLine('POSTGRES_PASSWORD', owner ? decrypt(owner.password_enc) : ''),
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'db.env'), dbEnv, { mode: 0o600 });
  } else if (fs.existsSync(path.join(dir, 'db.env'))) {
    fs.rmSync(path.join(dir, 'db.env'));
  }
  return dir;
}

export function envFilesExist(slug: string, envName: string) {
  return fs.existsSync(path.join(paths.envDir(slug, envName), 'docker-compose.yml'));
}

export const envProject = (app: AppRow, env: EnvRow) => projectName(app.slug, env.name);

export async function currentImageFor(app: AppRow, env: EnvRow): Promise<string | null> {
  if (!env.deployed_version_id) return null;
  const v = await one(`SELECT version FROM application_versions WHERE id=$1`, [env.deployed_version_id]);
  return v ? imageTag(app.slug, v.version) : null;
}

export function appUrl(env: Pick<EnvRow, 'domain' | 'https_enabled' | 'path_prefix' | 'external_port'>): string | null {
  if (env.path_prefix) {
    const base = env.domain ? `${env.https_enabled ? 'https' : 'http'}://${env.domain}` : config.appsPathBaseUrl;
    return `${base}${env.path_prefix}/`;
  }
  if (env.domain) return `${env.https_enabled ? 'https' : 'http'}://${env.domain}`;
  if (env.external_port) return `http://${config.publicHost}:${env.external_port}`;
  return null;
}
