import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Archive, ArrowLeft, ArrowRightLeft, Boxes, Container, Database, ExternalLink, FileCode2, GitBranch, History, LayoutDashboard, Play, Plus, RotateCcw,
  RotateCw, Rocket, ScrollText, Settings2, Square, SquareTerminal, Variable, Wrench,
} from 'lucide-react';
import { api, ENV_LABEL, ENV_ORDER } from '../api/client';
import { useAuth } from '../auth';
import { Confirm, Modal, Spinner, StatusBadge, Tabs, useAction, useData } from '../components/ui';
import LogViewer from '../components/LogViewer';
import WebTerminal from '../components/WebTerminal';
import OverviewTab from './app/OverviewTab';
import VersionsTab from './app/VersionsTab';
import DeploymentsTab from './app/DeploymentsTab';
import VariablesTab from './app/VariablesTab';
import EnvironmentTab from './app/EnvironmentTab';
import DockerTab from './app/DockerTab';
import DatabaseTab from './app/DatabaseTab';
import BackupsTab from './app/BackupsTab';
import GitTab from './app/GitTab';
import AdvancedTab from './app/AdvancedTab';

export type TabId = 'overview' | 'versions' | 'deployments' | 'variables' | 'environment' | 'docker' | 'database' | 'logs' | 'terminal' | 'backups' | 'git' | 'advanced';

export default function ApplicationDetail() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const { run, busy } = useAction();
  const { data: app, reload, error } = useData(() => api(`/applications/${id}`), [id], 15000);
  const tab = (params.get('tab') as TabId) || 'overview';
  const [envName, setEnvName] = useState<string | null>(params.get('env'));
  const [logService, setLogService] = useState<'app' | 'db'>('app');
  const [confirm, setConfirm] = useState<null | { action: string; label: string }>(null);
  const [newEnv, setNewEnv] = useState(false);
  const [promote, setPromote] = useState(false);

  useEffect(() => {
    if (app && (!envName || !app.environments.some((e: any) => e.name === envName))) setEnvName(app.environments.find((e: any) => e.is_default)?.name ?? app.environments[0]?.name);
  }, [app, envName]);

  if (error) return <div className="alert err">{error}</div>;
  if (!app || !envName) return <Spinner />;
  const env = app.environments.find((e: any) => e.name === envName) ?? app.environments[0];
  const setTab = (t: TabId) => { params.set('tab', t); params.delete('dep'); setParams(params, { replace: true }); };
  const canDeploy = can(env.name === 'production' ? 'apps.deploy.prod' : 'apps.deploy.nonprod');
  const canDeployTo = (name: string) => can(name === 'production' ? 'apps.deploy.prod' : 'apps.deploy.nonprod');
  // El botón se muestra siempre que haya una versión funcionando; si no hay destino posible, el modal explica por qué
  const canPromote = env.status === 'running' && !!env.deployed_version_id && ENV_ORDER.some((n) => n !== env.name && canDeployTo(n));
  const promoteTargets = canPromote
    ? app.environments.filter((e: any) => e.name !== env.name && e.deployed_version_id !== env.deployed_version_id && canDeployTo(e.name)) : [];
  const healthStatus = env.status === 'running' ? (env.health_status === 'unhealthy' ? 'unhealthy' : 'running') : env.status;

  const doAction = (action: string, label: string) => run(async () => {
    const r = await api(`/applications/${app.id}/${action}`, { body: { environment: env.name } });
    await reload();
    if (r?.id && (action === 'deploy' || action === 'rollback')) { params.set('tab', 'deployments'); params.set('dep', r.id); setParams(params); }
  }, `${label}: solicitado`);

  const props = { app, env, reload };

  return (
    <>
      <div className="page-head">
        <div>
          <button className="btn ghost sm" style={{ padding: 0, marginBottom: 6 }} onClick={() => nav('/aplicaciones')}><ArrowLeft size={14} />Aplicaciones</button>
          <div className="row"><h1>{app.name}</h1>{env.deployed_version && <span className="badge">v{env.deployed_version}</span>}<StatusBadge status={healthStatus} /></div>
          <p>{app.framework_label || app.technology_label} · <code>{app.slug}</code>{app.description && ` · ${app.description}`}</p>
        </div>
        <div className="row">
          {env.url && <button className="btn outline" onClick={() => window.open(env.url, '_blank', 'noopener')}><ExternalLink size={15} />Abrir</button>}
          {can('apps.operate') && env.deployed_version_id && (env.status === 'stopped'
            ? <button className="btn outline" disabled={busy} onClick={() => doAction('start', 'Iniciar')}><Play size={15} />Iniciar</button>
            : <button className="btn outline" disabled={busy} onClick={() => setConfirm({ action: 'stop', label: 'Detener' })}><Square size={15} />Detener</button>)}
          {can('apps.operate') && env.deployed_version_id && <button className="btn outline" disabled={busy} onClick={() => doAction('restart', 'Reiniciar')}><RotateCw size={15} />Reiniciar</button>}
          {canPromote && <button className="btn outline" disabled={busy} onClick={() => setPromote(true)}
            title="Desplegar en otro ambiente la misma imagen que corre acá, sin recompilar"><ArrowRightLeft size={15} />Pasar a…</button>}
          {canDeploy && env.deployed_version_id && <button className="btn outline" disabled={busy} onClick={() => setConfirm({ action: 'rollback', label: 'Rollback' })}><RotateCcw size={15} />Rollback</button>}
          {canDeploy && app.current_version && <button className="btn primary" disabled={busy || env.status === 'deploying'} onClick={() => doAction('deploy', 'Deploy')}><Rocket size={15} />Deploy</button>}
        </div>
      </div>

      <div className="row" style={{ marginBottom: 16 }}>
        <span className="muted small">Ambiente:</span>
        <div className="seg">
          {[...app.environments].sort((a: any, b: any) => ENV_ORDER.indexOf(a.name) - ENV_ORDER.indexOf(b.name)).map((e: any) => (
            <button key={e.id} className={e.name === env.name ? 'active' : ''} onClick={() => setEnvName(e.name)}>
              <span className={`dot ${e.status === 'running' ? (e.health_status === 'unhealthy' ? 'err' : 'ok') : e.status === 'error' ? 'err' : e.status === 'deploying' ? 'warn' : ''}`} style={{ marginRight: 6 }} />
              {ENV_LABEL[e.name]}
            </button>
          ))}
        </div>
        {can('apps.edit') && app.environments.length < 4 && <button className="btn sm ghost" onClick={() => setNewEnv(true)}><Plus size={14} />Ambiente</button>}
      </div>

      <Tabs<TabId> value={tab} onChange={setTab} items={[
        { id: 'overview', label: 'Resumen', icon: <LayoutDashboard size={15} /> },
        { id: 'versions', label: 'Versiones', icon: <History size={15} /> },
        { id: 'deployments', label: 'Deployments', icon: <Rocket size={15} /> },
        { id: 'variables', label: 'Variables', icon: <Variable size={15} /> },
        { id: 'environment', label: 'Puertos y dominio', icon: <Settings2 size={15} /> },
        { id: 'docker', label: 'Docker', icon: <Container size={15} /> },
        { id: 'database', label: 'Base de datos', icon: <Database size={15} />, hidden: !can('db.view') },
        { id: 'logs', label: 'Logs', icon: <ScrollText size={15} />, hidden: !can('apps.logs') },
        { id: 'terminal', label: 'Terminal', icon: <SquareTerminal size={15} />, hidden: !can('terminal.access') },
        { id: 'backups', label: 'Backups', icon: <Archive size={15} />, hidden: !can('backups.view') },
        { id: 'git', label: 'Git', icon: <GitBranch size={15} /> },
        { id: 'advanced', label: 'Avanzado', icon: <Wrench size={15} /> },
      ]} />

      {tab === 'overview' && <OverviewTab {...props} />}
      {tab === 'versions' && <VersionsTab {...props} />}
      {tab === 'deployments' && <DeploymentsTab {...props} focus={params.get('dep')} />}
      {tab === 'variables' && <VariablesTab {...props} />}
      {tab === 'environment' && <EnvironmentTab {...props} />}
      {tab === 'docker' && <DockerTab {...props} />}
      {tab === 'database' && <DatabaseTab {...props} />}
      {tab === 'logs' && (
        <div className="card stack">
          <div className="row"><div className="seg"><button className={logService === 'app' ? 'active' : ''} onClick={() => setLogService('app')}><Boxes size={13} /> Aplicación</button>
            <button className={logService === 'db' ? 'active' : ''} onClick={() => setLogService('db')}><Database size={13} /> PostgreSQL</button></div>
            <span className="muted small mono">ema-{app.slug}-{env.name}{logService === 'db' ? '-db' : ''}</span></div>
          <LogViewer key={`${env.name}-${logService}`} appId={app.id} environment={env.name} service={logService} />
        </div>
      )}
      {tab === 'terminal' && (
        <div className="card stack">
          <div className="row"><div className="seg"><button className={logService === 'app' ? 'active' : ''} onClick={() => setLogService('app')}><FileCode2 size={13} /> App</button>
            <button className={logService === 'db' ? 'active' : ''} onClick={() => setLogService('db')}><Database size={13} /> PostgreSQL</button></div></div>
          <WebTerminal key={`${env.name}-${logService}`} appId={app.id} environment={env.name} service={logService} />
        </div>
      )}
      {tab === 'backups' && <BackupsTab {...props} />}
      {tab === 'git' && <GitTab {...props} />}
      {tab === 'advanced' && <AdvancedTab {...props} />}

      {confirm && (
        <Confirm title={`${confirm.label} — ${ENV_LABEL[env.name]}`} danger={confirm.action === 'stop'} confirmLabel={confirm.label}
          text={confirm.action === 'stop' ? `Se detendrá ${app.name} en ${ENV_LABEL[env.name]}. Los usuarios no podrán acceder.` : `Se volverá a la última versión exitosa anterior a v${env.deployed_version}.`}
          onConfirm={() => doAction(confirm.action, confirm.label)} onClose={() => setConfirm(null)} />
      )}
      {promote && <PromoteModal app={app} source={env} targets={promoteTargets} canCreateEnv={can('apps.edit') && app.environments.length < 4}
        onNewEnv={() => { setPromote(false); setNewEnv(true); }} onClose={() => setPromote(false)} onDone={(target, depId) => {
        setPromote(false); setEnvName(target); void reload();
        params.set('env', target); params.set('tab', 'deployments'); params.set('dep', depId); setParams(params);
      }} />}
      {newEnv && <NewEnvModal app={app} onClose={() => setNewEnv(false)} onCreated={(n) => { setNewEnv(false); setEnvName(n); void reload(); }} />}
    </>
  );
}

function NewEnvModal({ app, onClose, onCreated }: { app: any; onClose: () => void; onCreated: (name: string) => void }) {
  const free = ENV_ORDER.filter((n) => !app.environments.some((e: any) => e.name === n));
  const [name, setName] = useState(free[0]);
  const [copy, setCopy] = useState<string>(app.environments[0]?.name ?? '');
  const [domain, setDomain] = useState('');
  const { run, busy } = useAction();
  return (
    <Modal title="Nuevo ambiente" onClose={onClose} footer={<><button className="btn outline" onClick={onClose}>Cancelar</button>
      <button className="btn primary" disabled={busy} onClick={() => run(async () => {
        await api(`/applications/${app.id}/environments`, { body: { name, copyVariablesFrom: copy || undefined, domain: domain || null } });
        onCreated(name);
      }, 'Ambiente creado')}>Crear</button></>}>
      <div className="stack">
        <label className="field">Ambiente<select className="input" value={name} onChange={(e) => setName(e.target.value)}>{free.map((n) => <option key={n} value={n}>{ENV_LABEL[n]}</option>)}</select></label>
        <label className="field">Copiar variables desde<select className="input" value={copy} onChange={(e) => setCopy(e.target.value)}><option value="">— No copiar —</option>{app.environments.map((e: any) => <option key={e.name} value={e.name}>{ENV_LABEL[e.name]}</option>)}</select></label>
        <label className="field">Dominio (opcional)<input className="input mono" value={domain} onChange={(e) => setDomain(e.target.value.trim().toLowerCase())} placeholder={`${app.slug}-${name}.emaservicios.com.ar`} /></label>
        <p className="muted small" style={{ margin: 0 }}>Se asignará un puerto externo libre automáticamente. Cada ambiente tiene su propio contenedor, variables, base de datos, puerto y dominio.</p>
      </div>
    </Modal>
  );
}

/** Pasar la versión que corre en `source` a otro ambiente con la misma imagen (sin recompilar). */
function PromoteModal({ app, source, targets, canCreateEnv, onNewEnv, onClose, onDone }: {
  app: any; source: any; targets: any[]; canCreateEnv: boolean; onNewEnv: () => void; onClose: () => void; onDone: (target: string, depId: string) => void;
}) {
  if (!targets.length) {
    const single = app.environments.length === 1;
    return (
      <Modal title={`Pasar v${source.deployed_version} de ${ENV_LABEL[source.name]} a otro ambiente`} onClose={onClose} footer={<>
        <button className="btn outline" onClick={onClose}>Cerrar</button>
        {canCreateEnv && <button className="btn primary" onClick={onNewEnv}><Plus size={14} />Crear ambiente</button>}</>}>
        <p style={{ margin: 0 }}>
          {single
            ? <>Esta aplicación tiene un solo ambiente ({ENV_LABEL[source.name]}). Para pasar versiones, primero cree otro (por ejemplo Test o Producción) con <b>+ Ambiente</b>.</>
            : <>No hay ambientes a los que pasar esta versión: los demás ya tienen v{source.deployed_version} o usted no tiene permiso para desplegar en ellos.</>}
        </p>
      </Modal>
    );
  }
  return <PromoteForm app={app} source={source} targets={targets} onClose={onClose} onDone={onDone} />;
}

function PromoteForm({ app, source, targets, onClose, onDone }: {
  app: any; source: any; targets: any[]; onClose: () => void; onDone: (target: string, depId: string) => void;
}) {
  const sorted = [...targets].sort((a, b) => ENV_ORDER.indexOf(a.name) - ENV_ORDER.indexOf(b.name));
  // Por defecto, el siguiente ambiente "hacia Producción" (Desarrollo → Test → Staging → Producción)
  const next = sorted.find((e) => ENV_ORDER.indexOf(e.name) > ENV_ORDER.indexOf(source.name)) ?? sorted[0];
  const [to, setTo] = useState<string>(next.name);
  const { run, busy } = useAction();
  const target = sorted.find((e) => e.name === to)!;
  return (
    <Modal title={`Pasar v${source.deployed_version} de ${ENV_LABEL[source.name]} a otro ambiente`} onClose={onClose} footer={<>
      <button className="btn outline" onClick={onClose}>Cancelar</button>
      <button className="btn primary" disabled={busy} onClick={() => run(async () => {
        const dep = await api(`/applications/${app.id}/promote`, { body: { from: source.name, to } });
        onDone(to, dep.id);
      }, 'Pase solicitado')}>{busy && <span className="spinner" />}Pasar a {ENV_LABEL[to]}</button></>}>
      <div className="stack">
        <label className="field">Ambiente de destino
          <select className="input" value={to} onChange={(e) => setTo(e.target.value)}>
            {sorted.map((e) => <option key={e.name} value={e.name}>{ENV_LABEL[e.name]}{e.deployed_version ? ` (hoy tiene v${e.deployed_version})` : ' (sin deploys)'}</option>)}
          </select>
        </label>
        <p style={{ margin: 0 }}>
          Se va a desplegar en <b>{ENV_LABEL[to]}</b> exactamente la misma imagen de <b>v{source.deployed_version}</b> que funciona en {ENV_LABEL[source.name]},
          sin volver a compilarla.{target.deployed_version && <> Reemplaza a v{target.deployed_version}; si el deploy falla, vuelve sola a esa versión.</>}
        </p>
        <p className="muted small" style={{ margin: 0 }}>
          Las variables, la base de datos, el puerto y el dominio de {ENV_LABEL[to]} no cambian.
          {to === 'production' && ' En Producción se vuelve a escanear la imagen y se bloquea si tiene vulnerabilidades críticas.'}
        </p>
        {source.health_status === 'unhealthy' && <div className="alert warn">{ENV_LABEL[source.name]} está fallando el health check: revise que la versión funcione antes de pasarla.</div>}
      </div>
    </Modal>
  );
}
