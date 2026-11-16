import { Request, Router } from 'express';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { z } from 'zod';
import { one, q } from '../db/pool';
import { ah, badRequest, notFound, parse } from '../lib/http';
import { requirePerm } from '../middleware/auth';
import { appAccessParam, visibleAppIds } from '../services/appAccess';
import { audit } from '../services/audit';
import { backupApp, backupDatabase, deleteBackup, restoreBackup } from '../services/backup';
import { getApp } from '../services/core';
import * as dbs from '../services/database';
import { listRefs } from '../services/git';
import { saveRepository } from '../services/apps';
import { reloadBackupSchedules } from '../services/monitor';
import { ctx } from './_helpers';

const r = Router();
// Toda ruta /applications/:id exige que el usuario tenga acceso a esa app (si no, 404)
r.param('id', appAccessParam);

// ───────── base de datos por ambiente ─────────

r.get('/applications/:id/database', requirePerm('db.view'), ah(async (req, res) => {
  const { env } = await ctx(req);
  res.json(await dbs.databaseInfo(env));
}));

r.post('/applications/:id/database', requirePerm('db.manage'), ah(async (req, res) => {
  const { app, env } = await ctx(req);
  const b = parse(z.object({ databaseName: z.string().max(63).optional(), username: z.string().max(63).optional(), version: z.string().max(3).optional(),
    engine: z.literal('postgres').default('postgres'), environment: z.string().optional() }), req.body);
  try {
    const db = await dbs.createDatabase(app, env, b);
    await audit(req, { action: 'db_create', entityType: 'database', entityId: db?.id, app, details: { environment: env.name, database: db?.database_name } });
    res.status(201).json(db);
  } catch (e: any) {
    await audit(req, { action: 'db_create', entityType: 'database', app, result: 'failure', details: { environment: env.name, error: e.message } });
    throw e;
  }
}));

r.delete('/applications/:id/database', requirePerm('db.manage'), ah(async (req, res) => {
  const { app, env } = await ctx(req);
  if (req.query.confirm !== app.slug) throw badRequest(`Confirme escribiendo el identificador de la aplicación (${app.slug})`);
  await dbs.deleteDatabase(app, env);
  await audit(req, { action: 'db_delete', entityType: 'database', app, details: { environment: env.name } });
  res.json({ ok: true });
}));

r.post('/applications/:id/database/restart', requirePerm('db.manage'), ah(async (req, res) => {
  const { app, env } = await ctx(req);
  await dbs.restartDatabase(env);
  await audit(req, { action: 'db_restart', entityType: 'database', app, details: { environment: env.name } });
  res.json({ ok: true });
}));

r.post('/applications/:id/database/users', requirePerm('db.manage'), ah(async (req, res) => {
  const { app, env } = await ctx(req);
  const b = parse(z.object({ username: z.string(), privileges: z.enum(['readwrite', 'readonly']).default('readwrite'), password: z.string().optional() }), req.body);
  const u = await dbs.addUser(env, b.username, b.privileges, b.password || undefined);
  await audit(req, { action: 'db_user_create', entityType: 'database', app, details: { environment: env.name, username: b.username, privileges: b.privileges } });
  res.status(201).json(u);
}));

r.delete('/applications/:id/database/users/:uid', requirePerm('db.manage'), ah(async (req, res) => {
  const { app, env } = await ctx(req);
  await dbs.removeUser(env, req.params.uid);
  await audit(req, { action: 'db_user_delete', entityType: 'database', app, details: { environment: env.name, credentialId: req.params.uid } });
  res.json({ ok: true });
}));

r.post('/applications/:id/database/users/:uid/password', requirePerm('db.manage'), ah(async (req, res) => {
  const { app, env } = await ctx(req);
  const b = parse(z.object({ password: z.string().optional() }), req.body);
  await dbs.rotatePassword(app, env, req.params.uid, b.password || undefined);
  await audit(req, { action: 'db_password_rotate', entityType: 'database', app, details: { environment: env.name, credentialId: req.params.uid } });
  res.json({ ok: true, message: 'Contraseña actualizada. Por seguridad no se muestra; se inyectó en las variables del ambiente si corresponde.' });
}));

r.get('/databases', requirePerm('db.view'), ah(async (req, res) => {
  res.json(await q(
    `SELECT d.id, d.engine, d.engine_version, d.container_name, d.host, d.port, d.database_name, d.status, d.created_at,
            a.id AS application_id, a.name AS application_name, a.slug, e.name AS environment,
            (SELECT username FROM database_credentials c WHERE c.database_id=d.id AND c.is_owner) AS owner,
            (SELECT count(*)::int FROM database_credentials c WHERE c.database_id=d.id) AS users_count,
            (SELECT max(created_at) FROM backups b WHERE b.database_id=d.id AND b.status='success') AS last_backup
       FROM databases d JOIN applications a ON a.id=d.application_id JOIN application_environments e ON e.id=d.environment_id
      WHERE ($1::uuid[] IS NULL OR a.id = ANY($1))
      ORDER BY a.name, e.name`, [await visibleAppIds(req.user!)]));
}));

// ───────── backups ─────────

r.get('/backups', requirePerm('backups.view'), ah(async (req, res) => {
  const appId = req.query.applicationId as string | undefined;
  res.json(await q(
    `SELECT b.id, b.type, b.status, b.size_bytes, b.scheduled, b.notes, b.error, b.created_at, b.finished_at, b.app_slug,
            a.id AS application_id, a.name AS application_name, e.name AS environment, u.full_name AS user_name,
            regexp_replace(b.file_path, '^.*/', '') AS file_name
       FROM backups b LEFT JOIN applications a ON a.id=b.application_id LEFT JOIN application_environments e ON e.id=b.environment_id
       LEFT JOIN users u ON u.id=b.created_by
      WHERE ($1::uuid IS NULL OR b.application_id=$1) AND ($2::uuid[] IS NULL OR b.application_id = ANY($2))
      ORDER BY b.created_at DESC LIMIT 500`, [appId ?? null, await visibleAppIds(req.user!)]));
}));

r.post('/applications/:id/backup', requirePerm('backups.manage'), ah(async (req, res) => {
  const { app, env } = await ctx(req);
  const b = parse(z.object({ type: z.enum(['app', 'database', 'both']).default('both'), notes: z.string().max(500).optional(), environment: z.string().optional() }), req.body);
  const out: any[] = [];
  const hasDb = await one(`SELECT 1 FROM databases WHERE environment_id=$1`, [env.id]);
  if (b.type !== 'database') out.push(await backupApp(app, env, req.user!.id, false, b.notes));
  if (b.type !== 'app') {
    if (!hasDb && b.type === 'database') throw badRequest('El ambiente no tiene base de datos');
    if (hasDb) out.push(await backupDatabase(app, env, req.user!.id, false, b.notes));
  }
  await audit(req, { action: 'backup', entityType: 'backup', app, details: { environment: env.name, type: b.type } });
  res.status(201).json(out);
}));

r.post('/applications/:id/restore', requirePerm('backups.manage'), ah(async (req, res) => {
  const app = await getApp(req.params.id);
  const { backupId } = parse(z.object({ backupId: z.string().uuid() }), req.body);
  const b = await one(`SELECT application_id FROM backups WHERE id=$1`, [backupId]);
  if (!b || b.application_id !== app.id) throw notFound('Backup no encontrado para esta aplicación');
  try {
    const result = await restoreBackup(backupId, req.user!);
    await audit(req, { action: 'restore', entityType: 'backup', entityId: backupId, app, details: result });
    res.json(result);
  } catch (e: any) {
    await audit(req, { action: 'restore', entityType: 'backup', entityId: backupId, app, result: 'failure', details: { error: e.message } });
    throw e;
  }
}));

/** Backup por id, sólo si es de una app que el usuario puede ver. */
async function visibleBackup(req: Request, bid: string) {
  const b = await one(`SELECT * FROM backups WHERE id::text=$1`, [bid]);
  const ids = await visibleAppIds(req.user!);
  if (!b || (ids && !ids.includes(b.application_id))) throw notFound('Backup no encontrado');
  return b;
}

r.get('/backups/:bid/download', requirePerm('backups.manage'), ah(async (req, res) => {
  const b = await visibleBackup(req, req.params.bid);
  if (!b.file_path || !fs.existsSync(b.file_path)) throw notFound('Archivo de backup no disponible');
  await audit(req, { action: 'backup_download', entityType: 'backup', entityId: b.id, details: { file: path.basename(b.file_path) } });
  res.download(b.file_path, path.basename(b.file_path));
}));

r.delete('/backups/:bid', requirePerm('backups.manage'), ah(async (req, res) => {
  await visibleBackup(req, req.params.bid);
  await deleteBackup(req.params.bid);
  await audit(req, { action: 'backup_delete', entityType: 'backup', entityId: req.params.bid });
  res.json({ ok: true });
}));

r.get('/applications/:id/backup-schedules', requirePerm('backups.view'), ah(async (req, res) => {
  const app = await getApp(req.params.id);
  res.json(await q(`SELECT s.*, e.name AS environment FROM backup_schedules s JOIN application_environments e ON e.id=s.environment_id
                    WHERE e.application_id=$1 ORDER BY e.name, s.type`, [app.id]));
}));

r.post('/applications/:id/backup-schedules', requirePerm('backups.manage'), ah(async (req, res) => {
  const { app, env } = await ctx(req);
  const b = parse(z.object({ type: z.enum(['app', 'database']), cron: z.string().max(60), retention: z.number().int().min(1).max(365).default(7),
    enabled: z.boolean().default(true), environment: z.string().optional() }), req.body);
  if (!cron.validate(b.cron)) throw badRequest('Expresión cron inválida (ej: "0 3 * * *" = todos los días 03:00)');
  const s = await one(`INSERT INTO backup_schedules (environment_id, type, cron, retention, enabled) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [env.id, b.type, b.cron, b.retention, b.enabled]);
  await reloadBackupSchedules();
  await audit(req, { action: 'backup_schedule_create', entityType: 'backup_schedule', entityId: s.id, app, details: b });
  res.status(201).json(s);
}));

r.delete('/applications/:id/backup-schedules/:sid', requirePerm('backups.manage'), ah(async (req, res) => {
  const app = await getApp(req.params.id);
  await q(`DELETE FROM backup_schedules s USING application_environments e WHERE s.id=$1 AND e.id=s.environment_id AND e.application_id=$2`, [req.params.sid, app.id]);
  await reloadBackupSchedules();
  await audit(req, { action: 'backup_schedule_delete', entityType: 'backup_schedule', entityId: req.params.sid, app });
  res.json({ ok: true });
}));

// ───────── repositorio Git ─────────

const GIT = z.object({
  url: z.string().min(4).max(500), provider: z.string().optional(), authType: z.enum(['none', 'token', 'basic', 'ssh']).default('none'),
  username: z.string().max(120).nullable().optional(), credential: z.string().max(20000).nullable().optional(),
  branch: z.string().max(200).nullable().optional(), tag: z.string().max(200).nullable().optional(), commit: z.string().max(64).nullable().optional(),
  subdirectory: z.string().max(255).nullable().optional(), autoDeployEnvironment: z.enum(['development', 'test', 'staging', 'production']).nullable().optional(),
});

r.put('/applications/:id/repository', requirePerm('git.manage'), ah(async (req, res) => {
  const app = await getApp(req.params.id);
  const b = parse(GIT, req.body);
  await saveRepository(app.id, { ...b, subdirectory: b.subdirectory ?? undefined, autoDeployEnvironment: b.autoDeployEnvironment ?? undefined });
  await audit(req, { action: 'repository_update', entityType: 'repository', app, details: { url: b.url, branch: b.branch, tag: b.tag, commit: b.commit, authType: b.authType } });
  res.json({ ok: true });
}));

r.delete('/applications/:id/repository', requirePerm('git.manage'), ah(async (req, res) => {
  const app = await getApp(req.params.id);
  await q(`DELETE FROM repositories WHERE application_id=$1`, [app.id]);
  await audit(req, { action: 'repository_delete', entityType: 'repository', app });
  res.json({ ok: true });
}));

r.post('/git/refs', requirePerm('git.manage', 'apps.create'), ah(async (req, res) => {
  const b = parse(GIT, req.body);
  res.json(await listRefs(b));
}));

r.get('/repositories', requirePerm('apps.view'), ah(async (req, res) => {
  res.json(await q(`SELECT r.id, r.provider, r.url, r.auth_type, r.branch, r.tag, r.commit_sha, r.last_commit, r.last_sync_at, r.auto_deploy_environment,
                           a.id AS application_id, a.name AS application_name, a.slug
                      FROM repositories r JOIN applications a ON a.id=r.application_id
                     WHERE ($1::uuid[] IS NULL OR a.id = ANY($1)) ORDER BY a.name`, [await visibleAppIds(req.user!)]));
}));

export default r;
