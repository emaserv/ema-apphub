import { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, ZodError, ZodTypeAny } from 'zod';

// Mensajes de validación en español (se muestran en pantalla junto a "Datos inválidos")
z.config(z.locales.es());

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}
export const badRequest = (m: string, d?: unknown) => new HttpError(400, m, d);
export const notFound = (m = 'No encontrado') => new HttpError(404, m);
export const forbidden = (m = 'Permiso denegado') => new HttpError(403, m);
export const conflict = (m: string, d?: unknown) => new HttpError(409, m, d);

export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest('Datos inválidos', r.error.flatten());
  return r.data;
}

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
  if (err instanceof ZodError) return res.status(400).json({ error: 'Datos inválidos', details: err.flatten() });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Archivo demasiado grande' });
  if (err?.name === 'MulterError') return res.status(400).json({ error: `Carga inválida: ${err.message}` });
  if (err?.code === '23505') return res.status(409).json({ error: 'Ya existe un registro con esos datos', details: err.detail });
  console.error('[error]', err);
  // Errores operativos (docker, compose, git, psql): se devuelve el motivo para que el administrador pueda actuar
  const msg = typeof err?.message === 'string' && err.message ? err.message.slice(0, 800) : 'Error interno del servidor';
  res.status(500).json({ error: msg });
}
