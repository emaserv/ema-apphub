import fs from 'fs';
import path from 'path';
import { config, paths } from '../config';
import { one, q } from '../db/pool';
import { decrypt } from '../lib/crypto';
import { sleep } from '../lib/util';
import { audit } from './audit';
import {
  AppRow, EnvRow, VersionRow, assertPortFree, envProject, getApp, getVersion, imageTag, registryTag, writeEnvFiles,
} from './core';
import * as dk from './docker';
import { deployFailedNotice, notify, vulnerableImageNotice } from './notify';
import { ScanSummary, blockMessage, formatScan, parseTrivyReport, scanDecision } from './scan';
import { writeSupportFiles } from './templates';

type Trigger = 'manual' | 'git' | 'webhook' | 'rollback' | 'auto_rollback' | 'clone' | 'restore';

/** Acumula líneas de log y las persiste en lote (evita miles de UPDATE durante un build). */
class DeployLog {
  private buf: string[] = [];
  private timer: NodeJS.Timeout;
  constructor(private id: string) { this.timer = setInterval(() => void this.flush(), 1000); }
  line(msg: string) {
    const ts = new Date().toISOString().slice(11, 19);
    this.buf.push(`[${ts}] ${msg.replace(/\x1b\[[0-9;]*m/g, '')}`);
  }
  async step(step: string, msg: string) {
    this.line(`▶ ${msg}`);
    await this.flush();
    await q(`UPDATE deployments SET current_step=$2 WHERE id=$1`, [this.id, step]);
  }
  async flush() {
    if (!this.buf.length) return;
    const text = this.buf.join('\n') + '\n';
    this.buf = [];
    await q(`UPDATE deployments SET log = right(log || $2, 2000000) WHERE id=$1`, [this.id, text]);
  }
  async close() { clearInterval(this.timer); await this.flush(); }
}

// Serializa los deploys por ambiente
const chains = new Map<string, Promise<void>>();

export interface DeployRequest {
  appId: string;
  envId: string;
  versionId: string;
  trigger?: Trigger;
  userId?: string | null;
  username?: string;
  autoRollback?: boolean;
  forceRebuild?: boolean;
}

export async function enqueueDeploy(r: DeployRequest) {
  const env = await one<EnvRow>(`SELECT * FROM application_environments WHERE id=$1`, [r.envId]);
  const dep = await one(
    `INSERT INTO deployments (application_id, environment_id, version_id, previous_version_id, trigger, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [r.appId, r.envId, r.versionId, env?.deployed_version_id ?? null, r.trigger ?? 'manual', r.userId ?? null],
  );
  const prev = chains.get(r.envId) ?? Promise.resolve();
  const next = prev.then(() => runDeployment(dep.id, r)).catch((e) => console.error('[deploy]', e));
  chains.set(r.envId, next);
  void next.finally(() => { if (chains.get(r.envId) === next) chains.delete(r.envId); });
  return dep;
}

async function setEnvStatus(envId: string, status: string, extra: Record<string, unknown> = {}) {
  const sets = ['status=$2', 'updated_at=now()'];
  const vals: unknown[] = [envId, status];
  for (const [k, v] of Object.entries(extra)) { vals.push(v); sets.push(`${k}=$${vals.length}`); }
  await q(`UPDATE application_environments SET ${sets.join(', ')} WHERE id=$1`, vals);
}

export type ImagePlan = 'reuse' | 'pull' | 'build' | 'missing';

/**
 * Decide cómo obtener la imagen de una versión. El código fuente solo hace falta para construirla:
 * si la imagen ya existe (p. ej. en un rollback) se reutiliza aunque el código ya no esté en disco.
 */
export function planImage(o: { imageExists: boolean; sourceExists: boolean; forceRebuild?: boolean; dirty: boolean; pushedToRegistry: boolean }): ImagePlan {
  if (o.imageExists && !o.forceRebuild && !o.dirty) return 'reuse';
  if (!o.imageExists && !o.dirty && o.pushedToRegistry) return 'pull';
  return o.sourceExists ? 'build' : 'missing';
}

/** Prepara archivos, construye (o reutiliza) la imagen y levanta el ambiente. */
/** Escanea la imagen antes de publicarla y levantarla. Ver reglas en services/scan.ts. */
async function scanStep(app: AppRow, env: EnvRow, version: VersionRow, image: string, log: DeployLog, trigger?: Trigger) {
  await log.step('scan', 'Escaneando vulnerabilidades (Trivy)');
  log.line('La primera vez se descarga la base de vulnerabilidades (unos 130 MB): puede tardar un par de minutos.');
  let summary: ScanSummary;
  try {
    summary = parseTrivyReport(await dk.scanImage(image));
  } catch (e: any) {
    log.line(`⚠ No se pudo escanear la imagen, el deploy continúa sin escaneo: ${String(e?.message || e).slice(-500)}`);
    return;
  }
  formatScan(summary).forEach((l) => log.line(l));
  if (scanDecision(summary, env.name, trigger) === 'block') throw new Error(blockMessage(summary));
  if (summary.critical > 0) {
    notify(vulnerableImageNotice({ app, env: env.name, version: version.version, critical: summary.critical, criticalFixable: summary.criticalFixable }));
  }
}

async function deployVersion(app: AppRow, env: EnvRow, version: VersionRow, log: DeployLog, opts: { forceRebuild?: boolean; trigger?: Trigger }) {
  const image = imageTag(app.slug, version.version);
  const container = envProject(app, env);

  await log.step('prepare', `Preparando ${app.name} ${version.version} → ${env.name}`);
  const reg = await registryTag(app, version.version);
  const sourceExists = fs.existsSync(version.source_path);
  const plan = planImage({
    imageExists: await dk.imageExists(image),
    sourceExists,
    forceRebuild: opts.forceRebuild,
    dirty: !!version.build_config?.dirty,
    pushedToRegistry: !!reg && !!(await one(`SELECT 1 FROM docker_images WHERE version_id=$1 AND pushed`, [version.id])),
  });
  if (plan === 'missing') {
    throw new Error(`No existe el código de la versión en ${version.source_path} ni una imagen para reutilizar: vuelva a subir el código de esta versión.`);
  }
  if (sourceExists) {
    writeSupportFiles(version.source_path);
    fs.writeFileSync(path.join(version.source_path, 'Dockerfile'), version.dockerfile);
  } else {
    log.line('El código de esta versión ya no está en disco: se usará la imagen existente.');
  }
  const dir = await writeEnvFiles(app, env, image);
  log.line(`Archivos generados en ${dir}`);

  await log.step('validate', 'Validando configuración');
  if (!version.dockerfile.trim()) throw new Error('El Dockerfile está vacío');
  if (env.external_port) await assertPortFree(env.external_port, env.id, container);
  for (const p of env.extra_ports || []) await assertPortFree(p.external, env.id, container);
  await dk.ensureNetwork();
  await dk.composeValidate(dir, container);
  log.line('docker-compose.yml válido');

  await log.step('build', `Imagen ${image}`);
  if (plan === 'reuse') {
    log.line('La imagen ya existe: se reutiliza (sin recompilar)');
  } else if (plan === 'pull' && reg) {
    log.line(`Descargando ${reg.tag} desde el registry`);
    await dk.pullImage(reg.tag, (l) => log.line(l));
    await dk.tagAndPush(reg.tag, image, () => undefined).catch(() => undefined);
  } else {
    await dk.buildImage(version.source_path, image, (l) => log.line(l), { 'ema.app': app.slug, 'ema.version': version.version });
    const info = await dk.imageInfo(image);
    await q(
      `INSERT INTO docker_images (application_id, version_id, tag, image_id, size_bytes) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (version_id, tag) DO UPDATE SET image_id=EXCLUDED.image_id, size_bytes=EXCLUDED.size_bytes, created_at=now()`,
      [app.id, version.id, image, info?.id ?? null, info?.size ?? null],
    );
    if (version.build_config?.dirty) await q(`UPDATE application_versions SET build_config = build_config - 'dirty' WHERE id=$1`, [version.id]);
    log.line('Imagen construida');
  }

  const bc = { ...(app.build_config || {}), ...(version.build_config || {}) };
  if (bc.runTests && bc.testCommand) {
    await log.step('test', `Ejecutando tests: ${bc.testCommand}`);
    await dk.runTests(image, bc.testCommand, (l) => log.line(l));
    log.line('Tests OK');
  }

  if (config.scanEnabled) await scanStep(app, env, version, image, log, opts.trigger);

  if (reg && !(await one(`SELECT 1 FROM docker_images WHERE version_id=$1 AND pushed`, [version.id]))) {
    await log.step('push', `Publicando ${reg.tag}`);
    if (reg.registry.username) await dk.registryLogin(reg.registry.url, reg.registry.username, decrypt(reg.registry.password_enc));
    await dk.tagAndPush(image, reg.tag, (l) => log.line(l));
    await q(`INSERT INTO docker_images (application_id, version_id, tag, registry_id, pushed) VALUES ($1,$2,$3,$4,true)
             ON CONFLICT (version_id, tag) DO UPDATE SET pushed=true`, [app.id, version.id, reg.tag, reg.registry.id]);
  }

  await log.step('deploy', 'Levantando contenedores (docker compose up -d)');
  await dk.compose(dir, container, ['up', '-d', '--remove-orphans'], (l) => log.line(l));

  await log.step('health', 'Verificando salud de la aplicación');
  await waitHealthy(app, env, log);
}

export async function probe(app: AppRow, env: EnvRow): Promise<{ ok: boolean; status?: number; ms: number; error?: string }> {
  const pathH = app.healthcheck_path || '/';
  const url = `http://${envProject(app, env)}:${env.internal_port || app.internal_port}${pathH.startsWith('/') ? pathH : '/' + pathH}`;
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(config.healthTimeoutMs), redirect: 'manual' });
    return { ok: r.status < 400, status: r.status, ms: Date.now() - t0, error: r.status >= 400 ? `HTTP ${r.status}` : undefined };
  } catch (e: any) {
    return { ok: false, ms: Date.now() - t0, error: e?.name === 'TimeoutError' ? 'Timeout' : e?.cause?.code || e?.message };
  }
}

async function waitHealthy(app: AppRow, env: EnvRow, log: DeployLog) {
  const deadline = Date.now() + config.deployHealthWaitSec * 1000;
  const name = envProject(app, env);
  let last = '';
  while (Date.now() < deadline) {
    const st = await dk.containerState(name);
    if (!st) throw new Error('El contenedor no fue creado');
    if (!st.running && st.state === 'exited') {
      const tail = await dk.containerLogs(name, { tail: 30, timestamps: false }).catch(() => '');
      throw new Error(`El contenedor se detuvo (exit ${st.exitCode}).\n${tail}`);
    }
    if (st.running) {
      const r = await probe(app, env);
      if (r.ok) { log.line(`Health check OK (HTTP ${r.status}, ${r.ms} ms)`); return; }
      if (r.error !== last) { log.line(`Health check pendiente: ${r.error}`); last = r.error || ''; }
    }
    await sleep(3000);
  }
  throw new Error(`Health check falló tras ${config.deployHealthWaitSec}s: ${last}`);
}

async function runDeployment(depId: string, r: DeployRequest) {
  const log = new DeployLog(depId);
  const app = await getApp(r.appId);
  let env = (await one<EnvRow>(`SELECT * FROM application_environments WHERE id=$1`, [r.envId]))!;
  const version = await getVersion(app.id, r.versionId);
  const previousId = env.deployed_version_id;
  await q(`UPDATE deployments SET status='running', started_at=now() WHERE id=$1`, [depId]);
  await setEnvStatus(env.id, 'deploying');
  const user = r.userId ? { id: r.userId, username: r.username ?? '' } : null;
  try {
    await deployVersion(app, env, version, log, { forceRebuild: r.forceRebuild, trigger: r.trigger });
    await setEnvStatus(env.id, 'running', { deployed_version_id: version.id, health_status: 'healthy', health_checked_at: new Date().toISOString() });
    if (env.is_default) await q(`UPDATE applications SET current_version_id=$2, updated_at=now() WHERE id=$1`, [app.id, version.id]);
    log.line(`✔ Deploy exitoso: ${app.name} ${version.version} en ${env.name}`);
    await log.close();
    await q(`UPDATE deployments SET status='success', current_step='done', finished_at=now() WHERE id=$1`, [depId]);
    await audit(null, { action: 'deploy', entityType: 'deployment', entityId: depId, app, details: { version: version.version, environment: env.name, trigger: r.trigger } }, user);
  } catch (e: any) {
    const msg = String(e?.message || e);
    log.line(`✖ ERROR: ${msg}`);
    await log.flush();
    await q(`UPDATE deployments SET error=$2 WHERE id=$1`, [depId, msg.slice(0, 4000)]);
    await audit(null, { action: 'deploy', entityType: 'deployment', entityId: depId, app, result: 'failure', details: { version: version.version, environment: env.name, error: msg.slice(0, 500) } }, user);
    const failInfo = { app, env: env.name, version: version.version, error: msg, by: r.username || (r.trigger && r.trigger !== 'manual' ? r.trigger : undefined) };

    const canRollback = r.autoRollback !== false && previousId && previousId !== version.id;
    if (canRollback) {
      try {
        const prev = await getVersion(app.id, previousId!);
        log.line(`↺ Rollback automático a ${prev.version}`);
        env = (await one<EnvRow>(`SELECT * FROM application_environments WHERE id=$1`, [r.envId]))!;
        await deployVersion(app, env, prev, log, { trigger: 'auto_rollback' });
        await setEnvStatus(env.id, 'running', { deployed_version_id: prev.id, health_status: 'healthy' });
        log.line(`✔ Rollback completado: ${prev.version} activa`);
        await log.close();
        await q(`UPDATE deployments SET status='rolled_back', finished_at=now() WHERE id=$1`, [depId]);
        await audit(null, { action: 'auto_rollback', entityType: 'deployment', entityId: depId, app, details: { to: prev.version, environment: env.name } }, user);
        notify(deployFailedNotice({ ...failInfo, rolledBackTo: prev.version }));
        return;
      } catch (e2: any) {
        log.line(`✖ El rollback automático también falló: ${e2?.message || e2}`);
      }
    }
    await log.close();
    await setEnvStatus(r.envId, 'error', { health_status: 'unhealthy' });
    await q(`UPDATE deployments SET status='failed', finished_at=now() WHERE id=$1`, [depId]);
    notify(deployFailedNotice(failInfo));
  }
}

// ───────── operaciones de ciclo de vida ─────────

export async function lifecycle(app: AppRow, env: EnvRow, action: 'start' | 'stop' | 'restart' | 'recreate') {
  const image = await (async () => {
    if (!env.deployed_version_id) throw new Error('El ambiente todavía no tiene un deploy');
    const v = await getVersion(app.id, env.deployed_version_id);
    return imageTag(app.slug, v.version);
  })();
  const dir = await writeEnvFiles(app, env, image);
  const project = envProject(app, env);
  if (action === 'start') await dk.compose(dir, project, ['up', '-d']);
  if (action === 'stop') await dk.compose(dir, project, ['stop']);
  if (action === 'restart') await dk.compose(dir, project, ['restart', 'app']);
  if (action === 'recreate') await dk.compose(dir, project, ['up', '-d', '--force-recreate', 'app']);
  await setEnvStatus(env.id, action === 'stop' ? 'stopped' : 'running');
}

export async function teardown(app: AppRow, env: EnvRow, removeVolumes: boolean) {
  const dir = paths.envDir(app.slug, env.name);
  if (fs.existsSync(path.join(dir, 'docker-compose.yml'))) {
    await dk.compose(dir, envProject(app, env), ['down', '--remove-orphans', ...(removeVolumes ? ['-v'] : [])]).catch((e) => console.error(e));
  }
}
