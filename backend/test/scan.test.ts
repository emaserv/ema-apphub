import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { blockMessage, formatScan, parseTrivyReport, scanDecision } from '../src/services/scan';

const vuln = (id: string, sev: string, fixed = '', pkg = 'openssl') =>
  ({ VulnerabilityID: id, PkgName: pkg, InstalledVersion: '3.0.0', FixedVersion: fixed, Severity: sev, Title: `Falla ${id}` });
const report = (...vulns: object[]) => JSON.stringify({ Results: [{ Target: 'img', Vulnerabilities: vulns }, { Target: 'sin vulns' }] });

describe('parseTrivyReport', () => {
  test('cuenta críticas, altas y críticas con arreglo; ignora otras severidades y repetidas', () => {
    const s = parseTrivyReport(report(
      vuln('CVE-1', 'CRITICAL', '3.0.1'), vuln('CVE-2', 'CRITICAL'), vuln('CVE-3', 'HIGH', '3.0.2'),
      vuln('CVE-4', 'MEDIUM', '1'), vuln('CVE-1', 'CRITICAL', '3.0.1'),
    ));
    assert.deepEqual([s.critical, s.criticalFixable, s.high], [2, 1, 1]);
    assert.deepEqual(s.vulns.map((v) => v.id), ['CVE-1', 'CVE-2', 'CVE-3'], 'críticas primero, las con arreglo antes');
  });

  test('imagen limpia (sin Results o sin Vulnerabilities)', () => {
    assert.equal(parseTrivyReport('{}').vulns.length, 0);
    assert.deepEqual(formatScan(parseTrivyReport(report())), ['✔ Sin vulnerabilidades críticas ni altas']);
  });

  test('JSON inválido lanza error (el deploy sigue con advertencia)', () => {
    assert.throws(() => parseTrivyReport(''));
  });
});

describe('scanDecision', () => {
  const fixable = parseTrivyReport(report(vuln('CVE-1', 'CRITICAL', '3.0.1')));
  const unfixable = parseTrivyReport(report(vuln('CVE-2', 'CRITICAL'), vuln('CVE-3', 'HIGH', '1.2')));

  test('production con críticas que tienen arreglo: bloquea', () => {
    assert.equal(scanDecision(fixable, 'production', 'manual'), 'block');
    assert.equal(scanDecision(fixable, 'production', 'git'), 'block');
    assert.match(blockMessage(fixable), /1 vulnerabilidad\(es\) CRÍTICA\(s\)/);
  });

  test('otros ambientes, o críticas sin arreglo: no bloquea', () => {
    assert.equal(scanDecision(fixable, 'staging', 'manual'), 'ok');
    assert.equal(scanDecision(unfixable, 'production', 'manual'), 'ok');
  });

  test('rollbacks y restauraciones nunca se bloquean', () => {
    for (const t of ['rollback', 'auto_rollback', 'restore']) assert.equal(scanDecision(fixable, 'production', t), 'ok', t);
  });
});

test('formatScan: resumen y detalle con la versión que corrige', () => {
  const lines = formatScan(parseTrivyReport(report(vuln('CVE-1', 'CRITICAL', '3.0.1'), vuln('CVE-2', 'HIGH'))));
  assert.match(lines[0], /1 críticas \(1 con arreglo\), 1 altas/);
  assert.match(lines[1], /CRÍTICA openssl 3\.0\.0 → corregido en 3\.0\.1 · CVE-1/);
  assert.match(lines[2], /sin arreglo todavía/);
});
