import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { paths } from '../config';
import { one, q } from '../db/pool';
import { decrypt, MASK } from '../lib/crypto';
import { ah, badRequest, conflict, notFound, parse } from '../lib/http';
import { parseDotenv, SECRET_KEY_RE, toDotenvLine } from '../lib/util';
import { assertDeployPerm, requirePerm } from '../middleware/auth';
import { createEnvironment, updateFromGit, validateVolume } from '../services/apps';
import { audit } from '../services/audit';
import {
  appUrl, assertPortFree, currentImageFor, envProject, getApp, getEnv, getVersion, imageTag, listVars, nextFreePort, upsertVar, writeEnvFiles,
} from '../services/core';
import { enqueueDeploy, lifecycle, teardown } from '../services/deploy';
import * as dk from '../services/docker';
import { checkEnv } from '../services/monitor';
import { generateCompose } from '../services/compose';
import { ctx } from './_helpers';

const r = Router();
const PORT = z.coerce.number().int().min(1).max(65535);
const ENV_NAME = z.enum(['development', 'test', 'staging', 'production']);

// ───────── deploy / rollback ─────────

r.post('/applications/:id/deploy', ah(async (req, res) => {
  const { app, env } = await ctx(req);
  assertDeployPerm(req.user, env.name);
  const b = parse(z.object({ versionId: z.string().uuid().optional(), forceRebuild: z.boolean().optional(), environment: z.string().optional() }), req.body);
  const versionId = b.versionId ?? app.current_version_id ??
    (await one(`SELECT id FROM application_versions WHERE application_id=$1 ORDER BY created_at DESC LIMIT 1`, [app.id]))?.id;
  if (!versionId) throw badRequest('La aplicación no tiene versiones. Suba código primero.');
  await getVersion(app.id, versionId);
  const dep = await enqueueDeploy({ appId: app.id, envId: env.id, versionId, trigger: 'manual', userId: req.user!.id, username: req.user!.username, forceRebuild: b.forceRebuild });
  await audit(req, { action: 'deploy_request', entityType: 'deployment', entityId: dep.id, app, details: { environment: env.name, versionId } });
  res.status(202).json(dep);
}));

r.post('/applications/:id/rollback', ah(async (req, res) => {
  const { app, env } = await ctx(req);
  assertDeployPerm(req.user, env.name);
  let versionId: string | undefined = req.body.versionId;
  if (!versionId) {
    const prev = await one(
      `SELECT version_id FROM deployments WHERE environment_id=$1 AND status='success' AND version_id IS DISTINCT FROM $2
        ORDER BY finished_at DESC LIMIT 1`, [env.id, env.deployed_version_id]);
    if (!prev) throw badRequest('No hay una versión anterior exitosa para volver');
    versionId = prev.version_id;
  }
  const v = await getVersion(app.id, versionId!);
  const dep = await enqueueDeploy({ appId: app.id, envId: env.id, versionId: v.id, trigger: 'rollback', userId: req.user!.id, username: req.user!.username, autoRollback: false });
  await audit(req, { action: 'rollback', entityType: 'deployment', entityId: dep.id, app, details: { environment: env.name, version: v.version } });
  res.status(202).json(dep);
}));

for (const action of ['start', 'stop', 'restart', 'recreate'] as const) {
  r.post(`/applications/:id/${action}`, requirePerm('apps.operate'), ah(async (req, res) => {
    const { app, env } = await ctx(req);
    if (env.name === 'production' && action !== 'restart') assertDeployPerm(req.user, 'production');
    try {
      await lifecycle(app, env, action);
      await audit(req, { action, entityType: 'environment', entityId: env.id, app, details: { environment: env.name } });
    } catch (e: any) {
      await audit(req, { action, entityType: 'environment', entityId: env.id, app, result: 'failure', details: { environment: env.name, error: e.message } });
      throw e;
    }
    res.json({ ok: true, status: action === 'stop' ? 'stopped' : 'running' });
  }));
}

// ───────── estado / logs / health ─────────

r.get('/applications/:id/status', requirePerm('apps.view'), ah(async (req, res) => {
  const { app, env } = await ctx(req);
  const name = envProject(app, env);
  const [appC, dbC] = await Promise.all([dk.containerState(name), dk.containerState(`${name}-db`)]);
  const [appS, dbS] = await Promise.all([appC?.running ? dk.containerStats(name) : null, dbC?.running ? dk.containerStats(`${name}-db`) : null]);
  const health = await q(`SELECT status, http_status, response_ms, error, checked_at FROM health_checks WHERE environment_id=$1 ORDER BY checked_at DESC LIMIT 30`, [env.id]);
  res.json({ environment: { ...env, url: appUrl(env) }, app: { container: appC, stats: appS }, db: dbC ? { container: dbC, stats: dbS } : null, health });
}));

r.get('/applications/:id/logs', requirePerm('apps.logs'), ah(async (req, res) => {
  const { app, env } = await ctx(req);
  const service = req.query.service === 'db' ? 'db' : 'app';
  const name = envProject(app, env) + (service === 'db' ? '-db' : '');
  const toEpoch = (v: unknown) => (v ? Math.floor(new Date(String(v)).getTime() / 1000) : undefined);
  const text = await dk.containerLogs(name, {
    tail: Math.min(Number(req.query.tail) || 2000, 50000), since: toEpoch(req.query.since), until: toEpoch(req.query.until), timestamps: true,
  });
  if (req.query.download) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.log"`);
    await audit(req, { action: 'logs_download', entityType: 'environment', entityId: env.id, app, details: { service } });
    return res.send(text);
  }
  res.json({ container: name, lines: text.split('\n').filter(Boolean) });
}));

r.post('/applications/:id/healthcheck', requirePerm('apps.view'), ah(async (req, res) => {
  const { app, env } = await ctx(req);
  res.json(await checkEnv(app, env));
}));

r.get('/applications/:id/deployments', requirePerm('apps.view'), ah(async (req, res) => {
  const app = await getApp(req.params.id);
  res.json(await q(
    `SELECT d.id, d.status, d.trigger, d.current_step, d.error, d.created_at, d.started_at, d.finished_at,
            e.name AS environment, v.version, pv.version AS previous_version, u.full_name AS user_name
       FROM deployments d JOIN application_environments e ON e.id=d.environment_id
       LEFT JOIN application_versions v ON v.id=d.version_id LEFT JOIN application_versions pv ON pv.id=d.previous_version_id
       LEFT JOIN users u ON u.id=d.created_by WHERE d.application_id=$1 ORDER BY d.created_at DESC LIMIT 200`, [app.id]));
}));

// ───────── ambientes ─────────

const ENV_UPDATE = z.object({
  externalPort: PORT.nullable().optional(),
  internalPort: PORT.nullable().optional(),
  domain: z.string().max(255).regex(/^[a-z0-9.-]*$/i).nullable().optional(),
  httpsEnabled: z.boolean().optional(),
  volumes: z.array(z.object({ source: z.string().min(1).max(200), target: z.string().min(1).max(255), type: z.enum(['volume', 'bind']), readOnly: z.boolean().optional() })).max(20).optional(),
  extraPorts: z.array(z.object({ internal: PORT, external: PORT, protocol: z.enum(['tcp', 'udp']).optional() })).max(10).optional(),
  memoryLimitMb: z.number().int().positive().nullable().optional(),
  cpuLimit: z.number().positive().max(64).nullable().optional(),
  isDefault: z.boolean().optional(),
});

r.get('/applications/:id/environments', requirePerm('apps.view'), ah(async (req, res) => {
  const app = await getApp(req.params.id);
  const envs = await q(`SELECT e.*, v.version AS deployed_version FROM application_environments e LEFT JOIN application_versions v ON v.id=e.deployed_version_id
                        WHERE e.application_id=$1 ORDER BY array_position(ARRAY['development','test','staging','production'], e.name::text)`, [app.id]);
  res.json(envs.map((e) => ({ ...e, url: appUrl(e) })));
}));

r.post('/applications/:id/environments', requirePerm('apps.edit'), ah(async (req, res) => {
  const app = await getApp(req.params.id);
  const b = parse(ENV_UPDATE.extend({ name: ENV_NAME, copyVariablesFrom: ENV_NAME.optional() }), req.body);
  if (await one(`SELECT 1 FROM application_environments WHERE application_id=$1 AND name=$2`, [app.id, b.name])) throw conflict('El ambiente ya existe');
  b.volumes?.forEach(validateVolume);
  const env = await createEnvironment(app, {
    name: b.name, externalPort: b.externalPort === undefined ? await nextFreePort() : b.externalPort, internalPort: b.internalPort,
    domain: b.domain, httpsEnabled: b.httpsEnabled, volumes: b.volumes, memoryLimitMb: b.memoryLimitMb, cpuLimit: b.cpuLimit,
  }, false);
  if (b.copyVariablesFrom) {
    const src = await getEnv(app.id, b.copyVariablesFrom);
    await q(`INSERT INTO environment_variables (environment_id, key, value, value_enc, is_secret)
             SELECT $1, key, value, value_enc, is_secret FROM environment_variables WHERE environment_id=$2 AND NOT is_system`, [env.id, src.id]);
  }
  await audit(req, { action: 'environment_create', entityType: 'environment', entityId: env.id, app, details: { environment: b.name } });
  res.status(201).json(env);
}));

r.put('/applications/:id/environments/:name', requirePerm('apps.edit'), ah(async (req, res) => {
  const app = await getApp(req.params.id);
  const env = await getEnv(app.id, req.params.name);
  const b = parse(ENV_UPDATE, req.body);
  if (b.externalPort) await assertPortFree(b.externalPort, env.id, envProject(app, env));
  for (const p of b.extraPorts ?? []) await assertPortFree(p.external, env.id, envProject(app, env));
  b.volumes?.forEach(validateVolume);
  if (b.domain) {
    const d = await one(`SELECT 1 FROM application_environments WHERE lower(domain)=lower($1) AND id<>$2`, [b.domain, env.id]);
    if (d) throw conflict('El dominio ya está asignado a otra aplicación');
  }
  if (b.isDefault) await q(`UPDATE application_environments SET is_default=false WHERE application_id=$1`, [app.id]);
  const map: Record<string, unknown> = {
    external_port: b.externalPort, internal_port: b.internalPort, domain: b.domain === undefined ? undefined : b.domain?.toLowerCase() || null,
    https_enabled: b.httpsEnabled, volumes: b.volumes && JSON.stringify(b.volumes), extra_ports: b.extraPorts && JSON.stringify(b.extraPorts),
    memory_limit_mb: b.memoryLimitMb, cpu_limit: b.cpuLimit, is_default: b.isDefault,
  };
  const sets: string[] = []; const vals: unknown[] = [env.id];
  for (const [k, v] of Object.entries(map)) if (v !== undefined) { vals.push(v); sets.push(`${k}=$${vals.length}`); }
  if (sets.length) await q(`UPDATE application_environments SET ${sets.join(', ')}, updated_at=now() WHERE id=$1`, vals);
  await audit(req, { action: 'environment_update', entityType: 'environment', entityId: env.id, app, details: { environment: env.name, ...b } });
  res.json({ ...(await getEnv(app.id, env.name)), restartRequired: !!env.deployed_version_id });
}));

r.delete('/applications/:id/environments/:name', requirePerm('apps.delete'), ah(async (req, res) => {
  const app = await getApp(req.params.id);
  const env = await getEnv(app.id, req.params.name);
  const count = await one(`SELECT count(*)::int AS n FROM application_environments WHERE application_id=$1`, [app.id]);
  if (count.n <= 1) throw badRequest('La aplicación debe tener al menos un ambiente');
  await teardown(app, env, true);
  await q(`DELETE FROM application_environments WHERE id=$1`, [env.id]);
  fs.rmSync(paths.envDir(app.slug, env.name), { recursive: true, force: true });
  if (env.is_default) await q(`UPDATE application_environments SET is_default=true WHERE id=(SELECT id FROM application_environments WHERE application_id=$1 LIMIT 1)`, [app.id]);
  await audit(req, { action: 'environment_delete', entityType: 'environment', entityId: env.id, app, details: { environment: env.name } });
  res.json({ ok: true });
}));

r.get('/applications/:id/compose', requirePerm('apps.view'), ah(async (req, res) => {
  const { app, env } = await ctx(req);
  const file = path.join(paths.envDir(app.slug, env.name), 'docker-compose.yml');
  if (fs.existsSync(file)) return res.json({ compose: fs.readFileSync(file, 'utf8'), generated: true });
  const db = await one(`SELECT * FROM databases WHERE environment_id=$1`, [env.id]);
  res.json({ generated: false, compose: generateCompose({
    slug: app.slug, env: env.name, image: (await currentImageFor(app, env)) ?? imageTag(app.slug, 'x.y.z'), internalPort: env.internal_port || app.internal_port,
    externalPort: env.external_port, domain: env.domain, httpsEnabled: env.https_enabled, volumes: env.volumes, extraPorts: env.extra_ports,
    database: db ? { engine: db.engine, version: db.engine_version, databaseName: db.database_name } : null,
  }) });
}));

// ───────── variables de entorno ─────────

r.get('/applications/:id/env', requirePerm('apps.edit', 'versions.create'), ah(async (req, res) => {
  const { env } = await ctx(req);
  const vars = await listVars(env.id);
  res.json(vars.map((v) => ({ id: v.id, key: v.key, value: v.is_secret ? MASK : v.value, isSecret: v.is_secret, isSystem: v.is_system, updatedAt: v.updated_at })));
}));

/** Reemplaza las variables (no de sistema). Un valor "********" o ausente en una secreta conserva el valor actual. */
r.put('/applications/:id/env', requirePerm('apps.edit'), ah(async (req, res) => {
  const { app, env } = await ctx(req);
  const b = parse(z.object({ variables: z.array(z.object({
    key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(120), value: z.string().max(20000).optional(), isSecret: z.boolean().default(false),
  })).max(500) }), req.body);
  const keys = new Set<string>();
  for (const v of b.variables) { if (keys.has(v.key)) throw badRequest(`Variable duplicada: ${v.key}`); keys.add(v.key); }
  const current = new Map((await listVars(env.id)).map((v) => [v.key, v]));
  for (const v of b.variables) {
    const cur = current.get(v.key);
    if (cur?.is_system) continue;
    const keep = (v.value === undefined || v.value === MASK) && cur;
    if (keep) {
      if (cur!.is_secret !== v.isSecret) {
        const plain = cur!.is_secret ? decrypt(cur!.value_enc) : cur!.value ?? '';
        await upsertVar(env.id, v.key, plain, v.isSecret);
      }
      continue;
    }
    await upsertVar(env.id, v.key, v.value ?? '', v.isSecret);
  }
  const removed = [...current.values()].filter((c) => !c.is_system && !keys.has(c.key)).map((c) => c.key);
  if (removed.length) await q(`DELETE FROM environment_variables WHERE environment_id=$1 AND key = ANY($2) AND NOT is_system`, [env.id, removed]);
  await audit(req, { action: 'env_update', entityType: 'environment', entityId: env.id, app,
    details: { environment: env.name, keys: [...keys], removed } });
  if (env.deployed_version_id) await writeEnvFiles(app, env, (await currentImageFor(app, env))!);
  res.json({ ok: true, restartRequired: !!env.deployed_version_id });
}));

r.get('/applications/:id/env/export', requirePerm('apps.edit', 'versions.create'), ah(async (req, res) => {
  const { app, env } = await ctx(req);
  const vars = await listVars(env.id);
  const lines = [`# ${app.name} — ${env.name} — exportado ${new Date().toISOString()}`, '# Los valores secretos no se exportan (vacíos).'];
  for (const v of vars) lines.push(v.is_secret ? `${v.key}=  # secreto${v.is_system ? ' (sistema)' : ''}` : toDotenvLine(v.key, v.value ?? ''));
  await audit(req, { action: 'env_export', entityType: 'environment', entityId: env.id, app, details: { environment: env.name } });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${app.slug}-${env.name}.env"`);
  res.send(lines.join('\n') + '\n');
}));

r.post('/applications/:id/env/import', requirePerm('apps.edit'), ah(async (req, res) => {
  const { app, env } = await ctx(req);
  const b = parse(z.object({ content: z.string().max(500000), overwrite: z.boolean().default(true), autoSecret: z.boolean().default(true) }), req.body);
  const parsed = parseDotenv(b.content);
  const current = new Map((await listVars(env.id)).map((v) => [v.key, v]));
  let imported = 0;
  for (const p of parsed) {
    const cur = current.get(p.key);
    if (cur?.is_system || (cur && !b.overwrite)) continue;
    if (!p.value && cur?.is_secret) continue; // export sin secretos: no pisar
    await upsertVar(env.id, p.key, p.value, cur?.is_secret || (b.autoSecret && SECRET_KEY_RE.test(p.key)));
    imported++;
  }
  await audit(req, { action: 'env_import', entityType: 'environment', entityId: env.id, app, details: { environment: env.name, imported } });
  // Igual que PUT /env: regenerar el .env de la app desplegada (los cambios aplican al reiniciar)
  if (imported && env.deployed_version_id) await writeEnvFiles(app, env, (await currentImageFor(app, env))!);
  res.json({ imported, total: parsed.length, restartRequired: !!imported && !!env.deployed_version_id });
}));

// ───────── Git ─────────

r.post('/applications/:id/git/pull', requirePerm('versions.create'), ah(async (req, res) => {
  const { app, env } = await ctx(req);
  const b = parse(z.object({ deploy: z.boolean().default(true), version: z.string().optional(), comment: z.string().optional(), environment: z.string().optional() }), req.body);
  if (b.deploy) assertDeployPerm(req.user, env.name);
  const result = await updateFromGit(app, env, req.user!, { version: b.version, comment: b.comment, deploy: b.deploy });
  await audit(req, { action: 'git_pull', entityType: 'version', entityId: result.version.id, app, details: { version: result.version.version, commit: result.version.commit_sha, environment: env.name } });
  res.status(201).json(result);
}));

export default r;
