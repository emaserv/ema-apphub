import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { LayoutGrid, List, Plus, Search } from 'lucide-react';
import { api, ENV_LABEL, fmtDate } from '../api/client';
import { useAuth } from '../auth';
import AppCard from '../components/AppCard';
import { Empty, Spinner, StatusBadge, useData } from '../components/ui';

const TITLES: Record<string, string> = { running: 'Ejecutando', stopped: 'Detenidas', error: 'Con error' };

export default function Applications() {
  const [params] = useSearchParams();
  const status = params.get('estado') || '';
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'cards' | 'table'>(() => (localStorage.getItem('apps.view') as any) || 'table');
  const { data, loading, reload } = useData(() => api<any[]>('/applications', { query: { status, search, stats: view === 'cards' ? 1 : undefined } }), [status, search, view], 20000);
  const nav = useNavigate();
  const { can } = useAuth();
  const setV = (v: 'cards' | 'table') => { setView(v); localStorage.setItem('apps.view', v); };

  return (
    <>
      <div className="page-head">
        <div><span className="eyebrow">Repositorio</span><h1>Aplicaciones {status && <span className="muted" style={{ fontSize: 18 }}>· {TITLES[status]}</span>}</h1>
          <p>Registro centralizado de aplicaciones, versiones y despliegues.</p></div>
        <div className="row">
          <div className="row" style={{ position: 'relative' }}>
            <Search size={15} style={{ position: 'absolute', left: 10, color: '#8a8fa8' }} />
            <input className="input" style={{ paddingLeft: 32, width: 260 }} placeholder="Buscar por nombre, id o tecnología" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="seg">
            <button className={view === 'table' ? 'active' : ''} onClick={() => setV('table')}><List size={14} /></button>
            <button className={view === 'cards' ? 'active' : ''} onClick={() => setV('cards')}><LayoutGrid size={14} /></button>
          </div>
          {can('apps.create') && <button className="btn primary" onClick={() => nav('/aplicaciones/nueva')}><Plus size={16} />Nueva aplicación</button>}
        </div>
      </div>

      {loading && !data ? <Spinner /> : !data?.length ? (
        <div className="card"><Empty title="No hay aplicaciones para mostrar">{can('apps.create') && !status && <button className="btn primary" onClick={() => nav('/aplicaciones/nueva')}>+ Nueva aplicación</button>}</Empty></div>
      ) : view === 'cards' ? (
        <div className="grid cards">{data.map((a) => <AppCard key={a.id} app={a} onChange={reload} />)}</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Aplicación</th><th>Tecnología</th><th>Versión</th><th>Estado</th><th>Ambientes</th><th>Puerto</th><th>URL</th><th>Actualizada</th><th>Autor</th></tr></thead>
            <tbody>
              {data.map((a) => {
                const env = a.main_environment;
                return (
                  <tr key={a.id} className="click" onClick={() => nav(`/aplicaciones/${a.id}`)}>
                    <td><b>{a.name}</b><div className="muted small mono">{a.slug}</div></td>
                    <td>{a.framework_label || a.technology_label}</td>
                    <td>{a.current_version ? <span className="badge">v{a.current_version}</span> : '—'}</td>
                    <td><StatusBadge status={a.state === 'error' && env?.status === 'running' ? 'unhealthy' : a.state} /></td>
                    <td><div className="row" style={{ gap: 4 }}>{a.environments.map((e: any) => <span key={e.id} className="badge sky" title={e.status}>{ENV_LABEL[e.name]}</span>)}</div></td>
                    <td className="mono">{env?.external_port ?? '—'}</td>
                    <td className="small">{env?.url ? <a href={env.url} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>{env.url.replace(/^https?:\/\//, '')}</a> : '—'}</td>
                    <td className="small muted nowrap">{fmtDate(a.updated_at)}</td>
                    <td className="small">{a.author_name ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
