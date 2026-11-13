import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { one, q } from '../db/pool';
import { ah, badRequest, conflict, HttpError, notFound, parse } from '../lib/http';
import { AUTH_COOKIE, authenticate, clearSession, issueSession, requirePerm, revokeSessions, userFromToken } from '../middleware/auth';
import { audit } from '../services/audit';

export const publicAuth = Router();
export const privateAuth = Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espere 15 minutos.' }, skipSuccessfulRequests: true });

const PASSWORD = z.string().min(10, 'Mínimo 10 caracteres').max(200)
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Debe contener letras y números');

publicAuth.post('/auth/login', loginLimiter, ah(async (req, res) => {
  const b = parse(z.object({ username: z.string().min(1).max(160), password: z.string().min(1).max(200) }), req.body);
  const u = await one(`SELECT * FROM users WHERE lower(username)=lower($1) OR lower(email)=lower($1)`, [b.username]);
  const ok = u && u.active && (await bcrypt.compare(b.password, u.password_hash));
  if (!ok) {
    await audit(req, { action: 'login', entityType: 'user', result: 'failure', details: { username: b.username } }, u ? { id: u.id, username: u.username } : { id: null as any, username: b.username });
    throw new HttpError(401, 'Usuario o contraseña incorrectos');
  }
  await q(`UPDATE users SET last_login_at=now() WHERE id=$1`, [u.id]);
  issueSession(res, u.id, u.session_version);
  await audit(req, { action: 'login', entityType: 'user', entityId: u.id }, { id: u.id, username: u.username });
  res.json({ ok: true, mustChangePassword: u.must_change_password });
}));

// Cierra TODAS las sesiones del usuario (todos los navegadores), no sólo borra la cookie de éste:
// así un token copiado deja de servir. Es pública para que siempre se pueda limpiar la cookie.
publicAuth.post('/auth/logout', ah(async (req, res) => {
  const user = await userFromToken(req.cookies?.[AUTH_COOKIE]);
  if (user) {
    await revokeSessions(user.id);
    await audit(req, { action: 'logout', entityType: 'user', entityId: user.id }, { id: user.id, username: user.username });
  }
  clearSession(res);
  res.json({ ok: true });
}));

privateAuth.get('/auth/me', (req, res) => res.json(req.user));

privateAuth.post('/auth/change-password', ah(async (req, res) => {
  const b = parse(z.object({ currentPassword: z.string(), newPassword: PASSWORD }), req.body);
  const u = await one(`SELECT password_hash FROM users WHERE id=$1`, [req.user!.id]);
  if (!(await bcrypt.compare(b.currentPassword, u.password_hash))) throw badRequest('La contraseña actual no es correcta');
  await q(`UPDATE users SET password_hash=$2, must_change_password=false, updated_at=now() WHERE id=$1`, [req.user!.id, await bcrypt.hash(b.newPassword, 12)]);
  // Cierra las sesiones de otros navegadores y renueva la de éste para no echar al usuario
  issueSession(res, req.user!.id, await revokeSessions(req.user!.id));
  await audit(req, { action: 'password_change', entityType: 'user', entityId: req.user!.id });
  res.json({ ok: true });
}));

// ───────── usuarios ─────────

privateAuth.get('/roles', ah(async (_req, res) => {
  res.json(await q(`SELECT r.id, r.code, r.name, r.description,
                           COALESCE(array_agg(p.code ORDER BY p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
                      FROM roles r LEFT JOIN role_permissions rp ON rp.role_id=r.id LEFT JOIN permissions p ON p.id=rp.permission_id
                     GROUP BY r.id ORDER BY r.id`));
}));

privateAuth.get('/permissions', requirePerm('users.manage'), ah(async (_req, res) => {
  res.json(await q(`SELECT code, description FROM permissions ORDER BY code`));
}));

privateAuth.get('/users', requirePerm('users.manage'), ah(async (_req, res) => {
  res.json(await q(`SELECT u.id, u.username, u.email, u.full_name, u.active, u.last_login_at, u.created_at, r.code AS role, r.name AS role_name
                      FROM users u JOIN roles r ON r.id=u.role_id ORDER BY u.full_name`));
}));

const ROLE = z.enum(['superadmin', 'admin', 'developer', 'viewer']);

privateAuth.post('/users', requirePerm('users.manage'), ah(async (req, res) => {
  const b = parse(z.object({ username: z.string().regex(/^[a-zA-Z0-9._-]{3,60}$/), email: z.string().email(), fullName: z.string().min(2).max(160),
    role: ROLE, password: PASSWORD }), req.body);
  if (await one(`SELECT 1 FROM users WHERE lower(username)=lower($1) OR lower(email)=lower($2)`, [b.username, b.email])) throw conflict('Usuario o email existente');
  const u = await one(`INSERT INTO users (username, email, full_name, password_hash, role_id, must_change_password)
                       VALUES ($1,$2,$3,$4,(SELECT id FROM roles WHERE code=$5), true) RETURNING id, username, email, full_name`,
    [b.username, b.email, b.fullName, await bcrypt.hash(b.password, 12), b.role]);
  await audit(req, { action: 'user_create', entityType: 'user', entityId: u.id, details: { username: b.username, role: b.role } });
  res.status(201).json(u);
}));

privateAuth.put('/users/:uid', requirePerm('users.manage'), ah(async (req, res) => {
  const b = parse(z.object({ email: z.string().email().optional(), fullName: z.string().min(2).max(160).optional(), role: ROLE.optional(),
    active: z.boolean().optional(), password: PASSWORD.optional() }), req.body);
  const u = await one(`SELECT u.*, r.code AS role FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=$1`, [req.params.uid]);
  if (!u) throw notFound('Usuario no encontrado');
  if (u.id === req.user!.id && (b.active === false || (b.role && b.role !== u.role))) throw badRequest('No puede desactivarse ni cambiarse el rol a sí mismo');
  if (u.role === 'superadmin' && (b.active === false || (b.role && b.role !== 'superadmin'))) {
    const n = await one(`SELECT count(*)::int AS n FROM users u JOIN roles r ON r.id=u.role_id WHERE r.code='superadmin' AND u.active`);
    if (n.n <= 1) throw badRequest('Debe existir al menos un Super Administrador activo');
  }
  await q(`UPDATE users SET email=COALESCE($2,email), full_name=COALESCE($3,full_name), role_id=COALESCE((SELECT id FROM roles WHERE code=$4), role_id),
             active=COALESCE($5,active), password_hash=COALESCE($6,password_hash), must_change_password = must_change_password OR $7, updated_at=now() WHERE id=$1`,
    [u.id, b.email ?? null, b.fullName ?? null, b.role ?? null, b.active ?? null, b.password ? await bcrypt.hash(b.password, 12) : null, !!b.password]);
  // Contraseña reseteada o usuario desactivado: se cierran sus sesiones abiertas
  if (b.password || b.active === false) {
    const sv = await revokeSessions(u.id);
    if (u.id === req.user!.id) issueSession(res, u.id, sv); // un admin que resetea su propia contraseña sigue conectado
  }
  await audit(req, { action: 'user_update', entityType: 'user', entityId: u.id, details: { ...b, password: b.password ? '(reset)' : undefined } });
  res.json({ ok: true });
}));

privateAuth.delete('/users/:uid', requirePerm('users.manage'), ah(async (req, res) => {
  if (req.params.uid === req.user!.id) throw badRequest('No puede eliminarse a sí mismo');
  const u = await one(`SELECT username FROM users WHERE id=$1`, [req.params.uid]);
  if (!u) throw notFound('Usuario no encontrado');
  await q(`UPDATE users SET active=false, updated_at=now() WHERE id=$1`, [req.params.uid]);
  await revokeSessions(req.params.uid);
  await audit(req, { action: 'user_disable', entityType: 'user', entityId: req.params.uid, details: { username: u.username } });
  res.json({ ok: true });
}));

export { authenticate };
