import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { paths } from '../config';
import { one, q } from '../db/pool';
import { ah, badRequest, conflict, notFound, parse } from '../lib/http';
import { rmrf, safeJoin, VERSION_RE } from '../lib/util';
import { assertDeployPerm, can, requirePerm } from '../middleware/auth';
import {
  analyzeDir, cloneApplication, createApplication, createVersion, proposeDockerfile, stageFromGit, stagingPath,
} from '../services/apps';
import { audit } from '../services/audit';
import { appUrl, getApp, getEnv, getVersion } from '../services/core';
import { detect, TECHNOLOGIES } from '../services/detector';
import { enqueueDeploy, teardown } from '../services/deploy';
import * as dk from '../services/docker';
import { createStaging, extractZip, listTree, placeUploadedFiles } from '../services/storage';
import { generateDockerfile } from '../services/templates';
import { boolish, cleanupFiles, upload } from './_helpers';

const r = Router();

const ENV_NAME = z.enum(['development', 'test', 'staging', 'production']);
const VOLUME = z.object({ source: z.string().min(1).max(200), target: z.string().min(1).max(255), type: z.enum(['volume', 'bind']), readOnly: z.boolean().optional() });
const VAR = z.object({ key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), value: z.string().max(20000), isSecret: z.boolean().optional() });
const BUILD_CONFIG = z.record(z.any()).optional();
const GIT = z.object({
  url: z.string().min(4).max(500),
  provider: z.string().optional(),
  authType: z.enum(['none', 'token', 'basic', 'ssh']).default('none'),
  username: z.string().max(120).optional().nullable(),
  credential: z.string().max(20000).optional().nullable(),
  branch: z.string().max(200).optional().nullable(),
  tag: z.string().max(200).optional().nullable(),
  commit: z.string().max(64).optional().nullable(),
  subdirectory: z.string().max(255).optional().nullable().transform((v) => v ?? undefined),
  autoDeployEnvironment: ENV_NAME.optional().nullable().transform((v) => v ?? undefined),
});
const PORT = z.coerce.number().int().min(1).max(65535);

// ───────── listado / detalle ─────────

async function envSummaries(appIds: string[], withStats: boolean) {
  if (!appIds.length) return new Map<string, any[]>();
  const envs = await q(
    `SELECT e.*, v.version AS deployed_version, d.id AS database_id, d.engine AS database_engine, d.status AS database_status
       FROM application_environments e
       LEFT JOIN application_versions v ON v.id = e.deployed_version_id
       LEFT JOIN databases d ON d.environment_id = e.id
      WHERE e.application_id = ANY($1) ORDER BY e.is_default DESC, e.name`, [appIds]);
  const slugs = new Map((await q(`SELECT id, slug FROM applications WHERE id = ANY($1)`, [appIds])).map((a) => [a.id, a.slug]));
  await Promise.all(envs.map(async (e) => {
    e.url = appUrl(e);
    if (withStats && e.status === 'running') e.stats = await dk.containerStats(`ema-${slugs.get(e.application_id)}-${e.name}`);
  }));
  const map = new Map<string, any[]>();
  for (const e of envs) map.set(e.application_id, [...(map.get(e.application_id) ?? []), e]);
  return map;
}

r.get('/applications', requirePerm('apps.view'), ah(async (req, res) => {
  const { status, search } = req.query as Record<string, string>;
  const apps = await q(
    `SELECT a.*, u.full_name AS author_name, v.version AS current_version, rp.url AS repository_url,
            (SELECT count(*)::int FROM application_versions x WHERE x.application_id=a.id) AS versions_count
       FROM applications a
       LEFT JOIN users u ON u.id=a.author_id
       LEFT JOIN application_versions v ON v.id=a.current_version_id
       LEFT JOIN repositories rp ON rp.application_id=a.id
      WHERE ($1::text IS NULL OR a.name ILIKE '%'||$1||'%' OR a.slug ILIKE '%'||$1||'%' OR a.technology ILIKE '%'||$1||'%')
      ORDER BY a.name`, [search || null]);
  const envs = await envSummaries(apps.map((a) => a.id), boolish(req.query.stats));
  let out = apps.map((a) => {
    const list = envs.get(a.id) ?? [];
    const main = list.find((e) => e.is_default) ?? list[0];
    const state = !main ? 'not_deployed' : main.status === 'running' && main.health_status === 'unhealthy' ? 'error' : main.status;
    return { ...a, technology_label: TECHNOLOGIES[a.technology]?.label ?? a.technology, environments: list, main_environment: main, state };
  });
  if (status) out = out.filter((a) => (status === 'stopped' ? ['stopped', 'not_deployed'].includes(a.state) : a.state === status));
  res.json(out);
}));

r.get('/applications/technologies', requirePerm('apps.view'), (_req, res) => {
  res.json(Object.entries(TECHNOLOGIES).map(([id, t]) => ({ id, ...t })));
});

r.get('/applications/:id', requirePerm('apps.view'), ah(async (req, res) => {
  const app = await getApp(req.params.id);
  const [envs, author, repo, version, registry] = await Promise.all([
    envSummaries([app.id], false).then((m) => m.get(app.id) ?? []),
    one(`SELECT id, full_name, username FROM users WHERE id=$1`, [app.author_id]),
    one(`SELECT id, provider, url, auth_type, username, branch, tag, commit_sha, subdirectory, auto_deploy_environment, last_commit, last_sync_at,
                (credential_enc IS NOT NULL) AS has_credential FROM repositories WHERE application_id=$1`, [app.id]),
    app.current_version_id ? one(`SELECT id, version, created_at FROM application_versions WHERE id=$1`, [app.current_version_id]) : null,
    app.registry_id ? one(`SELECT id, name, url FROM docker_registries WHERE id=$1`, [app.registry_id]) : null,
  ]);
  for (const e of envs) e.container = await dk.containerState(`ema-${app.slug}-${e.name}`);
  res.json({ ...app, technology_label: TECHNOLOGIES[app.technology]?.label ?? app.technology, environments: envs, author, repository: repo,
    current_version: version, registry, webhook_url: repo ? `/api/webhooks/git/${app.id}` : null,
    webhook_secret: repo && can(req.user, 'git.manage') ? (await one(`SELECT webhook_secret FROM repositories WHERE application_id=$1`, [app.id]))?.webhook_secret : undefined });
}));

// ───────── análisis (ZIP / archivos / Git) ─────────

r.post('/applications/analyze', requirePerm('apps.create', 'versions.create'),
  upload.fields([{ name: 'file', maxCount: 1 }, { name: 'files', maxCount: 20000 }]),
  ah(async (req, res) => {
    const files = req.files as { [k: string]: Express.Multer.File[] } | undefined;
    const method = req.body.method as string;
    try {
      if (method === 'zip') {
        const f = files?.file?.[0];
        if (!f) throw badRequest('Seleccione un archivo .zip');
        if (!/\.zip$/i.test(f.originalname)) throw badRequest('El archivo debe tener extensión .zip');
        const dir = createStaging('zip');
        try { extractZip(f.path, path.join(dir, 'source')); } catch (e) { rmrf(dir); throw e; }
        return res.json(analyzeDir(dir));
      }
      if (method === 'files') {
        const list = files?.files ?? [];
        if (!list.length) throw badRequest('Seleccione archivos o una carpeta');
        const rel = ([] as string[]).concat(req.body.paths ?? []);
        const dir = createStaging('files');
        try { placeUploadedFiles(list, rel, path.join(dir, 'source')); } catch (e) { rmrf(dir); throw e; }
        return res.json(analyzeDir(dir));
      }
      if (method === 'git') {
        const g = parse(GIT, typeof req.body.git === 'string' ? JSON.parse(req.body.git) : req.body.git ?? req.body);
        const { dir, sha } = await stageFromGit(g);
        if (g.subdirectory) {
          const sub = safeJoin(path.join(dir, 'source'), g.subdirectory);
          if (!fs.existsSync(sub)) { rmrf(dir); throw badRequest('El subdirectorio no existe en el repositorio'); }
          const tmp = `${dir}/__sub`;
          fs.renameSync(sub, tmp);
          rmrf(path.join(dir, 'source'));
          fs.renameSync(tmp, path.join(dir, 'source'));
        }
        return res.json(analyzeDir(dir, sha));
      }
      throw badRequest('Método de carga inválido (zip | files | git)');
    } finally {
      cleanupFiles(files);
    }
  }));

/** Regenera el Dockerfile propuesto para otra tecnología / configuración. */
r.post('/applications/dockerfile/preview', requirePerm('apps.create', 'versions.create', 'apps.edit'), ah(async (req, res) => {
  const b = parse(z.object({ technology: z.string(), internalPort: PORT, buildConfig: BUILD_CONFIG, stagingId: z.string().optional() }), req.body);
  let bc = b.buildConfig ?? {};
  if (b.stagingId) {
    const d = detect(path.join(stagingPath(b.stagingId), 'source'));
    if (d.technology === b.technology) bc = { ...d.buildConfig, ...bc };
  }
  res.json({ dockerfile: generateDockerfile(b.technology, bc, b.internalPort) });
}));

// ───────── creación ─────────

const CREATE = z.object({
  name: z.string().min(2).max(120),
  slug: z.string().max(50).optional(),
  description: z.string().max(2000).optional(),
  technology: z.string().min(2).max(40),
  detectedTechnology: z.string().optional(),
  frameworkLabel: z.string().optional(),
  internalPort: PORT,
  healthcheckPath: z.string().max(200).optional(),
  buildConfig: BUILD_CONFIG,
  dockerfile: z.string().max(200000).optional(),
  stagingId: z.string().optional(),
  version: z.string().regex(VERSION_RE).optional(),
  comment: z.string().max(1000).optional(),
  sourceType: z.enum(['zip', 'git', 'upload']).optional(),
  repository: GIT.optional(),
  environment: z.object({
    name: ENV_NAME.default('production'),
    externalPort: PORT.nullable().optional(),
    internalPort: PORT.nullable().optional(),
    domain: z.string().max(255).regex(/^[a-z0-9.-]*$/i).nullable().optional(),
    httpsEnabled: z.boolean().optional(),
    volumes: z.array(VOLUME).max(20).optional(),
    variables: z.array(VAR).max(300).optional(),
    memoryLimitMb: z.number().int().positive().nullable().optional(),
    cpuLimit: z.number().positive().nullable().optional(),
  }),
  createDatabase: z.boolean().optional(),
  database: z.object({ databaseName: z.string().optional(), username: z.string().optional(), version: z.string().optional() }).optional(),
  deploy: z.boolean().optional(),
  registryId: z.string().uuid().nullable().optional(),
});

r.post('/applications', requirePerm('apps.create'), ah(async (req, res) => {
  const body = parse(CREATE, req.body);
  if (body.deploy) assertDeployPerm(req.user, body.environment.name);
  if (body.createDatabase && !can(req.user, 'db.manage') && !can(req.user, 'apps.create')) throw badRequest('Sin permiso para crear bases');
  const result = await createApplication(body as any, req.user!);
  await audit(req, { action: 'app_create', entityType: 'application', entityId: result.application.id, app: result.application,
    details: { technology: body.technology, source: body.sourceType, environment: body.environment.name, database: !!body.createDatabase } });
  res.status(201).json(result);
}));

r.put('/applications/:id', requirePerm('apps.edit'), ah(async (req, res) => {
  const app = await getApp(req.params.id);
  const b = parse(z.object({
    name: z.string().min(2).max(120).optional(), description: z.string().max(2000).nullable().optional(),
    technology: z.string().max(40).optional(), internalPort: PORT.optional(), healthcheckPath: z.string().max(200).optional(),
    buildConfig: BUILD_CONFIG, registryId: z.string().uuid().nullable().optional(),
  }), req.body);
  await q(`UPDATE applications SET name=COALESCE($2,name), description=CASE WHEN $3::boolean THEN $4 ELSE description END,
             technology=COALESCE($5,technology), internal_port=COALESCE($6,internal_port), healthcheck_path=COALESCE($7,healthcheck_path),
             build_config=COALESCE($8,build_config), registry_id=CASE WHEN $9::boolean THEN $10::uuid ELSE registry_id END, updated_at=now()
           WHERE id=$1`,
    [app.id, b.name ?? null, b.description !== undefined, b.description ?? null, b.technology ?? null, b.internalPort ?? null,
     b.healthcheckPath ?? null, b.buildConfig ? JSON.stringify(b.buildConfig) : null, b.registryId !== undefined, b.registryId ?? null]);
  await audit(req, { action: 'app_update', entityType: 'application', entityId: app.id, app, details: b });
  res.json(await getApp(app.id));
}));

r.delete('/applications/:id', requirePerm('apps.delete'), ah(async (req, res) => {
  const app = await getApp(req.params.id);
  const purge = boolish(req.query.purge);
  const envs = await q(`SELECT * FROM application_environments WHERE application_id=$1`, [app.id]);
  for (const e of envs) await teardown(app, e, purge);
  // Se audita ANTES de borrar: audit_logs.application_id apunta a applications y, con la app ya borrada,
  // el registro se rechazaba (la FK pone application_id en NULL al borrar; el nombre queda en application_name).
  await audit(req, { action: 'app_delete', entityType: 'application', entityId: app.id, app, details: { purge } });
  await q(`DELETE FROM applications WHERE id=$1`, [app.id]);
  if (purge) rmrf(paths.app(app.slug));
  res.json({ ok: true });
}));

// ───────── nueva versión por carga ─────────

r.post('/applications/:id/upload', requirePerm('versions.create'),
  upload.fields([{ name: 'file', maxCount: 1 }, { name: 'files', maxCount: 20000 }]),
  ah(async (req, res) => {
    const files = req.files as { [k: string]: Express.Multer.File[] } | undefined;
    try {
      const app = await getApp(req.params.id);
      const dir = createStaging(files?.file?.length ? 'zip' : 'files');
      const src = path.join(dir, 'source');
      try {
        if (files?.file?.[0]) extractZip(files.file[0].path, src);
        else if (files?.files?.length) placeUploadedFiles(files.files, ([] as string[]).concat(req.body.paths ?? []), src);
        else throw badRequest('Adjunte un ZIP o archivos');
      } catch (e) { rmrf(dir); throw e; }
      const env = req.body.environment ? await getEnv(app.id, req.body.environment) : await getEnv(app.id);
      const regenerate = boolish(req.body.regenerateDockerfile);
      const dockerfile = regenerate ? proposeDockerfile(src, detect(src)) : undefined;
      const v = await createVersion(app, src, {
        version: req.body.version || undefined, comment: req.body.comment, dockerfile, sourceType: files?.file?.length ? 'zip' : 'upload',
        envIdForSnapshot: env.id,
      }, req.user!.id);
      rmrf(dir);
      await audit(req, { action: 'version_create', entityType: 'version', entityId: v.id, app, details: { version: v.version, source: v.source_type } });
      let deployment = null;
      if (boolish(req.body.deploy)) {
        assertDeployPerm(req.user, env.name);
        deployment = await enqueueDeploy({ appId: app.id, envId: env.id, versionId: v.id, userId: req.user!.id, username: req.user!.username });
      }
      res.status(201).json({ version: v, deployment });
    } finally {
      cleanupFiles(files);
    }
  }));

// ───────── versiones ─────────

r.get('/applications/:id/versions', requirePerm('apps.view'), ah(async (req, res) => {
  const app = await getApp(req.params.id);
  res.json(await q(
    `SELECT v.id, v.version, v.source_type, v.technology, v.commit_sha, v.comment, v.size_bytes, v.created_at, u.full_name AS created_by_name,
            (SELECT array_agg(e.name) FROM application_environments e WHERE e.deployed_version_id = v.id) AS deployed_in,
            EXISTS (SELECT 1 FROM docker_images i WHERE i.version_id=v.id) AS has_image
       FROM application_versions v LEFT JOIN users u ON u.id=v.created_by
      WHERE v.application_id=$1 ORDER BY v.created_at DESC`, [app.id]));
}));

r.get('/applications/:id/versions/:vid', requirePerm('apps.view'), ah(async (req, res) => {
  const app = await getApp(req.params.id);
  const v = await getVersion(app.id, req.params.vid);
  const { env_snapshot_enc: _s, ...rest } = v;
  res.json({ ...rest, tree: listTree(v.source_path, 1500) });
}));

/** Nueva versión a partir de otra (ej. sólo cambia el Dockerfile). */
r.post('/applications/:id/versions', requirePerm('versions.create'), ah(async (req, res) => {
  const app = await getApp(req.params.id);
  const b = parse(z.object({ fromVersionId: z.string().uuid(), version: z.string().regex(VERSION_RE).optional(), comment: z.string().max(1000).optional(),
    dockerfile: z.string().max(200000).optional() }), req.body);
  const from = await getVersion(app.id, b.fromVersionId);
  const dir = createStaging('zip');
  fs.cpSync(from.source_path, path.join(dir, 'source'), { recursive: true });
  const v = await createVersion(app, path.join(dir, 'source'), {
    version: b.version, comment: b.comment ?? `Basada en ${from.version}`, dockerfile: b.dockerfile ?? from.dockerfile,
    sourceType: 'edit', commitSha: from.commit_sha, buildConfig: from.build_config,
  }, req.user!.id);
  rmrf(dir);
  await audit(req, { action: 'version_create', entityType: 'version', entityId: v.id, app, details: { version: v.version, from: from.version } });
  res.status(201).json(v);
}));

r.put('/applications/:id/versions/:vid/dockerfile', requirePerm('versions.create'), ah(async (req, res) => {
  const app = await getApp(req.params.id);
  const v = await getVersion(app.id, req.params.vid);
  const { dockerfile } = parse(z.object({ dockerfile: z.string().min(10).max(200000) }), req.body);
  await q(`UPDATE application_versions SET dockerfile=$2, build_config = build_config || '{"dirty":true}'::jsonb WHERE id=$1`, [v.id, dockerfile]);
  await audit(req, { action: 'dockerfile_update', entityType: 'version', entityId: v.id, app, details: { version: v.version } });
  res.json({ ok: true });
}));

r.get('/applications/:id/versions/:vid/file', requirePerm('apps.view'), ah(async (req, res) => {
  const app = await getApp(req.params.id);
  const v = await getVersion(app.id, req.params.vid);
  const file = safeJoin(v.source_path, String(req.query.path || ''));
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw notFound('Archivo no encontrado');
  if (fs.statSync(file).size > 1024 * 1024) throw badRequest('Archivo demasiado grande para el editor (máx. 1 MB)');
  const buf = fs.readFileSync(file);
  if (buf.includes(0)) throw badRequest('Archivo binario: no se puede editar');
  res.json({ path: req.query.path, content: buf.toString('utf8') });
}));

r.put('/applications/:id/versions/:vid/file', requirePerm('versions.create'), ah(async (req, res) => {
  const app = await getApp(req.params.id);
  const v = await getVersion(app.id, req.params.vid);
  const b = parse(z.object({ path: z.string().min(1).max(500), content: z.string().max(1024 * 1024) }), req.body);
  const file = safeJoin(v.source_path, b.path);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, b.content);
  if (b.path === 'Dockerfile') await q(`UPDATE application_versions SET dockerfile=$2 WHERE id=$1`, [v.id, b.content]);
  await q(`UPDATE application_versions SET build_config = build_config || '{"dirty":true}'::jsonb WHERE id=$1`, [v.id]);
  await audit(req, { action: 'file_edit', entityType: 'version', entityId: v.id, app, details: { version: v.version, path: b.path } });
  res.json({ ok: true });
}));

r.delete('/applications/:id/versions/:vid', requirePerm('apps.edit'), ah(async (req, res) => {
  const app = await getApp(req.params.id);
  const v = await getVersion(app.id, req.params.vid);
  if (await one(`SELECT 1 FROM application_environments WHERE deployed_version_id=$1`, [v.id])) throw conflict('La versión está desplegada en un ambiente');
  await q(`DELETE FROM application_versions WHERE id=$1`, [v.id]);
  rmrf(path.dirname(v.source_path));
  await audit(req, { action: 'version_delete', entityType: 'version', entityId: v.id, app, details: { version: v.version } });
  res.json({ ok: true });
}));

// ───────── clonación ─────────

r.post('/applications/:id/clone', requirePerm('apps.create'), ah(async (req, res) => {
  const app = await getApp(req.params.id);
  const b = parse(z.object({
    name: z.string().min(2).max(120), slug: z.string().max(50).optional(), sourceEnvironment: ENV_NAME.optional(),
    targetEnvironment: ENV_NAME.optional(), copyVariables: z.boolean().optional(), createDatabase: z.boolean().optional(), deploy: z.boolean().optional(),
  }), req.body);
  if (b.deploy) assertDeployPerm(req.user, b.targetEnvironment ?? 'development');
  const result = await cloneApplication(app, b, req.user!);
  await audit(req, { action: 'app_clone', entityType: 'application', entityId: result.application.id, app: result.application, details: { from: app.name } });
  res.status(201).json(result);
}));

export default r;
