/**
 * Permisos por aplicación. El rol dice QUÉ puede hacer un usuario; la asignación dice EN QUÉ apps.
 * - Superadmin y Admin ven todas las aplicaciones.
 * - Desarrollador y Consulta ven sólo las asignadas (tabla user_applications), salvo que tengan all_apps.
 * Una app sin acceso se responde como "no encontrada" (404), para no revelar que existe.
 */
import { NextFunction, Request, Response } from 'express';
import { one, q } from '../db/pool';
import { notFound } from '../lib/http';

/** Roles que ven todas las aplicaciones sin necesidad de asignación. */
export const UNRESTRICTED_ROLES = ['superadmin', 'admin'];
/** Roles que se limitan a sus aplicaciones asignadas. */
export const RESTRICTED_ROLES = ['developer', 'viewer'];

export const seesAllApps = (role: string, allAppsFlag: boolean) => UNRESTRICTED_ROLES.includes(role) || allAppsFlag;

interface ScopedUser { id: string; seesAllApps: boolean }

/** IDs de las apps que puede ver el usuario; `null` = todas (no hace falta filtrar). */
export async function visibleAppIds(user: ScopedUser): Promise<string[] | null> {
  if (user.seesAllApps) return null;
  return (await q<{ application_id: string }>(`SELECT application_id FROM user_applications WHERE user_id=$1`, [user.id])).map((r) => r.application_id);
}

/** Igual que visibleAppIds pero con los slugs (los contenedores e imágenes Docker se etiquetan con el slug). */
export async function visibleAppSlugs(user: ScopedUser): Promise<Set<string> | null> {
  if (user.seesAllApps) return null;
  return new Set((await q<{ slug: string }>(
    `SELECT a.slug FROM user_applications ua JOIN applications a ON a.id=ua.application_id WHERE ua.user_id=$1`, [user.id])).map((r) => r.slug));
}

/** ¿El usuario puede ver la app (por id o slug)? Si la app no existe y el usuario ve todas, devuelve true y la ruta responde 404. */
export async function canSeeApp(user: ScopedUser, idOrSlug: string): Promise<boolean> {
  if (user.seesAllApps) return true;
  return !!(await one(
    `SELECT 1 FROM user_applications ua JOIN applications a ON a.id=ua.application_id
      WHERE ua.user_id=$1 AND (a.id::text=$2 OR a.slug=$2)`, [user.id, idOrSlug]));
}

/** Para `router.param('id', appAccessParam)`: corta con 404 cualquier ruta /applications/:id de una app no asignada. */
export async function appAccessParam(req: Request, _res: Response, next: NextFunction, id: string) {
  try {
    if (!req.user || !(await canSeeApp(req.user, id))) return next(notFound('Aplicación no encontrada'));
    next();
  } catch (e) {
    next(e);
  }
}

/** Asigna la app al usuario (no falla si ya estaba asignada). */
export async function grantApp(userId: string, appId: string, byUserId: string | null) {
  await q(`INSERT INTO user_applications (user_id, application_id, created_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [userId, appId, byUserId]);
}
