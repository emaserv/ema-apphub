import fs from 'fs';
import multer from 'multer';
import path from 'path';
import type { Req } from '../lib/http';
import { config, paths } from '../config';
import { getApp, getEnv } from '../services/core';

fs.mkdirSync(path.join(paths.uploads(), 'incoming'), { recursive: true });

export const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const d = path.join(paths.uploads(), 'incoming');
      fs.mkdirSync(d, { recursive: true });
      cb(null, d);
    },
    filename: (_req, _file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}`),
  }),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 20000, fieldSize: 10 * 1024 * 1024 },
});

/** Resuelve aplicación (:id) y ambiente (?environment= / body.environment). */
export async function ctx(req: Req) {
  const app = await getApp(req.params.id);
  const envName = (req.query.environment as string) || req.body?.environment || null;
  const env = await getEnv(app.id, envName);
  return { app, env };
}

export const boolish = (v: unknown) => v === true || v === 'true' || v === '1' || v === 'on';

export function cleanupFiles(files?: Express.Multer.File[] | { [k: string]: Express.Multer.File[] }) {
  const list = Array.isArray(files) ? files : files ? Object.values(files).flat() : [];
  for (const f of list) fs.rmSync(f.path, { force: true });
}
