import fs from 'fs';
import path from 'path';
import { paths } from '../config';
import { one, q } from '../db/pool';
import { decrypt, encrypt } from '../lib/crypto';
import { badRequest, conflict, notFound } from '../lib/http';
import { bumpPatch, dirSize, rmrf, safeJoin, slugify, VERSION_RE } from '../lib/util';
import { AppRow, EnvRow, assertPortFree, envSnapshot, getApp, nextFreePort, runtimeEnv, upsertVar } from './core';
import { createDatabase } from './database';
import { BuildConfig, detect, Detection, existingDockerfile, exposedPort } from './detector';
import { enqueueDeploy } from './deploy';
import { fetchSource, GitSource, detectProvider } from './git';
import { createStaging, listTree, moveDir } from './storage';
import { generateDockerfile } from './templates';

const STAGING_RE = /^(zip|files|git)-\d+-[0-9a-f]{8}$/;

export interface AnalyzeResult {
  stagingId: string;
  detection: Detection;
  dockerfile: string;
  tree: { path: string; type: string; size?: number }[];
  commitSha?: string;
  sizeBytes: number;
}

export function stagingPath(id: string) {
  if (!STAGING_RE.test(id)) throw badRequest('Identificador de carga inválido');
  const p = path.join(paths.uploads(), id);
  if (!fs.existsSync(p)) throw notFound('La carga expiró o no existe; vuelva a subir el código');
  return p;
}

export function proposeDockerfile(src: string, d: Detection): string {
  const own = existingDockerfile(src);
  if (own) return own;
  return generateDockerfile(d.technology, d.buildConfig, d.internalPort);
}

export function analyzeDir(stagingDir: string, commitSha?: string): AnalyzeResult {
  const src = path.join(stagingDir, 'source');
  const detection = detect(src);
  const own = existingDockerfile(src);
  if (own) {
    const p = exposedPort(own);
    if (p) detection.internalPort = p;
    detection.warnings.push('Se encontró un Dockerfile en el proyecto: se usará como base (puede editarlo).');
  }
  if (commitSha) fs.writeFileSync(path.join(stagingDir, 'commit'), commitSha);
  return {
    stagingId: path.basename(stagingDir), detection, dockerfile: proposeDockerfile(src, detection),
    tree: listTree(src, 300), commitSha, sizeBytes: dirSize(src),
  };
}

export async function stageFromGit(g: GitSource, onLine?: (l: string) => void) {
  const dir = createStaging('git');
  try {
    const sha = await fetchSource(g, path.join(dir, 'source'), onLine);
    return { dir, sha };
  } catch (e) {
    rmrf(dir);
    throw e;
  }
}

// ───────── versiones ─────────

export interface NewVersionInput {
  version?: string;
  comment?: string;
  dockerfile?: string;
  technology?: string;
  buildConfig?: BuildConfig & { runTests?: boolean };
  sourceType: 'zip' | 'git' | 'upload' | 'clone' | 'edit';
  commitSha?: string | null;
  envIdForSnapshot?: string | null;
}

export async function nextVersion(appId: string): Promise<string> {
  const last = await one(`SELECT version FROM application_versions WHERE application_id=$1 ORDER BY created_at DESC LIMIT 1`, [appId]);
  return bumpPatch(last?.version);
}

/** Mueve el código (directorio fuente) a su ubicación definitiva y registra la versión. */
export async function createVersion(app: AppRow, sourceDir: string, input: NewVersionInput, userId: string | null) {
  const version = (input.version || (await nextVersion(app.id))).replace(/^v/, '');
  if (!VERSION_RE.test(version)) throw badRequest('Versión inválida (ej: 1.2.0)');
  if (await one(`SELECT 1 FROM application_versions WHERE application_id=$1 AND version=$2`, [app.id, version])) {
    throw conflict(`La versión ${version} ya existe`);
  }
  const target = paths.versionSource(app.slug, version);
  moveDir(sourceDir, target);
  let dockerfile = input.dockerfile;
  if (!dockerfile) {
    const prev = await one(`SELECT dockerfile FROM application_versions WHERE application_id=$1 ORDER BY created_at DESC LIMIT 1`, [app.id]);
    dockerfile = existingDockerfile(target) ?? prev?.dockerfile ?? generateDockerfile(app.technology, { ...app.build_config, ...input.buildConfig }, app.internal_port);
  }
  const snapshot = input.envIdForSnapshot ? await envSnapshot(input.envIdForSnapshot) : null;
  const v = await one(
    `INSERT INTO application_versions (application_id, version, source_type, source_path, dockerfile, technology, build_config,
       env_snapshot_enc, commit_sha, comment, size_bytes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [app.id, version, input.sourceType, target, dockerfile, input.technology ?? app.technology, input.buildConfig ?? {}, snapshot,
     input.commitSha ?? null, input.comment ?? null, dirSize(target), userId],
  );
  await q(`UPDATE applications SET updated_at=now(), current_version_id=COALESCE(current_version_id,$2) WHERE id=$1`, [app.id, v.id]);
  return v;
}

// ───────── creación de aplicación ─────────

export interface EnvInput {
  name: 'development' | 'test' | 'staging' | 'production';
  externalPort?: number | null;
  internalPort?: number | null;
  domain?: string | null;
  httpsEnabled?: boolean;
  volumes?: { source: string; target: string; type: 'volume' | 'bind'; readOnly?: boolean }[];
  variables?: { key: string; value: string; isSecret?: boolean }[];
  memoryLimitMb?: number | null;
  cpuLimit?: number | null;
}

export async function createEnvironment(app: AppRow, e: EnvInput, isDefault: boolean): Promise<EnvRow> {
  const port = e.externalPort === undefined ? await nextFreePort() : e.externalPort;
  if (port) await assertPortFree(port);
  for (const v of e.volumes ?? []) validateVolume(v);
  const env = await one<EnvRow>(
    `INSERT INTO application_environments (application_id, name, is_default, internal_port, external_port, domain, https_enabled, volumes, memory_limit_mb, cpu_limit)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [app.id, e.name, isDefault, e.internalPort ?? null, port ?? null, e.domain?.trim().toLowerCase() || null, e.httpsEnabled ?? true,
     JSON.stringify(e.volumes ?? []), e.memoryLimitMb ?? null, e.cpuLimit ?? null],
  );
  for (const v of e.variables ?? []) await upsertVar(env!.id, v.key, v.value, !!v.isSecret);
  return env!;
}

export function validateVolume(v: { source: string; target: string; type: string }) {
  if (!v.target.startsWith('/')) throw badRequest(`Ruta de destino de volumen inválida: ${v.target}`);
  if (v.type === 'volume' && !/^[a-z0-9][a-z0-9_.-]{0,60}$/.test(v.source)) throw badRequest(`Nombre de volumen inválido: ${v.source}`);
  if (v.type === 'bind') {
    // Los bind mounts sólo pueden apuntar dentro de DATA_DIR/applications/<slug>/data (evita montar el host)
    if (!/^[a-zA-Z0-9_./-]+$/.test(v.source) || v.source.includes('..')) throw badRequest(`Ruta de bind inválida: ${v.source}`);
  }
}

export interface CreateAppInput {
  name: string;
  slug?: string;
  description?: string;
  technology: string;
  detectedTechnology?: string;
  frameworkLabel?: string;
  internalPort: number;
  healthcheckPath?: string;
  buildConfig?: BuildConfig & { runTests?: boolean };
  dockerfile?: string;
  stagingId?: string;
  version?: string;
  comment?: string;
  sourceType?: 'zip' | 'git' | 'upload';
  repository?: GitSource & { subdirectory?: string; autoDeployEnvironment?: string };
  environment: EnvInput;
  createDatabase?: boolean;
  database?: { databaseName?: string; username?: string; version?: string };
  deploy?: boolean;
  registryId?: string | null;
}

export async function createApplication(input: CreateAppInput, user: { id: string; username: string }) {
  const slug = slugify(input.slug || input.name);
  if (slug.length < 3) throw badRequest('El identificador debe tener al menos 3 caracteres');
  if (await one(`SELECT 1 FROM applications WHERE slug=$1`, [slug])) throw conflict(`Ya existe una aplicación con identificador "${slug}"`);
  const staging = input.stagingId ? stagingPath(input.stagingId) : null;

  const app = (await one<AppRow>(
    `INSERT INTO applications (slug, name, description, technology, detected_technology, framework_label, internal_port, healthcheck_path,
       build_config, storage_path, author_id, registry_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [slug, input.name, input.description ?? null, input.technology, input.detectedTechnology ?? null, input.frameworkLabel ?? null,
     input.internalPort, input.healthcheckPath || '/', input.buildConfig ?? {}, paths.app(slug), user.id, input.registryId ?? null],
  ))!;
  fs.mkdirSync(paths.app(slug), { recursive: true });

  try {
    const env = await createEnvironment(app, input.environment, true);

    if (input.repository?.url) await saveRepository(app.id, input.repository);

    let versionId: string | null = null;
    if (staging) {
      const commit = fs.existsSync(path.join(staging, 'commit')) ? fs.readFileSync(path.join(staging, 'commit'), 'utf8').trim() : null;
      const v = await createVersion(app, path.join(staging, 'source'), {
        version: input.version || '1.0.0', comment: input.comment || 'Versión inicial', dockerfile: input.dockerfile,
        technology: input.technology, buildConfig: input.buildConfig, sourceType: input.sourceType ?? 'zip', commitSha: commit,
        envIdForSnapshot: env.id,
      }, user.id);
      versionId = v.id;
      rmrf(staging);
    }

    if (input.createDatabase) await createDatabase(app, env, input.database ?? {});

    let deployment = null;
    if (input.deploy && versionId) {
      deployment = await enqueueDeploy({ appId: app.id, envId: env.id, versionId, trigger: 'manual', userId: user.id, username: user.username });
    }
    return { application: await getApp(app.id), environment: env, deployment };
  } catch (e) {
    // deshacer la creación si algo falló antes del deploy
    await q(`DELETE FROM applications WHERE id=$1`, [app.id]);
    rmrf(paths.app(slug));
    throw e;
  }
}

export async function saveRepository(appId: string, r: GitSource & { subdirectory?: string; autoDeployEnvironment?: string }) {
  const existing = await one(`SELECT * FROM repositories WHERE application_id=$1`, [appId]);
  const credential = r.credential ? encrypt(r.credential) : existing?.credential_enc ?? null;
  await q(
    `INSERT INTO repositories (application_id, provider, url, auth_type, username, credential_enc, branch, tag, commit_sha, subdirectory, auto_deploy_environment)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (application_id) DO UPDATE SET provider=EXCLUDED.provider, url=EXCLUDED.url, auth_type=EXCLUDED.auth_type,
       username=EXCLUDED.username, credential_enc=EXCLUDED.credential_enc, branch=EXCLUDED.branch, tag=EXCLUDED.tag,
       commit_sha=EXCLUDED.commit_sha, subdirectory=EXCLUDED.subdirectory, auto_deploy_environment=EXCLUDED.auto_deploy_environment, updated_at=now()`,
    [appId, r.provider || detectProvider(r.url), r.url, r.authType ?? 'none', r.username ?? null,
     r.authType === 'none' ? null : credential, r.branch ?? null, r.tag ?? null, r.commit ?? null, r.subdirectory ?? null, r.autoDeployEnvironment ?? null],
  );
}

export async function repoSource(appId: string): Promise<(GitSource & { subdirectory?: string }) | null> {
  const r = await one(`SELECT * FROM repositories WHERE application_id=$1`, [appId]);
  if (!r) return null;
  return {
    url: r.url, provider: r.provider, authType: r.auth_type, username: r.username, credential: r.credential_enc ? decrypt(r.credential_enc) : null,
    branch: r.branch, tag: r.tag, commit: r.commit_sha, subdirectory: r.subdirectory,
  };
}

/** Actualizar desde Git: pull → nueva versión → (opcional) build + test + deploy + health check. */
export async function updateFromGit(app: AppRow, env: EnvRow | null, user: { id: string | null; username: string }, opts: { version?: string; comment?: string; deploy?: boolean; trigger?: 'git' | 'webhook' }) {
  const src = await repoSource(app.id);
  if (!src) throw badRequest('La aplicación no tiene repositorio Git configurado');
  const { dir, sha } = await stageFromGit(src);
  try {
    const last = await one(`SELECT commit_sha FROM application_versions WHERE application_id=$1 ORDER BY created_at DESC LIMIT 1`, [app.id]);
    let source = path.join(dir, 'source');
    if (src.subdirectory) {
      // safeJoin rechaza rutas que salgan de source/ (incluida una carpeta hermana como "source-otra")
      source = safeJoin(source, src.subdirectory.replace(/^\/+/, ''));
      if (!fs.existsSync(source)) throw badRequest('Subdirectorio inexistente en el repositorio');
    }
    const v = await createVersion(app, source, {
      version: opts.version, comment: opts.comment || `Git ${src.branch || src.tag || 'HEAD'} @ ${sha.slice(0, 8)}${last?.commit_sha === sha ? ' (sin cambios)' : ''}`,
      sourceType: 'git', commitSha: sha, envIdForSnapshot: env?.id,
    }, user.id);
    await q(`UPDATE repositories SET last_commit=$2, last_sync_at=now() WHERE application_id=$1`, [app.id, sha]);
    let deployment = null;
    if (opts.deploy && env) {
      deployment = await enqueueDeploy({ appId: app.id, envId: env.id, versionId: v.id, trigger: opts.trigger ?? 'git', userId: user.id, username: user.username });
    }
    return { version: v, deployment };
  } finally {
    rmrf(dir);
  }
}

// ───────── clonación ─────────

export interface CloneInput {
  name: string;
  slug?: string;
  sourceEnvironment?: string;
  targetEnvironment?: EnvInput['name'];
  copyVariables?: boolean;
  createDatabase?: boolean;
  deploy?: boolean;
}

export async function cloneApplication(src: AppRow, input: CloneInput, user: { id: string; username: string }) {
  const srcEnv = input.sourceEnvironment
    ? await one<EnvRow>(`SELECT * FROM application_environments WHERE application_id=$1 AND name=$2`, [src.id, input.sourceEnvironment])
    : await one<EnvRow>(`SELECT * FROM application_environments WHERE application_id=$1 ORDER BY is_default DESC LIMIT 1`, [src.id]);
  if (!srcEnv) throw notFound('Ambiente de origen no encontrado');
  const versionId = srcEnv.deployed_version_id ?? src.current_version_id;
  const srcVersion = versionId ? await one(`SELECT * FROM application_versions WHERE id=$1`, [versionId]) : null;

  const staging = createStaging('zip');
  if (srcVersion) fs.cpSync(srcVersion.source_path, path.join(staging, 'source'), { recursive: true });
  else fs.mkdirSync(path.join(staging, 'source'));

  const vars = input.copyVariables === false ? [] : Object.entries(await runtimeEnv(srcEnv.id))
    .filter(([k]) => !k.startsWith('DATABASE_'))
    .map(([key, value]) => ({ key, value, isSecret: /PASS|SECRET|TOKEN|KEY/i.test(key) }));

  const secretKeys = new Set((await q(`SELECT key FROM environment_variables WHERE environment_id=$1 AND is_secret`, [srcEnv.id])).map((r) => r.key));
  vars.forEach((v) => { if (secretKeys.has(v.key)) v.isSecret = true; });

  const res = await createApplication({
    name: input.name, slug: input.slug, description: `Clon de ${src.name}${src.description ? ' — ' + src.description : ''}`,
    technology: src.technology, internalPort: src.internal_port, healthcheckPath: src.healthcheck_path ?? '/',
    buildConfig: src.build_config, dockerfile: srcVersion?.dockerfile, stagingId: srcVersion ? path.basename(staging) : undefined,
    version: srcVersion?.version ?? '1.0.0', comment: `Clonado desde ${src.name} ${srcVersion?.version ?? ''}`.trim(),
    environment: { name: input.targetEnvironment ?? 'development', internalPort: srcEnv.internal_port, volumes: srcEnv.volumes, variables: vars },
    createDatabase: input.createDatabase, deploy: input.deploy && !!srcVersion, registryId: src.registry_id,
  }, user);
  if (!srcVersion) rmrf(staging);
  await q(`UPDATE applications SET cloned_from_id=$2 WHERE id=$1`, [res.application.id, src.id]);
  const repo = await repoSource(src.id);
  if (repo) await saveRepository(res.application.id, repo);
  return res;
}
