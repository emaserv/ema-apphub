import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Eye, KeyRound, Lock, Pencil, Plus, RefreshCw, Search, Table2, Trash2 } from 'lucide-react';
import { api, ENV_LABEL } from '../../api/client';
import { useAuth } from '../../auth';
import { Confirm, Modal, Spinner, useAction, useData } from '../../components/ui';
import { TabProps } from './OverviewTab';

/**
 * Panel de datos de la base PostgreSQL del ambiente: tablas, registros y (con permiso db.data.edit)
 * agregar, editar y eliminar. Ver backend/src/services/dbData.ts. Estilos: .dp-* y .rf-* en theme.css.
 */
interface Column { name: string; type: string; nullable: boolean; hasDefault: boolean; identity: string; generated: string }
interface TableRef { schema: string; name: string; kind: string; rows: number | null; approx: boolean; hasPk: boolean }
type Row = Record<string, string | null>;
interface Page { table: { schema: string; name: string; kind: string; columns: Column[]; pk: string[]; editable: boolean }; rows: Row[]; total: number }

const PAGE = 50;
const writable = (c: Column) => c.generated === '' && c.identity !== 'a';
const isView = (t: { kind: string }) => t.kind === 'v' || t.kind === 'm';
const qualified = (t: { schema: string; name: string }) => (t.schema === 'public' ? t.name : `${t.schema}.${t.name}`);
const nf = new Intl.NumberFormat('es-AR');

// ───────── presentación de valores según el tipo de la columna ─────────
type Kind = 'int' | 'dec' | 'bool' | 'ts' | 'date' | 'json' | 'code' | 'text';
function kindOf(type: string): Kind {
  if (/^(smallint|integer|bigint)/.test(type)) return 'int';
  if (/^(numeric|decimal|real|double precision|money)/.test(type)) return 'dec';
  if (type === 'boolean') return 'bool';
  if (/^timestamp/.test(type)) return 'ts';
  if (type === 'date') return 'date';
  if (/^jsonb?$/.test(type)) return 'json';
  if (type === 'uuid' || /^bytea/.test(type)) return 'code';
  return 'text';
}
const isNum = (k: Kind) => k === 'int' || k === 'dec';

function display(v: string, k: Kind): string {
  if (k === 'dec' && /^-?\d+(\.\d+)?$/.test(v)) {
    const decimals = v.split('.')[1]?.length ?? 0;
    return Number(v).toLocaleString('es-AR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }
  if (k === 'ts') {
    // PostgreSQL: "2026-11-20 15:58:44.00081+00" → fecha y hora locales
    const d = new Date(v.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
    return Number.isNaN(d.getTime()) ? v : d.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
  }
  if (k === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v.split('-').reverse().join('/');
  return v.length > 120 ? `${v.slice(0, 120)}…` : v;
}

function Cell({ v, k }: { v: string | null; k: Kind }) {
  if (v === null) return <span className="null">NULL</span>;
  if (k === 'bool') return <span className={`badge ${v === 'true' ? 'ok' : ''}`}>{v === 'true' ? 'Sí' : 'No'}</span>;
  return <>{display(v, k)}</>;
}

export default function DataPanel({ app, env }: TabProps) {
  const { can } = useAuth();
  const canEdit = can('db.data.edit');
  const q = { environment: env.name };
  const tables = useData<TableRef[]>(() => api(`/applications/${app.id}/database/tables`, { query: q }), [app.id, env.name]);
  const [sel, setSel] = useState<TableRef | null>(null);
  const [filter, setFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const [order, setOrder] = useState<{ col?: string; dir: 'asc' | 'desc' }>({ dir: 'asc' });
  const [form, setForm] = useState<{ row: Row | null } | null>(null);
  const [del, setDel] = useState<Row | null>(null);
  const { run } = useAction();

  useEffect(() => { setSel(null); }, [env.name]);
  useEffect(() => { if (!sel && tables.data?.length) setSel(tables.data.find((t) => !isView(t)) ?? tables.data[0]); }, [tables.data, sel]);

  const page = useData<Page | null>(() => (sel
    ? api(`/applications/${app.id}/database/rows`, { query: { ...q, schema: sel.schema, table: sel.name, limit: PAGE, offset, order: order.col, dir: order.dir } })
    : Promise.resolve(null)), [app.id, env.name, sel?.schema, sel?.name, offset, order.col, order.dir]);

  const visible = useMemo(() => (tables.data ?? []).filter((t) => qualified(t).toLowerCase().includes(filter.trim().toLowerCase())), [tables.data, filter]);
  const choose = (t: TableRef) => { setSel(t); setOffset(0); setOrder({ dir: 'asc' }); };
  const sortBy = (col: string) => { setOffset(0); setOrder((o) => ({ col, dir: o.col === col && o.dir === 'asc' ? 'desc' : 'asc' })); };
  const reloadAll = () => { void tables.reload(); void page.reload(); };
  const t = page.data && sel && page.data.table.name === sel.name && page.data.table.schema === sel.schema ? page.data.table : null;
  const pkOf = (row: Row) => Object.fromEntries((t?.pk ?? []).map((k) => [k, row[k] ?? '']));
  const isProd = env.name === 'production';
  const total = page.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  const item = (r: TableRef) => (
    <button key={`${r.schema}.${r.name}`} className={`dp-item ${sel?.schema === r.schema && sel?.name === r.name ? 'active' : ''}`} onClick={() => choose(r)}
      title={isView(r) ? 'Vista: sólo lectura' : !r.hasPk ? 'Sin clave primaria: sólo lectura' : qualified(r)}>
      {isView(r) ? <Eye size={14} /> : <Table2 size={14} />}
      <span className="name">{qualified(r)}</span>
      {!r.hasPk && !isView(r) && <Lock size={11} />}
      {r.rows !== null && <span className="count">{r.approx ? '≈' : ''}{nf.format(r.rows)}</span>}
    </button>
  );

  return (
    <div className="card stack">
      <div>
        <h3 className="row" style={{ margin: 0 }}><Table2 size={16} />Datos</h3>
        <div className="muted small" style={{ marginTop: 4 }}>
          Tablas y registros de la base{canEdit ? '. Puede agregar, editar y eliminar registros de las tablas con clave primaria.' : ' (sólo lectura).'}
        </div>
      </div>

      {tables.loading && !tables.data ? <div className="dp-empty"><Spinner /></div>
        : tables.error ? <div className="alert warn">No se pudieron leer las tablas: {tables.error}</div>
        : !tables.data?.length ? <div className="dp dp-empty" style={{ display: 'block' }}>La base todavía no tiene tablas. La app las crea al arrancar.</div>
        : (
        <div className="dp">
          <aside className="dp-side">
            <div className="dp-search">
              <div className="wrap"><Search size={14} /><input className="input" placeholder="Buscar tabla" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
            </div>
            <div className="dp-list">
              {visible.some((r) => !isView(r)) && <div className="dp-group">Tablas</div>}
              {visible.filter((r) => !isView(r)).map(item)}
              {visible.some(isView) && <div className="dp-group">Vistas</div>}
              {visible.filter(isView).map(item)}
              {!visible.length && <div className="dp-empty" style={{ padding: 20 }}>Sin coincidencias</div>}
            </div>
          </aside>

          <section className="dp-main">
            <div className="dp-bar">
              <h4>{sel ? qualified(sel) : ''}</h4>
              {t && <span className="badge">{nf.format(total)} {total === 1 ? 'registro' : 'registros'}</span>}
              {t && !t.editable && <span className="badge warn"><Lock size={11} />Sólo lectura{isView(t) ? ' · vista' : ' · sin clave primaria'}</span>}
              <div className="right row" style={{ gap: 8 }}>
                <button className="btn sm outline" onClick={reloadAll} title="Volver a leer los datos"><RefreshCw size={13} />Recargar</button>
                {canEdit && t?.editable && <button className="btn sm primary" onClick={() => setForm({ row: null })}><Plus size={14} />Agregar registro</button>}
              </div>
            </div>

            {!t ? <div className="dp-empty"><Spinner /></div> : (
              <>
                <div className="dp-grid">
                  <table>
                    <thead><tr>
                      {t.columns.map((c) => {
                        const k = kindOf(c.type);
                        return (
                          <th key={c.name} className={isNum(k) ? 'num' : ''} onClick={() => sortBy(c.name)} title={`Ordenar por ${c.name}`}>
                            <span className="col">
                              {t.pk.includes(c.name) && <KeyRound size={11} color="#c98a05" />}
                              {c.name}
                              {order.col === c.name && (order.dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                            </span>
                            <span className="type">{c.type}</span>
                          </th>
                        );
                      })}
                      <th className="fill" />
                      {canEdit && t.editable && <th className="actions" />}
                    </tr></thead>
                    <tbody>
                      {page.data!.rows.map((row, i) => (
                        <tr key={t.pk.length ? t.pk.map((k) => row[k]).join('|') : i}>
                          {t.columns.map((c) => {
                            const k = kindOf(c.type);
                            return <td key={c.name} className={isNum(k) ? 'num' : k === 'code' || k === 'json' ? 'code' : ''} title={row[c.name] ?? 'NULL'}><Cell v={row[c.name]} k={k} /></td>;
                          })}
                          <td className="fill" />
                          {canEdit && t.editable && (
                            <td className="actions">
                              <button className="btn ghost icon" title="Editar" onClick={() => setForm({ row })}><Pencil size={14} /></button>
                              <button className="btn ghost icon" title="Eliminar" style={{ color: 'var(--err)' }} onClick={() => setDel(row)}><Trash2 size={14} /></button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!page.data!.rows.length && <div className="dp-empty">La tabla está vacía.</div>}
                </div>
                <div className="dp-foot">
                  <span>{total ? `Mostrando ${nf.format(offset + 1)}–${nf.format(Math.min(offset + PAGE, total))} de ${nf.format(total)}` : 'Sin registros'}</span>
                  {total > PAGE && (
                    <div className="pager">
                      <button className="btn icon outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} title="Anterior"><ChevronLeft size={15} /></button>
                      <span>Página {Math.floor(offset / PAGE) + 1} de {pages}</span>
                      <button className="btn icon outline" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)} title="Siguiente"><ChevronRight size={15} /></button>
                    </div>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {form && t && (
        <RowForm table={qualified(t)} columns={t.columns} pk={t.pk} row={form.row} isProd={isProd} envLabel={ENV_LABEL[env.name]} onClose={() => setForm(null)}
          onSave={(values) => run(async () => {
            if (form.row) await api(`/applications/${app.id}/database/rows`, { method: 'PUT', body: { ...q, schema: t.schema, table: t.name, pk: pkOf(form.row), values } });
            else await api(`/applications/${app.id}/database/rows`, { body: { ...q, schema: t.schema, table: t.name, values } });
            setForm(null); reloadAll();
            return true;
          }, form.row ? 'Registro actualizado' : 'Registro agregado')} />
      )}
      {del && t && (
        <Confirm title="Eliminar registro" danger confirmLabel="Eliminar"
          text={<>Se eliminará de <b>{qualified(t)}</b> el registro con {t.pk.map((k, i) => <span key={k}>{i ? ', ' : ''}<code>{k} = {del[k]}</code></span>)}
            {isProd ? <>, en <b>Producción</b></> : null}. Esta acción no se puede deshacer.</>}
          onConfirm={() => run(async () => {
            await api(`/applications/${app.id}/database/rows/delete`, { body: { ...q, schema: t.schema, table: t.name, pk: pkOf(del) } });
            reloadAll();
          }, 'Registro eliminado')}
          onClose={() => setDel(null)} />
      )}
    </div>
  );
}

/**
 * Alta o edición de un registro. Al agregar se envían sólo los campos completados (el resto toma su valor por defecto);
 * al editar, sólo los que cambiaron. "NULL" deja el campo vacío en la base.
 */
function RowForm({ table, columns, pk, row, isProd, envLabel, onClose, onSave }: {
  table: string; columns: Column[]; pk: string[]; row: Row | null; isProd: boolean; envLabel: string;
  onClose: () => void; onSave: (values: Row) => Promise<unknown>;
}) {
  const editing = !!row;
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(columns.map((c) => [c.name, row?.[c.name] ?? ''])));
  const [nulls, setNulls] = useState<Record<string, boolean>>(() => Object.fromEntries(columns.map((c) => [c.name, !!row && row[c.name] === null])));
  const [saving, setSaving] = useState(false);

  const locked = (c: Column) => !writable(c) || (editing && pk.includes(c.name));
  const build = () => {
    const out: Row = {};
    for (const c of columns) {
      if (locked(c)) continue;
      const v = nulls[c.name] ? null : vals[c.name];
      if (editing) { if (v !== row![c.name]) out[c.name] = v; } // sólo lo que cambió
      else if (v !== '') out[c.name] = v; // vacío = valor por defecto
    }
    return out;
  };
  const save = async () => { setSaving(true); try { await onSave(build()); } finally { setSaving(false); } };
  const set = (name: string, v: string) => setVals({ ...vals, [name]: v });

  return (
    <Modal size="lg" onClose={onClose}
      title={<div><div>{editing ? 'Editar registro' : 'Agregar registro'}</div>
        <div className="rf-head">{table}{editing ? ` · ${pk.map((k) => `${k} = ${row![k]}`).join(', ')}` : ''}</div></div>}
      footer={<><button className="btn outline" onClick={onClose}>Cancelar</button>
        <button className="btn primary" disabled={saving} onClick={save}>{saving && <span className="spinner" />}{editing ? 'Guardar cambios' : 'Agregar'}</button></>}>
      <div className="stack" style={{ gap: 18 }}>
        {/* El texto va en un solo span: .alert es flex con separación entre hijos */}
        {isProd && <div className="alert warn"><span>Está modificando datos de <b>{envLabel}</b>: el cambio impacta en la app en uso y queda registrado en la auditoría.</span></div>}
        {!editing && <div className="small muted" style={{ marginTop: -4 }}>Los campos que deje vacíos toman su valor por defecto.</div>}
        <div className="rf-grid">
          {columns.map((c) => {
            const k = kindOf(c.type);
            const wide = k === 'json' || (vals[c.name]?.length ?? 0) > 80 || vals[c.name]?.includes('\n');
            const required = !c.nullable && !c.hasDefault && !locked(c);
            const dis = nulls[c.name];
            return (
              <div key={c.name} className={`rf-field ${wide ? 'wide' : ''}`}>
                <div className="rf-label">
                  <span className="n">{pk.includes(c.name) && <KeyRound size={12} color="#c98a05" />}{c.name}</span>
                  <span className="t">{c.type}</span>
                  {required && <span className="req">Obligatorio</span>}
                  {c.nullable && !locked(c) && (
                    <label className="nullbox"><input type="checkbox" checked={!!nulls[c.name]} onChange={(e) => setNulls({ ...nulls, [c.name]: e.target.checked })} />NULL</label>
                  )}
                </div>
                {locked(c) ? (
                  <div className="rf-locked"><Lock size={13} />{editing ? (row![c.name] ?? 'NULL') : 'Lo genera la base'}</div>
                ) : k === 'bool' ? (
                  <select className="input" disabled={dis} value={vals[c.name]} onChange={(e) => set(c.name, e.target.value)}>
                    {!editing && <option value="">Por defecto</option>}
                    {editing && vals[c.name] === '' && <option value="">—</option>}
                    <option value="true">Sí</option><option value="false">No</option>
                  </select>
                ) : wide ? (
                  <textarea className="input" rows={4} disabled={dis} value={vals[c.name]} onChange={(e) => set(c.name, e.target.value)} />
                ) : (
                  <input className="input" disabled={dis} inputMode={isNum(k) ? 'decimal' : undefined} value={vals[c.name]}
                    placeholder={!editing && c.hasDefault ? 'Valor por defecto' : k === 'ts' ? 'AAAA-MM-DD HH:MM' : k === 'date' ? 'AAAA-MM-DD' : ''}
                    onChange={(e) => set(c.name, e.target.value)} />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
