import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Copy, Save, Trash2 } from 'lucide-react';
import { api, ENV_LABEL } from '../../api/client';
import { useAuth } from '../../auth';
import { Confirm, Field, Switch, useAction, useData } from '../../components/ui';
import { TabProps } from './OverviewTab';

export default function AdvancedTab({ app, env, reload }: TabProps) {
  const { can } = useAuth();
  const nav = useNavigate();
  const { run, busy } = useAction();
  const { data: techs } = useData<any[]>(() => api('/applications/technologies'), []);
  const { data: registries } = useData<any[]>(() => api('/system/registries'), []);
  const [f, setF] = useState<any>({});
  const [bc, setBc] = useState('');
  const [clone, setClone] = useState({ name: `${app.name} (Desarrollo)`, slug: `${app.slug}-dev`, targetEnvironment: 'development', copyVariables: true, createDatabase: !!env.database_id, deploy: true });
  const [del, setDel] = useState(false);
  const [purge, setPurge] = useState(false);

  useEffect(() => {
    setF({ name: app.name, description: app.description ?? '', technology: app.technology, internalPort: app.internal_port, healthcheckPath: app.healthcheck_path ?? '/', registryId: app.registry_id ?? '' });
    setBc(JSON.stringify(app.build_config ?? {}, null, 2));
  }, [app]);

  const save = () => run(async () => {
    let buildConfig;
    try { buildConfig = JSON.parse(bc || '{}'); } catch { throw new Error('La configuración de build no es JSON válido'); }
    await api(`/applications/${app.id}`, { method: 'PUT', body: { ...f, description: f.description || null, internalPort: Number(f.internalPort), registryId: f.registryId || null, buildConfig } });
    reload();
  }, 'Aplicación actualizada');

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="card stack">
        <h3>Datos generales</h3>
        <div className="grid c3">
          <Field label="Nombre"><input className="input" disabled={!can('apps.edit')} value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Tecnología"><select className="input" disabled={!can('apps.edit')} value={f.technology} onChange={(e) => setF({ ...f, technology: e.target.value })}>{techs?.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select></Field>
          <Field label="Puerto interno por defecto"><input className="input" type="number" disabled={!can('apps.edit')} value={f.internalPort ?? ''} onChange={(e) => setF({ ...f, internalPort: e.target.value })} /></Field>
          <Field label="Health check URL" hint="HTTP 2xx/3xx = OK · 4xx/5xx o timeout = ERROR"><input className="input mono" disabled={!can('apps.edit')} value={f.healthcheckPath ?? ''} onChange={(e) => setF({ ...f, healthcheckPath: e.target.value })} /></Field>
          <Field label="Docker registry" hint="Publica la imagen de cada versión (ej: registry.empresa.local/crm/clientes:1.2.0)">
            <select className="input" disabled={!can('apps.edit')} value={f.registryId} onChange={(e) => setF({ ...f, registryId: e.target.value })}><option value="">Sólo local</option>{registries?.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.url})</option>)}</select>
          </Field>
          <Field label="Descripción"><input className="input" disabled={!can('apps.edit')} value={f.description ?? ''} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        </div>
        <Field label="Configuración de build (JSON)" hint='Ej: {"testCommand":"npm test","runTests":true,"buildCommand":"npm run build"}'>
          <textarea className="input" rows={6} disabled={!can('apps.edit')} value={bc} onChange={(e) => setBc(e.target.value)} />
        </Field>
        {can('apps.edit') && <div className="row"><button className="btn primary right" disabled={busy} onClick={save}><Save size={14} />Guardar</button></div>}
      </div>

      {can('apps.create') && (
        <div className="card stack">
          <h3 className="row"><Copy size={16} />Clonar aplicación</h3>
          <p className="muted small" style={{ margin: 0 }}>Crea un proyecto nuevo con el código de la versión desplegada en {ENV_LABEL[env.name]}, contenedor y puerto propios, variables copiadas (sin credenciales de base) y base de datos nueva opcional.</p>
          <div className="grid c3">
            <Field label="Nombre"><input className="input" value={clone.name} onChange={(e) => setClone({ ...clone, name: e.target.value })} /></Field>
            <Field label="Identificador"><input className="input mono" value={clone.slug} onChange={(e) => setClone({ ...clone, slug: e.target.value })} /></Field>
            <Field label="Ambiente destino"><select className="input" value={clone.targetEnvironment} onChange={(e) => setClone({ ...clone, targetEnvironment: e.target.value })}>{Object.entries(ENV_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          </div>
          <div className="row">
            <Switch checked={clone.copyVariables} onChange={(v) => setClone({ ...clone, copyVariables: v })} label="Copiar variables" />
            <Switch checked={clone.createDatabase} onChange={(v) => setClone({ ...clone, createDatabase: v })} label="Crear base de datos nueva" />
            <Switch checked={clone.deploy} onChange={(v) => setClone({ ...clone, deploy: v })} label="Desplegar al crear" />
            <button className="btn primary right" disabled={busy} onClick={() => run(async () => {
              const r = await api(`/applications/${app.id}/clone`, { body: { ...clone, sourceEnvironment: env.name } });
              nav(`/aplicaciones/${r.application.id}${r.deployment ? `?tab=deployments&dep=${r.deployment.id}` : ''}`);
            }, 'Aplicación clonada')}><Copy size={14} />Clonar</button>
          </div>
        </div>
      )}

      {can('apps.delete') && (
        <div className="card stack" style={{ borderColor: '#f3c9c9' }}>
          <h3 style={{ color: 'var(--err)' }}>Zona peligrosa</h3>
          <div className="row">
            <Switch checked={purge} onChange={setPurge} label="Eliminar también archivos, versiones, volúmenes y bases de datos" />
            <button className="btn danger right" onClick={() => setDel(true)}><Trash2 size={14} />Eliminar aplicación</button>
          </div>
        </div>
      )}
      {del && <Confirm title={`Eliminar ${app.name}`} danger requireText={app.slug} confirmLabel="Eliminar"
        text={purge ? 'Se detendrán todos los ambientes y se borrarán DEFINITIVAMENTE el código, versiones, volúmenes y bases de datos. Los backups se conservan.' : 'Se detendrán y eliminarán los contenedores y el registro. Los archivos y volúmenes se conservan en el servidor.'}
        onConfirm={() => run(async () => { await api(`/applications/${app.id}?purge=${purge}`, { method: 'DELETE' }); nav('/aplicaciones'); }, 'Aplicación eliminada')} onClose={() => setDel(false)} />}
    </div>
  );
}
