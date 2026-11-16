import { useNavigate } from 'react-router';
import { Activity, AlertTriangle, Boxes, CheckCircle2, Container, Database, HardDrive, PauseCircle, Rocket } from 'lucide-react';
import { api, ENV_LABEL, fmtAgo, fmtBytes } from '../api/client';
import AppCard from '../components/AppCard';
import { Empty, Meter, Spinner, StatusBadge, useData } from '../components/ui';
import { useAuth } from '../auth';

export default function Dashboard() {
  const { data: d } = useData(() => api('/system/dashboard'), [], 15000);
  const { data: apps, reload } = useData(() => api<any[]>('/applications', { query: { stats: 1 } }), [], 20000);
  const nav = useNavigate();
  const { can } = useAuth();
  if (!d) return <Spinner />;
  const a = d.applications;

  return (
    <>
      <div className="page-head">
        <div><span className="eyebrow">EMA AppHub</span><h1>Dashboard</h1><p>Estado general de las aplicaciones y del servidor.</p></div>
        {!d.dockerOnline && <div className="alert err"><AlertTriangle size={16} />No hay conexión con el daemon Docker</div>}
      </div>

      <div className="grid c4" style={{ marginBottom: 16 }}>
        <div className="card stat" onClick={() => nav('/aplicaciones')} style={{ cursor: 'pointer' }}>
          <span className="l row"><Boxes size={15} />Aplicaciones</span><span className="v">{a.total}</span>
          <span className="muted small">{d.environments} ambientes desplegados</span>
        </div>
        <div className="card stat" onClick={() => nav('/aplicaciones?estado=running')} style={{ cursor: 'pointer' }}>
          <span className="l row"><CheckCircle2 size={15} color="var(--ok)" />Ejecutando</span><span className="v" style={{ color: 'var(--ok)' }}>{a.running}</span>
          <span className="muted small">{a.deploying ? `${a.deploying} desplegando` : 'Operativas'}</span>
        </div>
        <div className="card stat" onClick={() => nav('/aplicaciones?estado=stopped')} style={{ cursor: 'pointer' }}>
          <span className="l row"><PauseCircle size={15} />Detenidas</span><span className="v" style={{ color: '#7b8095' }}>{a.stopped}</span>
          <span className="muted small">Incluye sin desplegar</span>
        </div>
        <div className="card stat" onClick={() => nav('/aplicaciones?estado=error')} style={{ cursor: 'pointer' }}>
          <span className="l row"><AlertTriangle size={15} color="var(--err)" />Error</span><span className="v" style={{ color: 'var(--err)' }}>{a.error}</span>
          <span className="muted small">{d.failed_week} deploys fallidos (7 días)</span>
        </div>
      </div>

      <div className="grid c3" style={{ marginBottom: 16 }}>
        <div className="card stack">
          <div className="card-title"><h3 className="row"><Activity size={17} />Servidor</h3><span className="muted small">{d.host.cpu.cores} núcleos</span></div>
          <Meter label="CPU" value={d.host.cpu.percent} />
          <Meter label="RAM" value={d.host.memory.percent} detail={`${fmtBytes(d.host.memory.used)} / ${fmtBytes(d.host.memory.total)}`} />
          <Meter label="Disco (datos)" value={d.host.disk.percent} detail={`${fmtBytes(d.host.disk.used)} / ${fmtBytes(d.host.disk.total)}`} />
        </div>
        <div className="card">
          <div className="card-title"><h3 className="row"><Container size={17} />Infraestructura</h3></div>
          <div className="grid c2">
            <div className="stat"><span className="l">Contenedores</span><span className="v">{d.containers.running}<span className="muted" style={{ fontSize: 16 }}>/{d.containers.total}</span></span></div>
            <div className="stat"><span className="l row"><Database size={13} />Bases de datos</span><span className="v">{d.databases}</span></div>
            <div className="stat"><span className="l row"><Rocket size={13} />Deploys 7d</span><span className="v">{d.deployments_week}</span></div>
            <div className="stat"><span className="l row"><HardDrive size={13} />Backups 7d</span><span className="v">{d.backups_week}</span></div>
          </div>
        </div>
        <div className="card">
          <div className="card-title"><h3 className="row"><Rocket size={17} />Últimos deployments</h3><a className="small" onClick={() => nav('/deployments')} style={{ cursor: 'pointer' }}>Ver todos</a></div>
          <div className="stack" style={{ gap: 8 }}>
            {d.recentDeployments.length === 0 && <span className="muted">Todavía no hay deployments.</span>}
            {d.recentDeployments.map((r: any) => (
              <div key={r.id} className="row between small" style={{ cursor: 'pointer' }} onClick={() => nav(`/aplicaciones/${r.application_id}?tab=deployments`)}>
                <span className="ellipsis" style={{ maxWidth: 190 }}><b>{r.application}</b> <span className="muted">v{r.version} · {ENV_LABEL[r.environment]}</span></span>
                <span className="row" style={{ gap: 6 }}><StatusBadge status={r.status} /><span className="muted">{fmtAgo(r.created_at)}</span></span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="page-head" style={{ marginTop: 26 }}><h2>Aplicaciones</h2></div>
      {!apps ? <Spinner /> : apps.length === 0 ? (
        <div className="card"><Empty title="Todavía no hay aplicaciones">{can('apps.create') && <button className="btn primary" onClick={() => nav('/aplicaciones/nueva')}>+ Nueva aplicación</button>}</Empty></div>
      ) : (
        <div className="grid cards">{apps.map((app) => <AppCard key={app.id} app={app} onChange={reload} />)}</div>
      )}
    </>
  );
}
