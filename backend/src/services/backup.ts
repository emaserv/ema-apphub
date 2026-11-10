import fs from 'fs';
import path from 'path';
import { paths } from '../config';
import { one, q } from '../db/pool';
import { run, runOk } from '../lib/exec';
import { badRequest, notFound } from '../lib/http';
import { rmrf } from '../lib/util';
import { audit } from './audit';
import { AppRow, EnvRow, envSnapshot, getApp, getVersion } from './core';
import { ownerCredentials } from './database';
import { enqueueDeploy } from './deploy';
import { backupFailedNotice, notify } from './notify';
import { createStaging, moveDir } from './storage';

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

async function startRow(app: AppRow, env: EnvRow, type: 'app' | 'database', userId: string | null, scheduled: boolean, notes?: string, dbId?: string) {
  return one(`INSERT INTO backups (application_id, environment_id, database_id, app_slug, type, scheduled, notes, created_by)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [app.id, env.id, dbId ?? null, app.slug, type, scheduled, notes ?? null, userId]);
}

async function finish(id: string, file: string | null, error?: string) {
  const size = file && fs.existsSync(file) ? fs.statSync(file).size : null;
  await q(`UPDATE backups SET status=$2, file_path=$3, size_bytes=$4, error=$5, finished_at=now() WHERE id=$1`,
    [id, error ? 'failed' : 'success', file, size, error ?? null]);
}

/** Respaldo de aplicación: código de la versión desplegada + Dockerfile + compose + variables (cifradas) + manifiesto. */
export async function backupApp(app: AppRow, env: EnvRow, userId: string | null, scheduled = false, notes?: string) {
  const row = await startRow(app, env, 'app', userId, scheduled, notes);
  const dir = paths.backups(app.slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${app.slug}-${env.name}-app-${stamp()}.tar.gz`);
  const staging = createStaging('bkp');
  try {
    const versionId = env.deployed_version_id ?? app.current_version_id;
    if (!versionId) throw badRequest('La aplicación no tiene versiones para respaldar');
    const v = await getVersion(app.id, versionId);
    const vars = await q(`SELECT key, value, value_enc, is_secret, is_system FROM environment_variables WHERE environment_id=$1`, [env.id]);
    const manifest = {
      kind: 'ema-apphub-app-backup', formatVersion: 1, createdAt: new Date().toISOString(),
      application: { slug: app.slug, name: app.name, technology: app.technology, internalPort: app.internal_port, healthcheckPath: app.healthcheck_path, buildConfig: app.build_config },
      environment: { name: env.name, internalPort: env.internal_port, externalPort: env.external_port, domain: env.domain, volumes: env.volumes },
      version: { version: v.version, dockerfile: v.dockerfile, commit: v.commit_sha, comment: v.comment, buildConfig: v.build_config },
      variables: vars, // valores secretos permanecen cifrados con MASTER_KEY
      envSnapshotEnc: await envSnapshot(env.id),
    };
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const envDir = paths.envDir(app.slug, env.name);
    if (fs.existsSync(path.join(envDir, 'docker-compose.yml'))) fs.copyFileSync(path.join(envDir, 'docker-compose.yml'), path.join(staging, 'docker-compose.yml'));
    await runOk('tar', ['-czf', file, '-C', staging, '.', '-C', path.dirname(v.source_path), 'source'], { timeoutMs: 30 * 60_000 });
    await finish(row.id, file);
  } catch (e: any) {
    rmrf(file);
    await finish(row.id, null, e.message);
    throw e;
  } finally {
    rmrf(staging);
  }
  return one(`SELECT * FROM backups WHERE id=$1`, [row.id]);
}

/** pg_dump en formato custom (-Fc) ejecutado dentro del contenedor de la base. */
export async function backupDatabase(app: AppRow, env: EnvRow, userId: string | null, scheduled = false, notes?: string) {
  const db = await one(`SELECT * FROM databases WHERE environment_id=$1`, [env.id]);
  if (!db) throw notFound('El ambiente no tiene base de datos');
  const row = await startRow(app, env, 'database', userId, scheduled, notes, db.id);
  const dir = paths.backups(app.slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${app.slug}-${env.name}-db-${stamp()}.dump`);
  try {
    const { username } = await ownerCredentials(db.id);
    const r = await run('docker', ['exec', db.container_name, 'pg_dump', '-U', username, '-d', db.database_name, '-Fc', '--no-owner'],
      { stdoutFile: file, timeoutMs: 60 * 60_000 });
    if (r.code !== 0) throw new Error(`pg_dump falló: ${r.stderr.slice(-800)}`);
    await finish(row.id, file);
  } catch (e: any) {
    rmrf(file);
    await finish(row.id, null, e.message);
    throw e;
  }
  return one(`SELECT * FROM backups WHERE id=$1`, [row.id]);
}

export async function restoreBackup(backupId: string, user: { id: string; username: string }) {
  const b = await one(`SELECT * FROM backups WHERE id=$1`, [backupId]);
  if (!b || b.status !== 'success' || !b.file_path || !fs.existsSync(b.file_path)) throw notFound('Backup no disponible');
  if (!b.application_id || !b.environment_id) throw badRequest('La aplicación o ambiente del backup ya no existe');
  const app = await getApp(b.application_id);
  const env = (await one<EnvRow>(`SELECT * FROM application_environments WHERE id=$1`, [b.environment_id]))!;

  if (b.type === 'database') {
    const db = await one(`SELECT * FROM databases WHERE environment_id=$1`, [env.id]);
    if (!db) throw notFound('El ambiente no tiene base de datos');
    const { username } = await ownerCredentials(db.id);
    const r = await run('docker', ['exec', '-i', db.container_name, 'pg_restore', '-U', username, '-d', db.database_name,
      '--clean', '--if-exists', '--no-owner', '--single-transaction'], { stdinFile: b.file_path, timeoutMs: 60 * 60_000 });
    if (r.code !== 0) throw new Error(`pg_restore falló: ${r.stderr.slice(-800)}`);
    return { restored: 'database' };
  }

  // Restauración de aplicación: se crea una versión nueva con el código respaldado y se despliega.
  const staging = createStaging('rst');
  try {
    await runOk('tar', ['-xzf', b.file_path, '-C', staging], { timeoutMs: 30 * 60_000 });
    const manifest = JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf8'));
    if (manifest.kind !== 'ema-apphub-app-backup') throw badRequest('Archivo de backup no reconocido');
    const version = `${manifest.version.version}-restore-${stamp().slice(0, 13)}`.slice(0, 40);
    const target = paths.versionSource(app.slug, version);
    moveDir(path.join(staging, 'source'), target);
    for (const v of manifest.variables as any[]) {
      await q(`INSERT INTO environment_variables (environment_id, key, value, value_enc, is_secret, is_system) VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT (environment_id, key) DO UPDATE SET value=EXCLUDED.value, value_enc=EXCLUDED.value_enc, is_secret=EXCLUDED.is_secret, updated_at=now()`,
        [env.id, v.key, v.value, v.value_enc, v.is_secret, v.is_system]);
    }
    const ver = await one(
      `INSERT INTO application_versions (application_id, version, source_type, source_path, dockerfile, technology, build_config, env_snapshot_enc, commit_sha, comment, created_by)
       VALUES ($1,$2,'zip',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [app.id, version, target, manifest.version.dockerfile, manifest.application.technology, manifest.version.buildConfig ?? {},
       manifest.envSnapshotEnc ?? null, manifest.version.commit, `Restaurado desde backup ${path.basename(b.file_path)}`, user.id],
    );
    const dep = await enqueueDeploy({ appId: app.id, envId: env.id, versionId: ver.id, trigger: 'restore', userId: user.id, username: user.username });
    return { restored: 'app', version, deploymentId: dep.id };
  } finally {
    rmrf(staging);
  }
}

export async function deleteBackup(id: string) {
  const b = await one(`SELECT * FROM backups WHERE id=$1`, [id]);
  if (!b) throw notFound('Backup no encontrado');
  if (b.file_path) rmrf(b.file_path);
  await q(`DELETE FROM backups WHERE id=$1`, [id]);
}

/** Ejecuta un backup programado y aplica la retención. */
export async function runScheduled(scheduleId: string) {
  const s = await one(`SELECT * FROM backup_schedules WHERE id=$1 AND enabled`, [scheduleId]);
  if (!s) return;
  const env = await one<EnvRow>(`SELECT * FROM application_environments WHERE id=$1`, [s.environment_id]);
  if (!env) return;
  const app = await getApp(env.application_id);
  try {
    if (s.type === 'database') await backupDatabase(app, env, null, true, 'Programado');
    else await backupApp(app, env, null, true, 'Programado');
    await audit(null, { action: 'backup_scheduled', entityType: 'backup', app, details: { type: s.type, environment: env.name } });
  } catch (e: any) {
    await audit(null, { action: 'backup_scheduled', entityType: 'backup', app, result: 'failure', details: { error: e.message } });
    notify(backupFailedNotice({ app, env: env.name, type: s.type, error: String(e?.message || e) }));
  }
  await q(`UPDATE backup_schedules SET last_run_at=now() WHERE id=$1`, [s.id]);
  const old = await q(`SELECT id FROM backups WHERE environment_id=$1 AND type=$2 AND scheduled AND status='success'
                       ORDER BY created_at DESC OFFSET $3`, [env.id, s.type, s.retention]);
  for (const o of old) await deleteBackup(o.id);
}
