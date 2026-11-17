import crypto from 'crypto';
import { Request, Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { one, q } from '../db/pool';
import { encrypt } from '../lib/crypto';
import { ah, HttpError, notFound, parse } from '../lib/http';
import { requirePerm } from '../middleware/auth';
import { updateFromGit } from '../services/apps';
import { visibleAppIds, visibleAppSlugs } from '../services/appAccess';
import { audit } from '../services/audit';
import { cleanupAllImages } from '../services/cleanup';
import { assertPortFree, getApp, getEnv, nextFreePort } from '../services/core';
import * as dk from '../services/docker';
import { hostMetrics } from '../services/monitor';

export const system = Router();
export const webhooks = Router();

// ───────── dashboard ─────────

system.get('/system/dashboard', requirePerm('apps.view'), ah(async (req, res) => {
  // Desarrollador / Consulta: todo se cuenta sólo sobre sus aplicaciones asignadas ($1 = null: todas)
  const ids = await visibleAppIds(req.user!);
  const slugs = await visibleAppSlugs(req.user!);
  const [counts] = await q(`
    WITH main AS (
      SELECT DISTINCT ON (a.id) a.id, e.status, e.health_status
        FROM applications a LEFT JOIN application_environments e ON e.application_id=a.id
       WHERE ($1::uuid[] IS NULL OR a.id = ANY($1))
       ORDER BY a.id, e.is_default DESC)
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE status='running' AND health_status <> 'unhealthy')::int AS running,
           count(*) FILTER (WHERE status IN ('stopped','not_deployed') OR status IS NULL)::int AS stopped,
           count(*) FILTER (WHERE status='error' OR (status='running' AND health_status='unhealthy'))::int AS error,
           count(*) FILTER (WHERE status='deploying')::int AS deploying
      FROM main`, [ids]);
  const [other] = await q(`SELECT (SELECT count(*)::int FROM databases WHERE ($1::uuid[] IS NULL OR application_id = ANY($1))) AS databases,
                                  (SELECT count(*)::int FROM application_environments WHERE deployed_version_id IS NOT NULL AND ($1::uuid[] IS NULL OR application_id = ANY($1))) AS environments,
                                  (SELECT count(*)::int FROM deployments WHERE created_at > now() - interval '7 days' AND ($1::uuid[] IS NULL OR application_id = ANY($1))) AS deployments_week,
                                  (SELECT count(*)::int FROM deployments WHERE created_at > now() - interval '7 days' AND status='failed' AND ($1::uuid[] IS NULL OR application_id = ANY($1))) AS failed_week,
                                  (SELECT count(*)::int FROM backups WHERE created_at > now() - interval '7 days' AND status='success' AND ($1::uuid[] IS NULL OR application_id = ANY($1))) AS backups_week`, [ids]);
  let containers = { total: 0, running: 0 };
  try {
    const list = (await dk.listManaged()).filter((c) => !slugs || slugs.has(c.Labels['ema.app']));
    containers = { total: list.length, running: list.filter((c) => c.State === 'running').length };
  } catch { /* docker no disponible */ }
  const recent = await q(`SELECT d.id, d.status, d.created_at, d.trigger, a.name AS application, a.id AS application_id, e.name AS environment, v.version
                            FROM deployments d JOIN applications a ON a.id=d.application_id JOIN application_environments e ON e.id=d.environment_id
                            LEFT JOIN application_versions v ON v.id=d.version_id
                           WHERE ($1::uuid[] IS NULL OR a.id = ANY($1)) ORDER BY d.created_at DESC LIMIT 8`, [ids]);
  res.json({ applications: counts, ...other, containers, host: hostMetrics(), dockerOnline: await dk.ping(), recentDeployments: recent });
}));

system.get('/system/metrics', requirePerm('apps.view'), ah(async (_req, res) => {
  res.json({ host: hostMetrics(), docker: await dk.info().catch(() => null) });
}));

system.get('/system/info', requirePerm('apps.view'), (_req, res) => {
  res.json({
    version: process.env.APP_VERSION || '1.0.0', dataDir: config.dataDir, appsNetwork: config.appsNetwork, baseDomain: config.baseDomain,
    publicHost: config.publicHost, traefik: config.traefikEnabled, portRange: [config.portRangeStart, config.portRangeEnd],
    maxUploadMb: config.maxUploadMb, terminalEnabled: config.terminalEnabled,
  });
});

system.get('/system/ports/check', requirePerm('apps.view'), ah(async (req, res) => {
  const port = Number(req.query.port);
  if (!port) return res.json({ suggested: await nextFreePort() });
  try {
    await assertPortFree(port, (req.query.environmentId as string) || null, undefined, req.user!.seesAllApps);
    res.json({ port, free: true });
  } catch (e: any) {
    res.json({ port, free: false, reason: e.message, suggested: await nextFreePort() });
  }
}));

// ───────── registries ─────────

system.get('/system/registries', requirePerm('apps.view'), ah(async (_req, res) => {
  res.json(await q(`SELECT id, name, kind, url, namespace, username, (password_enc IS NOT NULL) AS has_password, created_at FROM docker_registries ORDER BY name`));
}));

system.post('/system/registries', requirePerm('settings.manage'), ah(async (req, res) => {
  const b = parse(z.object({ name: z.string().min(2).max(80), kind: z.enum(['local', 'dockerhub', 'ghcr', 'private']), url: z.string().min(3).max(255),
    namespace: z.string().max(120).optional().nullable(), username: z.string().max(120).optional().nullable(), password: z.string().max(2000).optional().nullable() }), req.body);
  const row = await one(`INSERT INTO docker_registries (name, kind, url, namespace, username, password_enc) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name`,
    [b.name, b.kind, b.url, b.namespace ?? null, b.username ?? null, b.password ? encrypt(b.password) : null]);
  if (b.username && b.password) await dk.registryLogin(b.url, b.username, b.password).catch((e) => { throw new HttpError(400, `Login al registry falló: ${e.message}`); });
  await audit(req, { action: 'registry_create', entityType: 'registry', entityId: row.id, details: { name: b.name, url: b.url } });
  res.status(201).json(row);
}));

system.delete('/system/registries/:rid', requirePerm('settings.manage'), ah(async (req, res) => {
  await q(`DELETE FROM docker_registries WHERE id=$1`, [req.params.rid]);
  await audit(req, { action: 'registry_delete', entityType: 'registry', entityId: req.params.rid });
  res.json({ ok: true });
}));

// ───────── auditoría / deployments globales ─────────

system.get('/audit', requirePerm('audit.view'), ah(async (req, res) => {
  const { user, action, application, result, from, to } = req.query as Record<string, string>;
  const limit = Math.min(Number(req.query.limit) || 200, 2000);
  res.json(await q(
    `SELECT id, created_at, username, ip, action, entity_type, entity_id, application_id, application_name, details, result FROM audit_logs
      WHERE ($1::text IS NULL OR username ILIKE '%'||$1||'%') AND ($2::text IS NULL OR action ILIKE '%'||$2||'%')
        AND ($3::text IS NULL OR application_name ILIKE '%'||$3||'%') AND ($4::text IS NULL OR result=$4)
        AND ($5::timestamptz IS NULL OR created_at >= $5) AND ($6::timestamptz IS NULL OR created_at <= $6)
      ORDER BY created_at DESC LIMIT $7`,
    [user || null, action || null, application || null, result || null, from || null, to || null, limit]));
}));

system.get('/deployments', requirePerm('apps.view'), ah(async (req, res) => {
  res.json(await q(
    `SELECT d.id, d.status, d.trigger, d.current_step, d.error, d.created_at, d.started_at, d.finished_at,
            a.id AS application_id, a.name AS application_name, e.name AS environment, v.version, u.full_name AS user_name
       FROM deployments d JOIN applications a ON a.id=d.application_id JOIN application_environments e ON e.id=d.environment_id
       LEFT JOIN application_versions v ON v.id=d.version_id LEFT JOIN users u ON u.id=d.created_by
      WHERE ($1::text IS NULL OR d.status=$1) AND ($2::uuid[] IS NULL OR a.id = ANY($2))
      ORDER BY d.created_at DESC LIMIT 300`, [(req.query.status as string) || null, await visibleAppIds(req.user!)]));
}));

system.get('/deployments/:did', requirePerm('apps.view'), ah(async (req, res) => {
  const d = await one(
    `SELECT d.*, a.name AS application_name, a.slug, e.name AS environment, v.version, pv.version AS previous_version, u.full_name AS user_name
       FROM deployments d JOIN applications a ON a.id=d.application_id JOIN application_environments e ON e.id=d.environment_id
       LEFT JOIN application_versions v ON v.id=d.version_id LEFT JOIN application_versions pv ON pv.id=d.previous_version_id
       LEFT JOIN users u ON u.id=d.created_by WHERE d.id::text=$1`, [req.params.did]);
  const ids = await visibleAppIds(req.user!);
  if (!d || (ids && !ids.includes(d.application_id))) throw notFound('Deployment no encontrado');
  res.json(d);
}));

// ───────── Docker ─────────

system.get('/docker/info', requirePerm('docker.view'), ah(async (_req, res) => res.json(await dk.info())));

system.get('/docker/containers', requirePerm('docker.view'), ah(async (req, res) => {
  const slugs = await visibleAppSlugs(req.user!); // Desarrollador / Consulta: sólo contenedores de sus apps
  const list = (await dk.listManaged()).filter((c) => !slugs || slugs.has(c.Labels['ema.app']));
  const withStats = req.query.stats === '1';
  res.json(await Promise.all(list.map(async (c) => ({
    id: c.Id.slice(0, 12), name: c.Names[0]?.replace(/^\//, ''), image: c.Image, state: c.State, status: c.Status, created: c.Created,
    app: c.Labels['ema.app'], environment: c.Labels['ema.env'], service: c.Labels['ema.service'],
    ports: (c.Ports || []).filter((p) => p.PublicPort).map((p) => `${p.PublicPort}→${p.PrivatePort}`),
    stats: withStats && c.State === 'running' ? await dk.containerStats(c.Id) : null,
  }))));
}));

system.post('/docker/containers/:cid/:action', requirePerm('docker.manage'), ah(async (req, res) => {
  const action = req.params.action as 'start' | 'stop' | 'restart' | 'remove';
  if (!['start', 'stop', 'restart', 'remove'].includes(action)) throw notFound('Acción inválida');
  if (!/^[a-zA-Z0-9_.-]{3,128}$/.test(req.params.cid)) throw notFound('Contenedor inválido');
  await dk.containerAction(req.params.cid, action);
  await audit(req, { action: `container_${action}`, entityType: 'container', entityId: req.params.cid });
  res.json({ ok: true });
}));

system.get('/docker/images', requirePerm('docker.view'), ah(async (req, res) => {
  const slugs = await visibleAppSlugs(req.user!);
  const imgs = (await dk.docker.listImages({ filters: { label: ['ema.managed=true'] } })).filter((i) => !slugs || slugs.has(i.Labels?.['ema.app']));
  res.json(imgs.map((i) => ({ id: i.Id.replace('sha256:', '').slice(0, 12), tags: i.RepoTags, size: i.Size, created: i.Created, app: i.Labels?.['ema.app'], version: i.Labels?.['ema.version'] })));
}));

/** Limpieza manual: imágenes de versiones viejas (mismas reglas que la automática), huérfanas y caché de build vieja. */
system.post('/docker/images/prune', requirePerm('docker.manage'), ah(async (req, res) => {
  const r = await cleanupAllImages();
  await audit(req, { action: 'images_prune', entityType: 'docker',
    details: { images: r.images.length, freedBytes: r.freedBytes, danglingBytes: r.danglingBytes, buildCache: r.buildCache || undefined } });
  res.json({ ...r, SpaceReclaimed: r.freedBytes + r.danglingBytes });
}));

// ───────── webhooks Git (GitHub / GitLab / Bitbucket / genérico) ─────────

function verifyWebhook(req: Request & { rawBody?: Buffer }, secret: string): boolean {
  const gh = req.header('x-hub-signature-256');
  if (gh && req.rawBody) {
    const mac = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
    return mac.length === gh.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(gh));
  }
  const token = req.header('x-gitlab-token') || req.header('x-ema-token') || (req.query.token as string);
  return !!token && token.length === secret.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret));
}

webhooks.post('/webhooks/git/:id', ah(async (req, res) => {
  const repo = await one(`SELECT * FROM repositories WHERE application_id=$1`, [req.params.id]);
  if (!repo || !verifyWebhook(req as any, repo.webhook_secret)) throw new HttpError(401, 'Firma de webhook inválida');
  const app = await getApp(req.params.id);
  const pushedRef: string | undefined = req.body?.ref || req.body?.push?.changes?.[0]?.new?.name;
  if (repo.branch && pushedRef && !pushedRef.endsWith(`/${repo.branch}`) && pushedRef !== repo.branch) {
    return res.json({ ignored: true, reason: `Push a ${pushedRef}; se escucha ${repo.branch}` });
  }
  const env = repo.auto_deploy_environment ? await getEnv(app.id, repo.auto_deploy_environment) : null;
  res.status(202).json({ accepted: true, deploy: !!env });
  void updateFromGit(app, env, { id: null, username: 'webhook' }, { deploy: !!env, trigger: 'webhook' })
    .then((r) => audit(null, { action: 'git_webhook', entityType: 'version', entityId: r.version.id, app, details: { version: r.version.version } }, { id: null as any, username: 'webhook' }))
    .catch((e) => audit(null, { action: 'git_webhook', entityType: 'repository', app, result: 'failure', details: { error: e.message } }, { id: null as any, username: 'webhook' }));
}));
