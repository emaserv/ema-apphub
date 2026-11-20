import { badRequest } from './http';

/**
 * Rutas que usa la propia interfaz de AppHub: una app no puede publicarse en ellas.
 * Tienen que coincidir con las rutas de frontend/src/main.tsx y con la regla de AppHub en frontend/nginx.conf
 * (lo verifica test/appPath.test.ts).
 */
export const RESERVED_PATHS = [
  'api', 'ws', 'assets', 'login',
  'aplicaciones', 'deployments', 'bases-de-datos', 'backups', 'docker', 'git', 'usuarios', 'auditoria', 'configuracion',
] as const;

const SEGMENT_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Normaliza la ruta de publicación de una app: "HolaEma", "/holaema/" → "/holaema". Vacía → null.
 * Es un solo tramo (sin "/" en el medio) con letras minúsculas, números y guiones.
 */
export function normalizeAppPath(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const s = input.trim().toLowerCase().replace(/^\/+|\/+$/g, '');
  if (!s) return null;
  if (!SEGMENT_RE.test(s)) {
    throw badRequest('Ruta inválida: use sólo letras minúsculas, números y guiones, sin "/" en el medio (ej. /holaema)');
  }
  if ((RESERVED_PATHS as readonly string[]).includes(s)) throw badRequest(`La ruta /${s} la usa AppHub: elija otra`);
  return `/${s}`;
}
