import { useNavigate } from 'react-router';
import { Download } from 'lucide-react';
import { api, ENV_LABEL, fmtBytes, fmtDate } from '../api/client';
import { useAuth } from '../auth';
import { Empty, Spinner, StatusBadge, useData } from '../components/ui';

export default function Backups() {
  const { data } = useData<any[]>(() => api('/backups'), [], 20000);
  const { can } = useAuth();
  const nav = useNavigate();
  const total = (data ?? []).reduce((s, b) => s + Number(b.size_bytes || 0), 0);
  return (
    <>
      <div className="page-head"><div><span className="eyebrow">Respaldo</span><h1>Backups</h1>
        <p>Historial de respaldos de aplicaciones y bases de datos. Ocupación total: <b>{fmtBytes(total)}</b>. Para crear, restaurar o programar, ingrese a la aplicación.</p></div></div>
      {!data ? <Spinner /> : !data.length ? <div className="card"><Empty title="Sin backups" /></div> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Fecha</th><th>Aplicación</th><th>Ambiente</th><th>Tipo</th><th>Archivo</th><th>Tamaño</th><th>Origen</th><th>Estado</th><th /></tr></thead>
          <tbody>{data.map((b) => (
            <tr key={b.id}>
              <td className="small nowrap">{fmtDate(b.created_at)}</td>
              <td>{b.application_id ? <a onClick={() => nav(`/aplicaciones/${b.application_id}?tab=backups`)} style={{ cursor: 'pointer' }}><b>{b.application_name}</b></a> : <span className="muted">{b.app_slug} (eliminada)</span>}</td>
              <td>{b.environment ? ENV_LABEL[b.environment] : '—'}</td>
              <td><span className="badge">{b.type === 'app' ? 'Aplicación' : 'PostgreSQL'}</span></td>
              <td className="mono small">{b.file_name ?? '—'}</td><td className="small">{fmtBytes(b.size_bytes)}</td>
              <td className="small">{b.scheduled ? 'Programado' : b.user_name ?? '—'}</td>
              <td><StatusBadge status={b.status === 'running' ? 'queued' : b.status} /></td>
              <td>{can('backups.manage') && b.status === 'success' && <a className="btn ghost icon" href={`/api/backups/${b.id}/download`}><Download size={15} /></a>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}
