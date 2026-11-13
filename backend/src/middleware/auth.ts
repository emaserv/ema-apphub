import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { one, q } from '../db/pool';
import { HttpError } from '../lib/http';

export interface AuthUser {
  id: string;
  username: string;
  fullName: string;
  email: string;
  role: string;
  roleName: string;
  permissions: string[];
  mustChangePassword: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { user?: AuthUser }
  }
}

export const AUTH_COOKIE = 'ema_session';
export const CSRF_COOKIE = 'ema_csrf';

/** `sv` = session_version del usuario al emitir el token: si después cambia, el token deja de valer. */
export function signToken(userId: string, sessionVersion: number): string {
  return jwt.sign({ sub: userId, sv: sessionVersion }, config.jwtSecret, { expiresIn: `${config.jwtExpiresHours}h`, issuer: 'ema-apphub' });
}

export function issueSession(res: Response, userId: string, sessionVersion: number) {
  const maxAge = config.jwtExpiresHours * 3600 * 1000;
  res.cookie(AUTH_COOKIE, signToken(userId, sessionVersion), { httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, maxAge, path: '/' });
  res.cookie(CSRF_COOKIE, crypto.randomBytes(24).toString('hex'), { httpOnly: false, sameSite: 'strict', secure: config.cookieSecure, maxAge, path: '/' });
}

/** Invalida todas las sesiones abiertas del usuario y devuelve la nueva versión. */
export async function revokeSessions(userId: string): Promise<number> {
  const r = await one(`UPDATE users SET session_version = session_version + 1 WHERE id=$1 RETURNING session_version`, [userId]);
  return r?.session_version ?? 0;
}

export function clearSession(res: Response) {
  res.clearCookie(AUTH_COOKIE, { path: '/' });
  res.clearCookie(CSRF_COOKIE, { path: '/' });
}

/** Con `sessionVersion`, además exige que coincida con la del usuario (sesión no cerrada desde entonces). */
export async function loadUser(userId: string, sessionVersion?: number): Promise<AuthUser | null> {
  const u = await one(
    `SELECT u.id, u.username, u.full_name, u.email, u.active, u.must_change_password, u.session_version, r.code AS role, r.name AS role_name
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
    [userId],
  );
  if (!u || !u.active) return null;
  if (sessionVersion !== undefined && sessionVersion !== u.session_version) return null;
  const perms = await q<{ code: string }>(
    `SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
      JOIN users u ON u.role_id = rp.role_id WHERE u.id = $1`,
    [userId],
  );
  return {
    id: u.id, username: u.username, fullName: u.full_name, email: u.email,
    role: u.role, roleName: u.role_name, permissions: perms.map((p) => p.code),
    mustChangePassword: u.must_change_password,
  };
}

export async function userFromToken(token?: string): Promise<AuthUser | null> {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret, { issuer: 'ema-apphub' }) as { sub: string; sv?: number };
    // Tokens emitidos antes de esta versión no traen `sv`: valen como versión 0 hasta que venzan
    return await loadUser(payload.sub, payload.sv ?? 0);
  } catch {
    return null;
  }
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    const token = req.cookies?.[AUTH_COOKIE] || (header?.startsWith('Bearer ') ? header.slice(7) : undefined);
    const user = await userFromToken(token);
    if (!user) return next(new HttpError(401, 'No autenticado'));
    // CSRF: doble token para requests con cookie que modifican estado
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (mutating && req.cookies?.[AUTH_COOKIE]) {
      const sent = req.header('x-csrf-token');
      const expected = req.cookies?.[CSRF_COOKIE];
      if (!sent || !expected || sent.length !== expected.length ||
          !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected))) {
        return next(new HttpError(403, 'Token CSRF inválido'));
      }
    }
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

export const can = (user: AuthUser | undefined, perm: string) => !!user && user.permissions.includes(perm);

export function requirePerm(...perms: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, 'No autenticado'));
    if (!perms.some((p) => req.user!.permissions.includes(p))) return next(new HttpError(403, `Requiere permiso: ${perms.join(' o ')}`));
    next();
  };
}

/** Permiso de deploy según ambiente (producción requiere apps.deploy.prod). */
export function assertDeployPerm(user: AuthUser | undefined, envName: string) {
  const need = envName === 'production' ? 'apps.deploy.prod' : 'apps.deploy.nonprod';
  if (!can(user, need) && !can(user, 'apps.deploy.prod')) throw new HttpError(403, `Requiere permiso: ${need}`);
}
