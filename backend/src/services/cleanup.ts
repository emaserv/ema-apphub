import fs from 'fs';
import { config } from '../config';
import { one, q } from '../db/pool';
import { run } from '../lib/exec';
import { audit } from './audit';
import { imageTag } from './core';
import * as dk from './docker';

/**
 * Limpieza de imágenes Docker de versiones viejas, para que el disco no se llene con el tiempo.
 * Sólo se borran IMÁGENES: la versión (código, Dockerfile, historial) queda, y si se vuelve a desplegar se recompila.
 */

export interface VersionImageInfo {
  id: string;
  createdAt: string | Date;
  /** Desplegada en algún ambiente. */
  deployed: boolean;
  /** Versión a la que volvería un rollback (el deploy exitoso anterior de algún ambiente). */
  rollbackTarget: boolean;
  /** Su código sigue en disco: se puede recompilar. */
  sourceExists: boolean;
  /** Está publicada en un registry: se puede volver a descargar. */
  pushed: boolean;
}

/** Ids de las versiones cuyas imágenes se pueden borrar sin perder nada que no se pueda recuperar. */
export function versionsToClean(versions: VersionImageInfo[], keepLatest: number): string[] {
  const newestFirst = [...versions].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return newestFirst
    .filter((v, i) => i >= keepLatest)                     // las últimas N, siempre
    .filter((v) => !v.deployed && !v.rollbackTarget)       // lo que está corriendo y su rollback, siempre
    .filter((v) => v.sourceExists || v.pushed)             // sin código ni registry, la imagen es la única copia
    .map((v) => v.id);
}

export interface CleanupResult { images: string[]; freedBytes: number; skipped: string[] }

/** Borra un tag local; si era el último de la imagen, Docker borra la imagen. Nunca fuerza (si un contenedor la usa, la deja). */
async function removeTag(tag: string, r: CleanupResult) {
  const info = await dk.imageInfo(tag);
  if (!info) return;
  try {
    const out: any[] = (await dk.docker.getImage(tag).remove()) as any;
    r.images.push(tag);
    if (Array.isArray(out) && out.some((x) => x?.Deleted)) r.freedBytes += info.size ?? 0;
  } catch (e: any) {
    if (e?.statusCode !== 404) r.skipped.push(`${tag} (${e?.statusCode === 409 ? 'en uso' : e?.message ?? e})`);
  }
}

/** Tags locales de una versión: el de AppHub y, si se publicó, el del registry. */
async function versionTags(appSlug: string, version: { id: string; version: string }): Promise<string[]> {
  const rows = await q<{ tag: string }>(`SELECT tag FROM docker_images WHERE version_id=$1`, [version.id]);
  return [...new Set([imageTag(appSlug, version.version), ...rows.map((r) => r.tag)])];
}

/** Borra las imágenes de una versión (se usa al eliminar la versión: llamar ANTES de borrar sus filas). */
export async function removeVersionImages(appSlug: string, version: { id: string; version: string }): Promise<CleanupResult> {
  const r: CleanupResult = { images: [], freedBytes: 0, skipped: [] };
  for (const tag of await versionTags(appSlug, version)) await removeTag(tag, r);
  return r;
}

/** Limpia las imágenes viejas de una app. No hace nada si la app tiene un deploy en curso. */
export async function cleanupAppImages(appId: string, keepLatest = config.imageKeepVersions): Promise<CleanupResult> {
  const r: CleanupResult = { images: [], freedBytes: 0, skipped: [] };
  const app = await one<{ id: string; slug: string; name: string }>(`SELECT id, slug, name FROM applications WHERE id=$1`, [appId]);
  if (!app) return r;
  if (await one(`SELECT 1 FROM deployments WHERE application_id=$1 AND status IN ('queued','running')`, [appId])) return r;

  const rows = await q<{ id: string; version: string; created_at: Date; source_path: string; deployed: boolean; rollback_target: boolean; pushed: boolean }>(
    `SELECT v.id, v.version, v.created_at, v.source_path,
            EXISTS (SELECT 1 FROM application_environments e WHERE e.deployed_version_id = v.id) AS deployed,
            EXISTS (SELECT 1 FROM (
                      SELECT DISTINCT ON (d.environment_id) d.version_id
                        FROM deployments d JOIN application_environments e ON e.id = d.environment_id
                       WHERE d.application_id = $1 AND d.status = 'success' AND d.version_id IS DISTINCT FROM e.deployed_version_id
                       ORDER BY d.environment_id, d.finished_at DESC) prev
                     WHERE prev.version_id = v.id) AS rollback_target,
            EXISTS (SELECT 1 FROM docker_images i WHERE i.version_id = v.id AND i.pushed) AS pushed
       FROM application_versions v WHERE v.application_id = $1`, [appId]);

  const clean = new Set(versionsToClean(rows.map((v) => ({
    id: v.id, createdAt: v.created_at, deployed: v.deployed, rollbackTarget: v.rollback_target,
    sourceExists: fs.existsSync(v.source_path), pushed: v.pushed,
  })), keepLatest));
  for (const v of rows.filter((x) => clean.has(x.id))) {
    // Se vuelve a mirar justo antes: si mientras tanto alguien lanzó un deploy de esta versión, su imagen no se toca
    if (await one(`SELECT 1 FROM deployments WHERE version_id=$1 AND status IN ('queued','running')`, [v.id])) continue;
    for (const tag of await versionTags(app.slug, v)) await removeTag(tag, r);
  }
  if (r.images.length) {
    await audit(null, { action: 'images_cleanup', entityType: 'docker', app, details: { images: r.images, freedBytes: r.freedBytes, skipped: r.skipped } });
  }
  return r;
}

export interface FullCleanupResult extends CleanupResult { danglingBytes: number; buildCache: string }

/** Limpieza completa: imágenes viejas de todas las apps, imágenes huérfanas de AppHub y caché de build de más de 7 días. */
export async function cleanupAllImages(): Promise<FullCleanupResult> {
  const total: FullCleanupResult = { images: [], freedBytes: 0, skipped: [], danglingBytes: 0, buildCache: '' };
  for (const a of await q<{ id: string }>(`SELECT id FROM applications`)) {
    const r = await cleanupAppImages(a.id).catch((e) => { console.error('[limpieza]', e.message); return null; });
    if (r) { total.images.push(...r.images); total.freedBytes += r.freedBytes; total.skipped.push(...r.skipped); }
  }
  const pruned = await dk.docker.pruneImages({ filters: { dangling: { true: true }, label: ['ema.managed=true'] } }).catch(() => null);
  total.danglingBytes = pruned?.SpaceReclaimed ?? 0;
  const cache = await run('docker', ['builder', 'prune', '-f', '--filter', 'until=168h'], { timeoutMs: 300_000 }).catch(() => null);
  total.buildCache = cache?.stdout.match(/Total reclaimed space:\s*(.+)/i)?.[1]?.trim() ?? '';
  return total;
}
