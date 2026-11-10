import { useState } from 'react';
import { Eye, EyeOff, Lock, Plus, Trash2, Upload } from 'lucide-react';
import { Modal } from './ui';

export interface VarRow { key: string; value: string; isSecret: boolean; isSystem?: boolean; masked?: boolean }
// Mantener igual que SECRET_KEY_RE en backend/src/lib/util.ts
const SECRET_RE = /(PASS|PASSWORD|SECRET|TOKEN|KEY|PRIVATE|CREDENTIAL|DATABASE_URL)/i;

/**
 * Interpreta un valor de .env igual que el backend (parseDotenvValue en backend/src/lib/util.ts)
 * y que Docker Compose, para que importar un archivo exportado devuelva los valores originales:
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
  if (raw.startsWith('#')) return ''; // "CLAVE=  # secreto" (así se exportan los secretos)
  return raw.replace(/\s+#.*$/, '').trimEnd().replace(/\$\$/g, '$');
}

export function parseDotenv(text: string): VarRow[] {
  const out: VarRow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    out.push({ key: m[1], value: parseDotenvValue(m[2]), isSecret: SECRET_RE.test(m[1]) });
  }
  return out;
}

/**
 * Combina lo importado con las filas actuales. Las de sistema no se tocan, y una secreta que ya
 * existe no se pisa con un valor vacío (el export deja los secretos vacíos), así al Guardar
 * se conserva el valor real.
 */
export function mergeImported(rows: VarRow[], parsed: VarRow[]): VarRow[] {
  const map = new Map(rows.map((r) => [r.key, r]));
  for (const p of parsed) {
    const cur = map.get(p.key);
    if (cur?.isSystem) continue;
    if (!p.value && cur?.isSecret) continue;
    map.set(p.key, { ...p, isSecret: p.isSecret || !!cur?.isSecret });
  }
  return [...map.values()];
}

/** Editor de variables de entorno: crear, editar, eliminar, ocultar, importar .env. */
export function VarsEditor({ rows, onChange, readOnly }: { rows: VarRow[]; onChange: (r: VarRow[]) => void; readOnly?: boolean }) {
  const [reveal, setReveal] = useState<Record<number, boolean>>({});
  const [importing, setImporting] = useState(false);
  const [text, setText] = useState('');
  const set = (i: number, patch: Partial<VarRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch, masked: patch.value !== undefined ? false : r.masked } : r)));
  const dupes = new Set(rows.map((r) => r.key).filter((k, i, a) => k && a.indexOf(k) !== i));

  return (
    <div className="stack">
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th style={{ width: '32%' }}>Variable</th><th>Valor</th><th style={{ width: 110 }}>Secreta</th><th style={{ width: 90 }} /></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={4} className="muted">Sin variables definidas.</td></tr>}
            {rows.map((r, i) => (
              <tr key={i}>
                <td>
                  <input className="input mono" value={r.key} disabled={readOnly || r.isSystem} placeholder="NOMBRE"
                    style={dupes.has(r.key) ? { borderColor: 'var(--err)' } : undefined}
                    onChange={(e) => set(i, { key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'), isSecret: r.isSecret || SECRET_RE.test(e.target.value) })} />
                  {r.isSystem && <span className="muted small row" style={{ gap: 4, marginTop: 4 }}><Lock size={11} />Generada por la plataforma</span>}
                </td>
                <td>
                  <input className="input mono" type={r.isSecret && !reveal[i] ? 'password' : 'text'} value={r.value} disabled={readOnly || r.isSystem}
                    placeholder={r.masked ? '•••••••• (sin cambios)' : 'valor'}
                    onChange={(e) => set(i, { value: e.target.value })} />
                </td>
                <td>
                  <label className="switch"><input type="checkbox" checked={r.isSecret} disabled={readOnly || r.isSystem} onChange={(e) => set(i, { isSecret: e.target.checked })} /><span className="track" /></label>
                </td>
                <td className="nowrap">
                  {r.isSecret && !r.masked && <button className="btn ghost icon" title="Mostrar/ocultar" onClick={() => setReveal({ ...reveal, [i]: !reveal[i] })}>{reveal[i] ? <EyeOff size={15} /> : <Eye size={15} />}</button>}
                  {!readOnly && !r.isSystem && <button className="btn ghost icon" title="Eliminar" onClick={() => onChange(rows.filter((_, j) => j !== i))}><Trash2 size={15} /></button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {dupes.size > 0 && <div className="alert err">Variables duplicadas: {[...dupes].join(', ')}</div>}
      {!readOnly && (
        <div className="row">
          <button className="btn sm outline" onClick={() => onChange([...rows, { key: '', value: '', isSecret: false }])}><Plus size={14} />Agregar variable</button>
          <button className="btn sm outline" onClick={() => setImporting(true)}><Upload size={14} />Pegar / importar .env</button>
        </div>
      )}
      {importing && (
        <Modal title="Importar variables (.env)" onClose={() => setImporting(false)} footer={<>
          <button className="btn outline" onClick={() => setImporting(false)}>Cancelar</button>
          <button className="btn primary" onClick={() => {
            onChange(mergeImported(rows, parseDotenv(text))); setImporting(false); setText('');
          }}>Importar</button></>}>
          <div className="stack">
            <p className="muted" style={{ margin: 0 }}>Pegue el contenido de un archivo <code>.env</code> o selecciónelo. Las claves con PASSWORD, SECRET, TOKEN o KEY se marcan como secretas.</p>
            <input type="file" accept=".env,text/plain" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }} />
            <textarea className="input" rows={12} value={text} onChange={(e) => setText(e.target.value)} placeholder={'NODE_ENV=production\nPORT=3000\nJWT_SECRET=...'} />
          </div>
        </Modal>
      )}
    </div>
  );
}

export interface VolumeRow { source: string; target: string; type: 'volume' | 'bind'; readOnly?: boolean }

export function VolumesEditor({ rows, onChange, readOnly }: { rows: VolumeRow[]; onChange: (r: VolumeRow[]) => void; readOnly?: boolean }) {
  const set = (i: number, p: Partial<VolumeRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="stack">
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th style={{ width: 140 }}>Tipo</th><th>Origen</th><th>Destino en contenedor</th><th style={{ width: 70 }}>Solo lectura</th><th style={{ width: 50 }} /></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={5} className="muted">Sin volúmenes. Use volúmenes para datos que deben persistir entre deploys (uploads, archivos generados…).</td></tr>}
            {rows.map((r, i) => (
              <tr key={i}>
                <td><select className="input" value={r.type} disabled={readOnly} onChange={(e) => set(i, { type: e.target.value as any })}><option value="volume">Volumen Docker</option><option value="bind">Carpeta del servidor</option></select></td>
                <td><input className="input mono" value={r.source} disabled={readOnly} placeholder={r.type === 'volume' ? 'uploads' : 'uploads (en /data/applications/<app>/data/)'} onChange={(e) => set(i, { source: e.target.value })} /></td>
                <td><input className="input mono" value={r.target} disabled={readOnly} placeholder="/app/uploads" onChange={(e) => set(i, { target: e.target.value })} /></td>
                <td><input type="checkbox" checked={!!r.readOnly} disabled={readOnly} onChange={(e) => set(i, { readOnly: e.target.checked })} /></td>
                <td>{!readOnly && <button className="btn ghost icon" onClick={() => onChange(rows.filter((_, j) => j !== i))}><Trash2 size={15} /></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!readOnly && <div><button className="btn sm outline" onClick={() => onChange([...rows, { type: 'volume', source: '', target: '' }])}><Plus size={14} />Agregar volumen</button></div>}
    </div>
  );
}
