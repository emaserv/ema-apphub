import { q } from '../db/pool';

/**
 * Avisos dentro de AppHub (campanita) para los superadministradores activos:
 * deploy fallido, app caída / recuperada, backup programado fallido, vulnerabilidades críticas en una imagen
 * y disco casi lleno / recuperado.
 */

export type NoticeKind = 'deploy_failed' | 'deploy_rolled_back' | 'app_down' | 'app_recovered' | 'backup_failed' | 'image_vulnerable'
  | 'disk_full' | 'disk_ok';
export interface Notice { kind: NoticeKind; severity: 'error' | 'warn' | 'ok'; title: string; body: string; appId?: string }
interface AppRef { id: string; name: string }

/** Guarda el aviso para cada superadministrador activo. */
export async function notifySuperadmins(n: Notice): Promise<void> {
  await q(
    `INSERT INTO notifications (user_id, kind, severity, title, body, application_id)
     SELECT u.id, $1, $2, $3, $4, $5 FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.code = 'superadmin' AND u.active`,
    [n.kind, n.severity, n.title.slice(0, 300), n.body, n.appId ?? null],
  );
}

/** En segundo plano y sin lanzar: un aviso que falla no debe frenar un deploy ni el monitor. */
export function notify(n: Notice): void {
  notifySuperadmins(n).catch((e) => console.error('[avisos] No se pudo guardar el aviso:', (e as Error).message));
}

// ───────── detección de caída / recuperación ─────────

/**
 * Recibe los últimos estados de salud (el más reciente primero) y dice si hay que avisar.
 * Se exigen 2 chequeos fallidos seguidos para evitar falsas alarmas (un reinicio, un pico),
 * y se avisa una sola vez: justo en el cambio.
 */
export function healthTransition(last: string[]): 'down' | 'recovered' | null {
  const [a, b, c] = last;
  if (a === 'unhealthy' && b === 'unhealthy' && c === 'healthy') return 'down';
  if (a === 'healthy' && b === 'unhealthy' && c === 'unhealthy') return 'recovered';
  return null;
}

// ───────── mensajes ─────────

const short = (s: string, n = 1000) => (s.length > n ? s.slice(0, n) + '…' : s);
const lines = (...l: (string | false | null | undefined)[]) => l.filter((x): x is string => typeof x === 'string').join('\n');

export function deployFailedNotice(p: { app: AppRef; env: string; version: string; error: string; by?: string; rolledBackTo?: string }): Notice {
  const by = p.by && `Iniciado por: ${p.by}`;
  return p.rolledBackTo
    ? {
        kind: 'deploy_rolled_back', severity: 'warn', appId: p.app.id,
        title: `Deploy fallido de ${p.app.name} ${p.version} (${p.env}): se volvió a ${p.rolledBackTo}`,
        body: lines(`La versión ${p.rolledBackTo} quedó funcionando.`, `Error: ${short(p.error)}`, by),
      }
    : {
        kind: 'deploy_failed', severity: 'error', appId: p.app.id,
        title: `Deploy fallido de ${p.app.name} ${p.version} (${p.env})`,
        body: lines('No se pudo volver a una versión anterior: la aplicación puede estar fuera de servicio.', `Error: ${short(p.error)}`, by),
      };
}

export function healthNotice(p: { app: AppRef; env: string; kind: 'down' | 'recovered'; detail?: string }): Notice {
  return p.kind === 'down'
    ? {
        kind: 'app_down', severity: 'error', appId: p.app.id,
        title: `${p.app.name} (${p.env}) está caída`,
        body: lines('No responde desde hace al menos 2 chequeos seguidos.', p.detail && `Detalle: ${short(p.detail, 500)}`),
      }
    : {
        kind: 'app_recovered', severity: 'ok', appId: p.app.id,
        title: `${p.app.name} (${p.env}) se recuperó`,
        body: 'Volvió a responder correctamente.',
      };
}

/** Vulnerabilidades CRÍTICAS en una imagen que igual se desplegó (fuera de production, o sin arreglo disponible). */
export function vulnerableImageNotice(p: { app: AppRef; env: string; version: string; critical: number; criticalFixable: number }): Notice {
  return {
    kind: 'image_vulnerable', severity: 'warn', appId: p.app.id,
    title: `${p.app.name} ${p.version} (${p.env}): ${p.critical} vulnerabilidad(es) crítica(s) en la imagen`,
    body: lines(
      `${p.criticalFixable} con arreglo disponible. El detalle está en el log del deploy.`,
      p.criticalFixable > 0 && 'Conviene actualizar esas dependencias antes de desplegar en production: ahí el deploy se bloquea.',
    ),
  };
}

// ───────── espacio en disco ─────────

/** Margen para el aviso de "se recuperó": evita avisos repetidos si el uso oscila justo alrededor del límite. */
export const DISK_RECOVER_MARGIN = 5;

/**
 * Dice si hay que avisar por el disco, según el porcentaje de uso actual y si el último aviso fue de "disco lleno".
 * Avisa una sola vez al pasar el límite, y una vez al volver a bajar (con margen).
 */
export function diskTransition(percent: number, alreadyAlerted: boolean, threshold: number): 'full' | 'ok' | null {
  if (!alreadyAlerted && percent >= threshold) return 'full';
  if (alreadyAlerted && percent < threshold - DISK_RECOVER_MARGIN) return 'ok';
  return null;
}

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;

export function diskNotice(p: { kind: 'full' | 'ok'; percent: number; free: number; total: number; threshold: number; freedBytes?: number }): Notice {
  const state = `Uso: ${p.percent} % (${gb(p.free)} libres de ${gb(p.total)}).`;
  return p.kind === 'full'
    ? {
        kind: 'disk_full', severity: 'error',
        title: `Disco del servidor al ${p.percent} %`,
        body: lines(
          state,
          `Se superó el límite de aviso (${p.threshold} %). Si el disco se llena fallan los deploys, los backups y las bases de datos.`,
          p.freedBytes ? `La limpieza automática de imágenes viejas ya liberó ${gb(p.freedBytes)}.` : 'La limpieza automática de imágenes viejas no encontró nada para borrar.',
          'Para liberar más: eliminar versiones y backups que ya no se necesiten, o ampliar el disco.',
        ),
      }
    : { kind: 'disk_ok', severity: 'ok', title: `Disco del servidor de nuevo por debajo del límite (${p.percent} %)`, body: state };
}

export function backupFailedNotice(p: { app: AppRef; env: string; type: string; error: string }): Notice {
  return {
    kind: 'backup_failed', severity: 'error', appId: p.app.id,
    title: `Backup programado fallido: ${p.app.name} (${p.env})`,
    body: lines(`Backup ${p.type === 'database' ? 'de la base de datos' : 'de la aplicación'}.`, `Error: ${short(p.error)}`),
  };
}
