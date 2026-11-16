import { useNavigate } from 'react-router';
import { ExternalLink, Rocket, ScrollText } from 'lucide-react';
import { api, ENV_LABEL, fmtBytes } from '../api/client';
import { useAuth } from '../auth';
import { StatusBadge, useAction } from './ui';

export default function AppCard({ app, onChange }: { app: any; onChange?: () => void }) {
  const nav = useNavigate();
  const { can } = useAuth();
  const { run, busy } = useAction();
  const env = app.main_environment;
  const stats = env?.stats;
  const cls = app.state === 'error' ? 'err' : app.state === 'running' ? '' : 'stopped';
  const canDeploy = env && can(env.name === 'production' ? 'apps.deploy.prod' : 'apps.deploy.nonprod');

  return (
    <div className={`card app-card ${cls}`}>
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <h3 className="ellipsis" style={{ cursor: 'pointer' }} onClick={() => nav(`/aplicaciones/${app.id}`)}>{app.name}</h3>
          <div className="muted small">{app.framework_label || app.technology_label}</div>
        </div>
        {app.current_version && <span className="badge">v{app.current_version}</span>}
      </div>
      <div className="row"><StatusBadge status={app.state === 'error' && env?.status === 'running' ? 'unhealthy' : app.state} />{env && <span className="badge sky">{ENV_LABEL[env.name]}</span>}</div>
      <div className="kv">
        <span>CPU</span><span>{stats ? `${stats.cpuPercent}%` : '—'}</span>
        <span>RAM</span><span>{stats ? fmtBytes(stats.memoryBytes) : '—'}</span>
        <span>Puerto</span><span>{env?.external_port ?? '—'}</span>
        <span>Base</span><span>{env?.database_engine ? 'PostgreSQL' : '—'}</span>
      </div>
      <div className="row" style={{ marginTop: 'auto' }}>
        <button className="btn sm outline" disabled={!env?.url} onClick={() => env?.url && window.open(env.url, '_blank', 'noopener')}><ExternalLink size={13} />Abrir</button>
        {can('apps.logs') && <button className="btn sm outline" onClick={() => nav(`/aplicaciones/${app.id}?tab=logs`)}><ScrollText size={13} />Logs</button>}
        {canDeploy && app.current_version && (
          <button className="btn sm primary" disabled={busy} onClick={() => run(async () => {
            const dep = await api(`/applications/${app.id}/deploy`, { body: { environment: env.name } });
            onChange?.();
            nav(`/aplicaciones/${app.id}?tab=deployments&dep=${dep.id}`);
          }, 'Deploy iniciado')}><Rocket size={13} />Deploy</button>
        )}
      </div>
    </div>
  );
}
