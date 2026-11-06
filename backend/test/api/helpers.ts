import './env'; // debe ir primero (ver env.ts)
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import http from 'http';
import { AddressInfo } from 'net';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { migrate } from '../../src/db/migrate';
import { one, pool } from '../../src/db/pool';

export { one, pool };

export const ADMIN = { username: 'admin', password: process.env.ADMIN_PASSWORD! };
export type Role = 'superadmin' | 'admin' | 'developer' | 'viewer';
export interface Session { cookie: string; csrf: string }

let server: http.Server;
let base = '';

/** Base vacía + migraciones + API escuchando en un puerto libre. */
export async function start() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}

export async function stop() {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  fs.rmSync(config.dataDir, { recursive: true, force: true });
}

/**
 * Llama a la API. Con `session` manda la cookie y, si el método modifica datos, el token CSRF
 * (`csrf: false` lo omite y `csrf: 'otro'` manda uno distinto, para probar la protección).
 */
export async function api(method: string, path: string, opts: { body?: unknown; session?: Session; csrf?: string | false; token?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.session) {
    headers.cookie = opts.session.cookie;
    if (method !== 'GET' && opts.csrf !== false) headers['x-csrf-token'] = opts.csrf ?? opts.session.csrf;
  }
  const res = await fetch(base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* texto plano (p. ej. export .env) */ }
  return { status: res.status, body, headers: res.headers };
}

/** Inicia sesión por la API y devuelve las cookies como las guardaría el navegador. */
export async function login(username: string, password: string): Promise<Session> {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login de ${username} falló`);
  const pairs = res.headers.getSetCookie().map((c) => c.split(';')[0]);
  const csrf = pairs.find((p) => p.startsWith('ema_csrf='))?.slice('ema_csrf='.length);
  assert.ok(csrf, 'el login no devolvió la cookie CSRF');
  return { cookie: pairs.join('; '), csrf };
}

/** Crea un usuario directo en la base (hash rápido: sólo para tests). */
export async function createUser(role: Role, username = `${role}1`, password = 'Clave12345x') {
  const u = await one(
    `INSERT INTO users (username, email, full_name, password_hash, role_id, must_change_password)
     VALUES ($1, $2, $3, $4, (SELECT id FROM roles WHERE code = $5), false) RETURNING id`,
    [username, `${username}@test.local`, `Usuario ${role}`, await bcrypt.hash(password, 4), role],
  );
  return { id: u.id as string, username, password };
}

/** Datos mínimos válidos para crear una aplicación sin código ni deploy (no toca Docker). */
export const newApp = (name: string, extra: Record<string, unknown> = {}) => ({
  name, technology: 'node', internalPort: 3000, environment: { name: 'production', externalPort: null }, ...extra,
});
