import { useNavigate } from 'react-router';
import { GitBranch } from 'lucide-react';
import { api, ENV_LABEL, fmtDate } from '../api/client';
import { Empty, Spinner, useData } from '../components/ui';

const PROVIDER: Record<string, string> = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket', git: 'Git privado' };

export default function GitPage() {
  const { data } = useData<any[]>(() => api('/repositories'), []);
  const nav = useNavigate();
  return (
    <>
      <div className="page-head"><div><span className="eyebrow">Integraciones</span><h1>Git</h1><p>Repositorios vinculados a aplicaciones (GitHub, GitLab, Bitbucket y servidores privados por token o SSH).</p></div></div>
      {!data ? <Spinner /> : !data.length ? <div className="card"><Empty icon={<GitBranch size={36} />} title="No hay repositorios vinculados">Cree una aplicación desde Git o configure el repositorio en la pestaña Git de una aplicación.</Empty></div> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Aplicación</th><th>Proveedor</th><th>Repositorio</th><th>Referencia</th><th>Autenticación</th><th>Último commit</th><th>Auto-deploy</th></tr></thead>
          <tbody>{data.map((r) => (
            <tr key={r.id} className="click" onClick={() => nav(`/aplicaciones/${r.application_id}?tab=git`)}>
              <td><b>{r.application_name}</b></td><td>{PROVIDER[r.provider] ?? r.provider}</td><td className="mono small">{r.url}</td>
              <td className="mono small">{r.commit_sha ? `commit ${r.commit_sha.slice(0, 8)}` : r.tag ? `tag ${r.tag}` : r.branch ?? 'HEAD'}</td>
              <td><span className="badge">{r.auth_type}</span></td>
              <td className="small">{r.last_commit?.slice(0, 8) ?? '—'}<div className="muted">{fmtDate(r.last_sync_at)}</div></td>
              <td>{r.auto_deploy_environment ? <span className="badge sky">{ENV_LABEL[r.auto_deploy_environment]}</span> : '—'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}
