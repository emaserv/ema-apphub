export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

function csrf(): string {
  const m = document.cookie.match(/(?:^|;\s*)ema_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

async function handle<T>(res: Response): Promise<T> {
  const type = res.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && !location.pathname.startsWith('/login')) location.href = '/login';
    const msg = typeof body === 'object' && body?.error ? body.error : `Error ${res.status}`;
    const det = typeof body === 'object' ? body?.details : undefined;
    const fieldErrors = det?.fieldErrors ? Object.entries(det.fieldErrors).map(([k, v]) => `${k}: ${(v as string[]).join(', ')}`).join(' · ') : '';
    throw new ApiError(res.status, fieldErrors ? `${msg} — ${fieldErrors}` : msg, det);
  }
  return body as T;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; query?: Record<string, unknown> } = {}): Promise<T> {
  const qs = opts.query
    ? '?' + new URLSearchParams(Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString()
    : '';
  const method = opts.method || (opts.body !== undefined ? 'POST' : 'GET');
  const res = await fetch(`/api${path}${qs}`, {
    method,
    credentials: 'same-origin',
    headers: { ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-CSRF-Token': csrf() } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return handle<T>(res);
}

/** Subida multipart con progreso (XHR). */
export function uploadForm<T = any>(path: string, form: FormData, onProgress?: (pct: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-CSRF-Token', csrf());
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let body: any = xhr.responseText;
      try { body = JSON.parse(xhr.responseText); } catch { /* texto */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new ApiError(xhr.status, body?.error || `Error ${xhr.status}`, body?.details));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Error de red durante la subida'));
    xhr.send(form);
  });
}

export function wsUrl(path: string, params: Record<string, string | undefined>) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}?${qs}`;
}

export const fmtBytes = (b?: number | string | null) => {
  const n = Number(b);
  if (!n && n !== 0) return '—';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
};

export const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
export const fmtAgo = (d?: string | null) => {
  if (!d) return '—';
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return 'hace instantes';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86400)} d`;
};

/**
 * Campos Dominio y HTTPS de cada ambiente. Ocultos mientras las apps se publiquen sólo por ruta (…/holaema/):
 * no hay DNS para subdominios. Siguen visibles en los ambientes que ya tengan un dominio cargado.
 * Volver a true al migrar a un dominio para apps (ej. apps.emaservicios.com.ar + ruta) o a un subdominio por app.
 */
export const SHOW_DOMAIN = false;

export const ENV_LABEL: Record<string, string> = { development: 'Desarrollo', test: 'Test', staging: 'Staging', production: 'Producción' };
export const ENV_ORDER = ['development', 'test', 'staging', 'production'];
