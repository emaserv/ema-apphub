import { useEffect, useState } from 'react';
import { api, ENV_LABEL, fmtDate } from '../../api/client';
import DeploymentLog from '../../components/DeploymentLog';
import { Empty, Spinner, StatusBadge, useData } from '../../components/ui';
import { TabProps } from './OverviewTab';

const TRIGGER: Record<string, string> = { manual: 'Manual', git: 'Git', webhook: 'Webhook', rollback: 'Rollback', auto_rollback: 'Rollback automático', clone: 'Clonación', restore: 'Restauración', promote: 'Pase de ambiente' };

export default function DeploymentsTab({ app, reload, focus }: TabProps & { focus?: string | null }) {
  const { data, reload: reloadList } = useData<any[]>(() => api(`/applications/${app.id}/deployments`), [app.id], 5000);
  const [sel, setSel] = useState<string | null>(focus ?? null);
  useEffect(() => { if (!sel && data?.length) setSel(data[0].id); }, [data, sel]);

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.4fr)' }}>
      <div className="card" style={{ padding: 0 }}>
        {!data ? <Spinner /> : !data.length ? <Empty title="Sin deployments" /> : (
          <table className="table">
            <thead><tr><th>Fecha</th><th>Versión</th><th>Ambiente</th><th>Estado</th></tr></thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.id} className="click" style={sel === d.id ? { background: 'var(--ema-sky-100)' } : undefined} onClick={() => setSel(d.id)}>
                  <td className="small nowrap">{fmtDate(d.created_at)}<div className="muted">{d.user_name ?? TRIGGER[d.trigger]}</div></td>
                  <td><b>v{d.version}</b>{d.previous_version && <div className="muted small">desde v{d.previous_version}</div>}</td>
                  <td><span className="badge sky">{ENV_LABEL[d.environment]}</span><div className="muted small">{d.promoted_from ? `Desde ${ENV_LABEL[d.promoted_from]}` : TRIGGER[d.trigger]}</div></td>
                  <td><StatusBadge status={d.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">{sel ? <DeploymentLog key={sel} id={sel} onDone={() => { reloadList(); reload(); }} /> : <span className="muted">Seleccione un deployment.</span>}</div>
    </div>
  );
}
