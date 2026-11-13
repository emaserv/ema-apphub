import crypto from 'crypto';
import Docker from 'dockerode';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from '../config';
import { run, runOk } from '../lib/exec';
import { HttpError } from '../lib/http';
import { TRIVY_IMAGE } from './imageVersions';

/**
 * ÚNICO punto de acceso al runtime de contenedores.
 * - Lecturas y operaciones simples → dockerode (API del socket).
 * - Build / compose / push → Docker CLI ejecutado sin shell.
 * Las operaciones sólo afectan contenedores con label ema.managed=true.
 * Para multi-host o Kubernetes se reemplaza este módulo por otro driver.
 */
export const docker = new Docker(process.env.DOCKER_HOST?.startsWith('tcp://')
  ? { host: new URL(process.env.DOCKER_HOST).hostname, port: Number(new URL(process.env.DOCKER_HOST).port || 2375) }
  : { socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });

const BUILD_TIMEOUT = () => config.buildTimeoutMin * 60_000;

export async function ping(): Promise<boolean> {
  try { await docker.ping(); return true; } catch { return false; }
}

export async function ensureNetwork(name = config.appsNetwork) {
  const nets = await docker.listNetworks({ filters: { name: [name] } });
  if (!nets.some((n) => n.Name === name)) await docker.createNetwork({ Name: name, Driver: 'bridge', Labels: { 'ema.managed': 'true' } });
}

export async function imageExists(tag: string): Promise<boolean> {
  try { await docker.getImage(tag).inspect(); return true; } catch { return false; }
}

export async function imageInfo(tag: string) {
  try { const i = await docker.getImage(tag).inspect(); return { id: i.Id, size: i.Size }; } catch { return null; }
}

export async function buildImage(sourceDir: string, tag: string, onLine: (l: string) => void, labels: Record<string, string> = {}) {
  const args = ['build', '--progress=plain', '-t', tag, '-f', path.join(sourceDir, 'Dockerfile')];
  for (const [k, v] of Object.entries({ 'ema.managed': 'true', ...labels })) args.push('--label', `${k}=${v}`);
  args.push(sourceDir);
  await runOk('docker', args, { onLine, timeoutMs: BUILD_TIMEOUT(), env: { DOCKER_BUILDKIT: '1' } });
}

export async function compose(projectDir: string, project: string, args: string[], onLine?: (l: string) => void) {
  return runOk('docker', ['compose', '--project-directory', projectDir, '-f', path.join(projectDir, 'docker-compose.yml'), '-p', project, ...args],
    { onLine, timeoutMs: BUILD_TIMEOUT() });
}

export async function composeValidate(projectDir: string, project: string) {
  const r = await run('docker', ['compose', '--project-directory', projectDir, '-f', path.join(projectDir, 'docker-compose.yml'), '-p', project, 'config', '-q']);
  if (r.code !== 0) throw new Error(`docker-compose.yml inválido: ${r.stderr.slice(-800)}`);
}

export async function runTests(image: string, command: string, onLine: (l: string) => void) {
  await runOk('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'sh', image, '-c', command], { onLine, timeoutMs: BUILD_TIMEOUT() });
}

export async function registryLogin(url: string, username: string, password: string) {
  await runOk('docker', ['login', url, '-u', username, '--password-stdin'], { input: password, timeoutMs: 60_000 });
}

export async function tagAndPush(source: string, target: string, onLine: (l: string) => void) {
  await runOk('docker', ['tag', source, target]);
  await runOk('docker', ['push', target], { onLine, timeoutMs: BUILD_TIMEOUT() });
}

export async function pullImage(tag: string, onLine: (l: string) => void) {
  await runOk('docker', ['pull', tag], { onLine, timeoutMs: BUILD_TIMEOUT() });
}

/** Volumen donde Trivy guarda su base de vulnerabilidades (se descarga una vez y se actualiza sola). */
const TRIVY_CACHE_VOLUME = 'ema-apphub-trivy-cache';

/**
 * Escanea una imagen con Trivy y devuelve el reporte JSON.
 * La imagen se exporta con `docker save` y se copia dentro del contenedor de Trivy: así Trivy
 * NO recibe acceso al socket de Docker (no puede tocar otros contenedores ni el servidor).
 */
export async function scanImage(image: string): Promise<string> {
  const id = crypto.randomUUID();
  const tar = path.join(os.tmpdir(), `ema-scan-${id}.tar`);
  const name = `ema-trivy-${id}`;
  try {
    await runOk('docker', ['save', '-o', tar, image], { timeoutMs: BUILD_TIMEOUT() });
    await runOk('docker', [
      'create', '--name', name, '-v', `${TRIVY_CACHE_VOLUME}:/root/.cache/trivy`, TRIVY_IMAGE,
      'image', '--input', '/tmp/image.tar', '--format', 'json', '--severity', 'HIGH,CRITICAL', '--scanners', 'vuln', '--quiet', '--timeout', '15m',
    ]);
    await runOk('docker', ['cp', tar, `${name}:/tmp/image.tar`], { timeoutMs: BUILD_TIMEOUT() });
    const r = await runOk('docker', ['start', '-a', name], { timeoutMs: BUILD_TIMEOUT() });
    return r.stdout;
  } finally {
    fs.rmSync(tar, { force: true });
    await run('docker', ['rm', '-f', name]).catch(() => undefined);
  }
}

// ───────── contenedores ─────────

export async function getManagedContainer(nameOrId: string) {
  const c = docker.getContainer(nameOrId);
  let info: Docker.ContainerInspectInfo;
  try { info = await c.inspect(); } catch { return null; }
  if (info.Config.Labels?.['ema.managed'] !== 'true') throw new HttpError(403, 'El contenedor no es administrado por EMA AppHub');
  return { container: c, info };
}

export async function containerState(name: string) {
  try {
    const info = await docker.getContainer(name).inspect();
    return {
      id: info.Id.slice(0, 12), name: info.Name.replace(/^\//, ''), image: info.Config.Image,
      state: info.State.Status, running: info.State.Running, startedAt: info.State.StartedAt,
      restartCount: info.RestartCount, health: info.State.Health?.Status ?? null,
      exitCode: info.State.ExitCode, error: info.State.Error || null,
    };
  } catch {
    return null;
  }
}

export async function listManaged(extra: Record<string, string> = {}) {
  const label = ['ema.managed=true', ...Object.entries(extra).map(([k, v]) => `${k}=${v}`)];
  return docker.listContainers({ all: true, filters: { label } });
}

export async function containerAction(nameOrId: string, action: 'start' | 'stop' | 'restart' | 'remove') {
  const m = await getManagedContainer(nameOrId);
  if (!m) throw new HttpError(404, 'Contenedor no encontrado');
  if (action === 'start') await m.container.start().catch(ignoreNotModified);
  if (action === 'stop') await m.container.stop({ t: 15 }).catch(ignoreNotModified);
  if (action === 'restart') await m.container.restart({ t: 15 });
  if (action === 'remove') await m.container.remove({ force: true });
}
function ignoreNotModified(e: any) { if (e?.statusCode !== 304) throw e; }

export async function containerStats(name: string) {
  try {
    const s: any = await docker.getContainer(name).stats({ stream: false });
    const cpuDelta = s.cpu_stats.cpu_usage.total_usage - (s.precpu_stats.cpu_usage?.total_usage ?? 0);
    const sysDelta = s.cpu_stats.system_cpu_usage - (s.precpu_stats.system_cpu_usage ?? 0);
    const cpus = s.cpu_stats.online_cpus || s.cpu_stats.cpu_usage.percpu_usage?.length || 1;
    const cpu = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;
    const cache = s.memory_stats.stats?.inactive_file ?? s.memory_stats.stats?.cache ?? 0;
    const mem = Math.max(0, (s.memory_stats.usage ?? 0) - cache);
    let rx = 0, tx = 0;
    for (const n of Object.values<any>(s.networks || {})) { rx += n.rx_bytes; tx += n.tx_bytes; }
    return { cpuPercent: Math.round(cpu * 10) / 10, memoryBytes: mem, memoryLimitBytes: s.memory_stats.limit ?? 0, netRxBytes: rx, netTxBytes: tx };
  } catch {
    return null;
  }
}

export async function containerLogs(name: string, opts: { tail?: number; since?: number; until?: number; timestamps?: boolean }) {
  const m = await getManagedContainer(name);
  if (!m) throw new HttpError(404, 'Contenedor no encontrado');
  const buf = (await m.container.logs({
    stdout: true, stderr: true, follow: false, timestamps: opts.timestamps ?? true,
    tail: opts.tail ?? 1000, since: opts.since, until: opts.until,
  })) as unknown as Buffer;
  return demux(buf, m.info.Config.Tty);
}

/** Decodifica el stream multiplexado de Docker (cabecera de 8 bytes) a texto. */
export function demux(buf: Buffer, tty: boolean): string {
  if (tty) return buf.toString('utf8');
  let out = '';
  let i = 0;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4);
    out += buf.subarray(i + 8, i + 8 + len).toString('utf8');
    i += 8 + len;
  }
  return out || buf.toString('utf8');
}

export async function execIn(container: string, cmd: string[], input?: string) {
  const args = ['exec', ...(input !== undefined ? ['-i'] : []), container, ...cmd];
  return run('docker', args, { input, timeoutMs: 120_000 });
}

export async function removeVolume(name: string) {
  try { await docker.getVolume(name).remove({ force: true }); } catch (e: any) { if (e?.statusCode !== 404) throw e; }
}

export async function info() {
  const [i, imgs] = await Promise.all([docker.info(), docker.listImages({ filters: { label: ['ema.managed=true'] } })]);
  return {
    serverVersion: i.ServerVersion, os: i.OperatingSystem, cpus: i.NCPU, memTotal: i.MemTotal,
    containers: i.Containers, running: i.ContainersRunning, stopped: i.ContainersStopped, images: i.Images,
    managedImages: imgs.length, storageDriver: i.Driver,
  };
}
