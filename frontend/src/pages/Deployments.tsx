import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, ENV_LABEL, fmtDate } from '../api/client';
import DeploymentLog from '../components/DeploymentLog';
import { Empty, Modal, Spinner, StatusBadge, useData } from '../components/ui';

export default function Deployments() {
  const [status, setStatus] = useState('');
  const { data } = useData<any[]>(() => api('/deployments', { query: { status } }), [status], 5000);
  const [sel, setSel] = useState<string | null>(null);
  const nav = useNavigate();
  const dur = (d: any) => (d.started_at && d.finished_at ? `${Math.round((new Date(d.finished_at).getTime() - new Date(d.started_at).getTime()) / 1000)} s` : '—');
  return (
    <>
      <div className="page-head">
        <div><span className="eyebrow">CI/CD</span><h1>Deployments</h1><p>Código → Validación → Build → Tests → Imagen → Deploy → Health check, con rollback automático.</p></div>
        <div className="seg">{[['', 'Todos'], ['running', 'En curso'], ['success', 'Exitosos'], ['failed', 'Fallidos'], ['rolled_back', 'Rollback']].map(([k, l]) => <button key={k} className={status === k ? 'active' : ''} onClick={() => setStatus(k)}>{l}</button>)}</div>
      </div>
      {!data ? <Spinner /> : !data.length ? <div className="card"><Empty title="Sin deployments" /></div> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Fecha</th><th>Aplicación</th><th>Versión</th><th>Ambiente</th><th>Disparador</th><th>Usuario</th><th>Duración</th><th>Estado</th></tr></thead>
          <tbody>{data.map((d) => (
            <tr key={d.id} className="click" onClick={() => setSel(d.id)}>
              <td className="small nowrap">{fmtDate(d.created_at)}</td>
              <td><a onClick={(e) => { e.stopPropagation(); nav(`/aplicaciones/${d.application_id}`); }}><b>{d.application_name}</b></a></td>
              <td>v{d.version}</td><td><span className="badge sky">{ENV_LABEL[d.environment]}</span></td>
              <td className="small">{d.trigger}</td><td className="small">{d.user_name ?? '—'}</td><td className="small">{dur(d)}</td>
              <td><StatusBadge status={d.status} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {sel && <Modal size="lg" title="Detalle del deployment" onClose={() => setSel(null)}><DeploymentLog id={sel} /></Modal>}
    </>
  );
}
