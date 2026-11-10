import cron from 'node-cron';
import fs from 'fs';
import os from 'os';
import { config } from '../config';
import { q } from '../db/pool';
import { AppRow, EnvRow, envProject } from './core';
import { runScheduled } from './backup';
import { probe } from './deploy';
import * as dk from './docker';
import { healthNotice, healthTransition, notify } from './notify';
import { cleanupTmp } from './storage';

// ───────── health checks periódicos ─────────

export async function checkEnv(app: AppRow, env: EnvRow) {
  const st = await dk.containerState(envProject(app, env));
  let status: 'healthy' | 'unhealthy';
  let res: { status?: number; ms: number; error?: string };
  if (!st?.running) {
    status = 'unhealthy';
    res = { ms: 0, error: st ? `Contenedor ${st.state}` : 'Contenedor inexistente' };
  } else {
    const r = await probe(app, env);
    status = r.ok ? 'healthy' : 'unhealthy';
    res = r;
  }
  await q(`INSERT INTO health_checks (environment_id, status, http_status, response_ms, error) VALUES ($1,$2,$3,$4,$5)`,
    [env.id, status, res.status ?? null, res.ms, res.error ?? null]);
  await q(`UPDATE application_environments SET health_status=$2, health_checked_at=now() WHERE id=$1`, [env.id, status]);
  return { status, ...res };
}

async function healthRound() {
  const envs = await q(`SELECT e.*, row_to_json(a.*) AS app FROM application_environments e JOIN applications a ON a.id=e.application_id
                        WHERE e.deployed_version_id IS NOT NULL AND e.status IN ('running','error')`);
  for (const e of envs) {
    try {
      const r = await checkEnv(e.app, e);
      // Sólo en la ronda automática (no en el chequeo manual): avisar si la app se cayó o se recuperó
      const last = await q<{ status: string }>(`SELECT status FROM health_checks WHERE environment_id=$1 ORDER BY checked_at DESC LIMIT 3`, [e.id]);
      const kind = healthTransition(last.map((h) => h.status));
      if (kind) notify(healthNotice({ app: e.app, env: e.name, kind, detail: r.error }));
    } catch (err) { console.error('[health]', (err as Error).message); }
  }
  await q(`DELETE FROM health_checks WHERE checked_at < now() - interval '7 days'`);
  await q(`DELETE FROM notifications WHERE created_at < now() - interval '90 days'`);
}

// ───────── sincronización de estado de contenedores ─────────

async function syncStatus() {
  const envs = await q(`SELECT e.id, e.name, e.status, a.slug FROM application_environments e JOIN applications a ON a.id=e.application_id
                        WHERE e.deployed_version_id IS NOT NULL AND e.status <> 'deploying'`);
  for (const e of envs) {
    const name = `ema-${e.slug}-${e.name}`;
    const st = await dk.containerState(name);
    for (const [svc, cname] of [['app', name], ['db', `${name}-db`]] as const) {
      const s = svc === 'app' ? st : await dk.containerState(cname);
      if (s) {
        await q(`INSERT INTO containers (environment_id, service, container_id, name, image, state, status_text, updated_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,now())
                 ON CONFLICT (environment_id, service) DO UPDATE SET container_id=EXCLUDED.container_id, image=EXCLUDED.image,
                   state=EXCLUDED.state, status_text=EXCLUDED.status_text, updated_at=now()`,
          [e.id, svc, s.id, cname, s.image, s.state, s.health ?? s.state]);
      } else {
        await q(`DELETE FROM containers WHERE environment_id=$1 AND service=$2`, [e.id, svc]);
      }
    }
    const newStatus = !st ? (e.status === 'stopped' ? 'stopped' : 'error') : st.running ? (st.state === 'restarting' ? 'error' : 'running') : st.exitCode === 0 || e.status === 'stopped' ? 'stopped' : 'error';
    if (newStatus !== e.status) await q(`UPDATE application_environments SET status=$2, updated_at=now() WHERE id=$1`, [e.id, newStatus]);
  }
  await q(`UPDATE databases d SET status = CASE WHEN c.state='running' THEN 'running' ELSE COALESCE(c.state,'stopped') END
           FROM containers c WHERE c.environment_id=d.environment_id AND c.service='db' AND d.status <> 'creating'`);
}

// ───────── métricas del host ─────────

let lastCpu = os.cpus().map((c) => c.times);
let cpuPercent = 0;
function sampleCpu() {
  const now = os.cpus().map((c) => c.times);
  let idle = 0, total = 0;
  now.forEach((t, i) => {
    const p = lastCpu[i] || t;
    const d = (k: keyof typeof t) => t[k] - p[k];
    const tot = d('user') + d('nice') + d('sys') + d('irq') + d('idle');
    idle += d('idle'); total += tot;
  });
  lastCpu = now;
  if (total > 0) cpuPercent = Math.round((1 - idle / total) * 1000) / 10;
}

export function hostMetrics() {
  let disk = { total: 0, free: 0, used: 0 };
  try {
    const s = fs.statfsSync(config.dataDir);
    disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize, used: (s.blocks - s.bfree) * s.bsize };
  } catch { /* ignore */ }
  const total = os.totalmem();
  // En Linux, MemAvailable es más preciso que freemem()
  let available = os.freemem();
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/);
    if (m) available = Number(m[1]) * 1024;
  } catch { /* ignore */ }
  return {
    cpu: { percent: cpuPercent, cores: os.cpus().length, load: os.loadavg() },
    memory: { total, used: total - available, percent: Math.round(((total - available) / total) * 1000) / 10 },
    disk: { ...disk, percent: disk.total ? Math.round((disk.used / disk.total) * 1000) / 10 : 0 },
    uptime: os.uptime(),
  };
}

// ───────── programación ─────────

const scheduled = new Map<string, cron.ScheduledTask>();

export async function reloadBackupSchedules() {
  scheduled.forEach((t) => t.stop());
  scheduled.clear();
  const rows = await q(`SELECT id, cron FROM backup_schedules WHERE enabled`);
  for (const r of rows) {
    if (!cron.validate(r.cron)) { console.warn(`[cron] expresión inválida ${r.cron}`); continue; }
    scheduled.set(r.id, cron.schedule(r.cron, () => void runScheduled(r.id), { timezone: process.env.TZ || 'America/Argentina/Buenos_Aires' }));
  }
}

export async function startMonitors() {
  setInterval(sampleCpu, 5000);
  setInterval(() => void syncStatus().catch((e) => console.error('[sync]', e.message)), 20_000);
  setInterval(() => void healthRound().catch((e) => console.error('[health]', e.message)), config.healthIntervalSec * 1000);
  setInterval(cleanupTmp, 3600_000);
  // deploys que quedaron "colgados" por un reinicio del backend
  await q(`UPDATE deployments SET status='failed', error='Interrumpido por reinicio de la plataforma', finished_at=now() WHERE status IN ('queued','running')`);
  await q(`UPDATE application_environments SET status='error' WHERE status='deploying'`);
  await reloadBackupSchedules();
}
