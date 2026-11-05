import fs from 'fs';
import path from 'path';
import { badRequest } from './http';

export function slugify(s: string): string {
  return s
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'app';
}

export const ENV_NAMES = ['development', 'test', 'staging', 'production'] as const;
export type EnvName = (typeof ENV_NAMES)[number];
export const ENV_SHORT: Record<EnvName, string> = { development: 'dev', test: 'test', staging: 'stg', production: 'prod' };

/** Nombre de proyecto compose / contenedor: ema-<slug>-<env> */
export const projectName = (slug: string, env: string) => `ema-${slug}-${env}`;
export const dbContainerName = (slug: string, env: string) => `ema-${slug}-${env}-db`;

export function bumpPatch(v?: string | null): string {
  if (!v) return '1.0.0';
  const m = v.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return `${v}-1`;
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

export const VERSION_RE = /^v?[0-9A-Za-z][0-9A-Za-z._-]{0,38}$/;

export function dirSize(dir: string): number {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    }
  }
  return total;
}

export function copyDir(src: string, dst: string) {
  fs.cpSync(src, dst, { recursive: true, dereference: false, force: true });
}

export function rmrf(p: string) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

/** Garantiza que `target` quede dentro de `base` (evita path traversal). */
export function safeJoin(base: string, rel: string): string {
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) throw badRequest(`Ruta inválida en el contenido: ${rel}`);
  return target;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Interpreta un valor de .env igual que Docker Compose, para que importar lo que se exportó con
 * toDotenvLine devuelva exactamente el valor original:
 *  - "entre comillas dobles": \" \\ \n se desescapan y $$ → $
 *  - 'entre comillas simples': literal
 *  - sin comillas: "#" al inicio o precedido de espacio inicia un comentario, y $$ → $
 */
function parseDotenvValue(raw: string): string {
  if (raw.startsWith('"')) {
    let out = '';
    for (let i = 1; i < raw.length; i++) {
      const c = raw[i];
      if (c === '"') return out; // lo que siga a la comilla de cierre es un comentario
      if (c === '\\' && i + 1 < raw.length) {
        const n = raw[++i];
        out += n === 'n' ? '\n' : n === '"' || n === '\\' ? n : '\\' + n;
      } else if (c === '$' && raw[i + 1] === '$') {
        out += '$';
        i++;
      } else out += c;
    }
    return raw; // sin comilla de cierre: se toma tal cual
  }
  if (raw.startsWith("'")) {
    const end = raw.indexOf("'", 1);
    return end === -1 ? raw : raw.slice(1, end);
  }
  if (raw.startsWith('#')) return ''; // "CLAVE=  # comentario" (así se exportan los secretos)
  return raw.replace(/\s+#.*$/, '').trimEnd().replace(/\$\$/g, '$');
}

export function parseDotenv(text: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    out.push({ key: m[1], value: parseDotenvValue(m[2]) });
  }
  return out;
}

export function toDotenvLine(k: string, v: string): string {
  const needsQuote = /[\s#"'$`\\]/.test(v) || v.includes('\n');
  return needsQuote ? `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\$/g, '$$$$')}"` : `${k}=${v}`;
}

export const SECRET_KEY_RE = /(PASS|PASSWORD|SECRET|TOKEN|KEY|PRIVATE|CREDENTIAL|DATABASE_URL)/i;
