/**
 * Registro de WebSockets abiertos (logs y terminal) por usuario, para poder cortarlos
 * cuando se cierran sus sesiones: logout, cambio/reseteo de contraseña o desactivación.
 * El token sólo se valida al abrir el WebSocket; sin esto seguirían vivos hasta que se cierren solos.
 */

/** Lo mínimo que se usa de un WebSocket (permite probarlo sin abrir conexiones reales). */
export interface ClosableSocket {
  close(code?: number, reason?: string): void;
  once(event: 'close', listener: () => void): unknown;
}

/** Código de cierre que recibe el navegador (4000–4999 es el rango para uso de la aplicación). */
export const SESSION_CLOSED_CODE = 4001;

const open = new Map<string, Set<ClosableSocket>>();

export function trackSocket(userId: string, ws: ClosableSocket) {
  let set = open.get(userId);
  if (!set) open.set(userId, (set = new Set()));
  set.add(ws);
  ws.once('close', () => {
    set!.delete(ws);
    if (!set!.size && open.get(userId) === set) open.delete(userId);
  });
}

/** Cierra todos los WebSockets abiertos del usuario y devuelve cuántos eran. */
export function closeUserSockets(userId: string, reason = 'Sesión cerrada'): number {
  const set = open.get(userId);
  if (!set) return 0;
  open.delete(userId);
  const sockets = [...set]; // al cerrarse, cada socket se quita solo del conjunto
  for (const ws of sockets) ws.close(SESSION_CLOSED_CODE, reason);
  return sockets.length;
}

/** Sólo para tests. */
export const openSocketCount = (userId: string) => open.get(userId)?.size ?? 0;
