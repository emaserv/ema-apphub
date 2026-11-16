import cookie from 'cookie';
import { IncomingMessage, Server } from 'http';
import { PassThrough } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';
import { config } from '../config';
import { notFound } from '../lib/http';
import { AUTH_COOKIE, AuthUser, can, userFromToken } from '../middleware/auth';
import { canSeeApp } from '../services/appAccess';
import { audit } from '../services/audit';
import { envProject, getApp, getEnv } from '../services/core';
import * as dk from '../services/docker';
import { setSocketApp, trackSocket } from '../services/liveSockets';

const send = (ws: WebSocket, msg: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

/** Evita Cross-Site WebSocket Hijacking: el Origin debe coincidir con el Host o con CORS_ORIGINS. */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
    return o.host === host || config.corsOrigins.includes(origin);
  } catch {
    return false;
  }
}

export function attachWebSockets(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://x');
    if (!url.pathname.startsWith('/ws/') || !originAllowed(req)) { socket.destroy(); return; }
    const token = cookie.parse(req.headers.cookie || '')[AUTH_COOKIE];
    const user = await userFromToken(token);
    if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      trackSocket(user.id, ws); // para cortarlo si se cierran las sesiones del usuario
      const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.socket.remoteAddress || '';
      const fakeReq: any = { user, ip, socket: req.socket };
      if (url.pathname === '/ws/logs') void handleLogs(ws, url, user, fakeReq);
      else if (url.pathname === '/ws/terminal') void handleTerminal(ws, url, user, fakeReq);
      else ws.close(1008, 'Ruta inválida');
    });
  });
}

/** Resuelve la app y el ambiente pedidos; una app no asignada al usuario se trata como inexistente. */
async function resolveTarget(url: URL, user: AuthUser, ws: WebSocket) {
  const ref = url.searchParams.get('app') || '';
  if (!(await canSeeApp(user, ref))) throw notFound('Aplicación no encontrada');
  const app = await getApp(ref);
  setSocketApp(ws, app.id); // para cortarlo si le quitan el acceso a esta app
  const env = await getEnv(app.id, url.searchParams.get('environment'));
  const service = url.searchParams.get('service') === 'db' ? 'db' : 'app';
  return { app, env, service, container: envProject(app, env) + (service === 'db' ? '-db' : '') };
}

async function handleLogs(ws: WebSocket, url: URL, user: AuthUser, _req: any) {
  if (!can(user, 'apps.logs')) { send(ws, { type: 'error', message: 'Sin permiso para ver logs' }); return ws.close(); }
  try {
    const { container } = await resolveTarget(url, user, ws);
    const m = await dk.getManagedContainer(container);
    if (!m) { send(ws, { type: 'error', message: `El contenedor ${container} no existe (¿ya se desplegó?)` }); return ws.close(); }
    const tail = Math.min(Number(url.searchParams.get('tail')) || 300, 5000);
    const stream = (await m.container.logs({ follow: true, stdout: true, stderr: true, timestamps: true, tail })) as unknown as NodeJS.ReadableStream & { destroy: () => void };
    const out = new PassThrough();
    if (m.info.Config.Tty) stream.pipe(out); else dk.docker.modem.demuxStream(stream, out, out);
    let buf = '';
    out.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      if (lines.length) send(ws, { type: 'lines', lines });
    });
    stream.on('end', () => { send(ws, { type: 'end' }); ws.close(); });
    send(ws, { type: 'ready', container });
    ws.on('close', () => stream.destroy());
  } catch (e: any) {
    send(ws, { type: 'error', message: e.message });
    ws.close();
  }
}

async function handleTerminal(ws: WebSocket, url: URL, user: AuthUser, req: any) {
  if (!config.terminalEnabled || !can(user, 'terminal.access')) {
    send(ws, { type: 'error', message: 'Terminal deshabilitada o sin permiso (terminal.access)' });
    return ws.close();
  }
  let target: Awaited<ReturnType<typeof resolveTarget>>;
  try { target = await resolveTarget(url, user, ws); } catch (e: any) { send(ws, { type: 'error', message: e.message }); return ws.close(); }
  const m = await dk.getManagedContainer(target.container).catch(() => null);
  if (!m || !m.info.State.Running) { send(ws, { type: 'error', message: 'El contenedor no está en ejecución' }); return ws.close(); }

  const exec = await m.container.exec({
    Cmd: ['/bin/sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'],
    AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true, Env: ['TERM=xterm-256color'],
  });
  const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
  await audit(req, { action: 'terminal_open', entityType: 'container', entityId: target.container, app: target.app, details: { environment: target.env.name, service: target.service } });

  let idle: NodeJS.Timeout;
  const resetIdle = () => { clearTimeout(idle); idle = setTimeout(() => ws.close(4000, 'Inactividad'), 30 * 60 * 1000); };
  resetIdle();
  let typed = '';
  stream.on('data', (d: Buffer) => ws.readyState === WebSocket.OPEN && ws.send(d.toString('utf8')));
  stream.on('end', () => ws.close());
  ws.on('message', async (raw) => {
    resetIdle();
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'input' && typeof msg.data === 'string') {
        stream.write(msg.data);
        typed += msg.data;
        if (typed.length > 20000) typed = typed.slice(-20000);
      } else if (msg.type === 'resize') {
        await exec.resize({ h: Math.max(5, Math.min(300, msg.rows | 0)), w: Math.max(20, Math.min(500, msg.cols | 0)) }).catch(() => undefined);
      }
    } catch { /* mensaje inválido */ }
  });
  ws.on('close', async () => {
    clearTimeout(idle);
    stream.end();
    // registro de comandos de la sesión (texto tecleado, sin secuencias de control)
    const commands = typed.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r|\n/).map((s) => s.trim()).filter(Boolean).slice(-200);
    await audit(req, { action: 'terminal_close', entityType: 'container', entityId: target.container, app: target.app, details: { commands } });
  });
}
