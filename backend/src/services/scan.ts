/**
 * Escaneo de vulnerabilidades de las imágenes con Trivy, durante el deploy.
 * Reglas:
 * - Siempre se informa en el log del deploy (vulnerabilidades CRÍTICAS y ALTAS).
 * - En production se BLOQUEA el deploy si hay CRÍTICAS con arreglo disponible
 *   (las que no tienen arreglo no bloquean: no habría cómo resolverlas).
 * - Los rollbacks y restauraciones nunca se bloquean: volver a una versión anterior
 *   en una emergencia no debe quedar trabado por el escaneo.
 * - Si Trivy no puede correr (sin internet, etc.), el deploy sigue con una advertencia.
 */

export interface Vuln { id: string; pkg: string; installed: string; fixed: string; severity: 'CRITICAL' | 'HIGH'; title: string }
export interface ScanSummary { critical: number; high: number; criticalFixable: number; vulns: Vuln[] }

/** Disparadores que nunca se bloquean por el escaneo. */
const NEVER_BLOCK = new Set(['rollback', 'auto_rollback', 'restore']);
const MAX_LOG_LINES = 40;

/** Resume el reporte JSON de `trivy image --format json`. */
export function parseTrivyReport(json: string): ScanSummary {
  const report = JSON.parse(json);
  const seen = new Set<string>();
  const vulns: Vuln[] = [];
  for (const r of report?.Results ?? []) {
    for (const v of r?.Vulnerabilities ?? []) {
      if (v.Severity !== 'CRITICAL' && v.Severity !== 'HIGH') continue;
      // La misma vulnerabilidad en el mismo paquete puede aparecer en varias capas: se cuenta una vez
      const key = `${v.VulnerabilityID}|${v.PkgName}|${v.InstalledVersion}`;
      if (seen.has(key)) continue;
      seen.add(key);
      vulns.push({
        id: String(v.VulnerabilityID ?? ''), pkg: String(v.PkgName ?? ''), installed: String(v.InstalledVersion ?? ''),
        fixed: String(v.FixedVersion ?? ''), severity: v.Severity, title: String(v.Title ?? ''),
      });
    }
  }
  // Primero las críticas, y dentro de cada severidad las que tienen arreglo
  vulns.sort((a, b) => (a.severity === b.severity ? Number(!a.fixed) - Number(!b.fixed) : a.severity === 'CRITICAL' ? -1 : 1));
  const critical = vulns.filter((v) => v.severity === 'CRITICAL');
  return { critical: critical.length, high: vulns.length - critical.length, criticalFixable: critical.filter((v) => v.fixed).length, vulns };
}

export function scanDecision(s: ScanSummary, envName: string, trigger?: string): 'block' | 'ok' {
  if (trigger && NEVER_BLOCK.has(trigger)) return 'ok';
  return envName === 'production' && s.criticalFixable > 0 ? 'block' : 'ok';
}

/** Líneas para el log del deploy. */
export function formatScan(s: ScanSummary): string[] {
  if (!s.vulns.length) return ['✔ Sin vulnerabilidades críticas ni altas'];
  const out = [`⚠ Vulnerabilidades: ${s.critical} críticas (${s.criticalFixable} con arreglo), ${s.high} altas`];
  for (const v of s.vulns.slice(0, MAX_LOG_LINES)) {
    const fix = v.fixed ? `→ corregido en ${v.fixed}` : '(sin arreglo todavía)';
    out.push(`  ${v.severity === 'CRITICAL' ? 'CRÍTICA' : 'ALTA   '} ${v.pkg} ${v.installed} ${fix} · ${v.id}${v.title ? ` · ${v.title.slice(0, 100)}` : ''}`);
  }
  if (s.vulns.length > MAX_LOG_LINES) out.push(`  … y ${s.vulns.length - MAX_LOG_LINES} más`);
  return out;
}

export function blockMessage(s: ScanSummary): string {
  return `La imagen tiene ${s.criticalFixable} vulnerabilidad(es) CRÍTICA(s) con arreglo disponible: en production no se despliega. `
    + 'Actualice esas dependencias (o la imagen base del Dockerfile) a la versión indicada en el log y suba una versión nueva.';
}
