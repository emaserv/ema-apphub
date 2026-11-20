import { useEffect, useState } from 'react';
import { Plus, RotateCw, Save, Trash2 } from 'lucide-react';
import { api, ENV_LABEL, SHOW_DOMAIN } from '../../api/client';
import { useAuth } from '../../auth';
import { VolumeRow, VolumesEditor } from '../../components/Editors';
import { Confirm, Field, Switch, useAction } from '../../components/ui';
import { TabProps } from './OverviewTab';

export default function EnvironmentTab({ app, env, reload }: TabProps) {
  const { can } = useAuth();
  const { run, busy } = useAction();
  const ro = !can('apps.edit');
  const [f, setF] = useState<any>({});
  const [volumes, setVolumes] = useState<VolumeRow[]>([]);
  const [extra, setExtra] = useState<{ internal: number; external: number; protocol?: string }[]>([]);
  const [portMsg, setPortMsg] = useState<string | null>(null);
  const [restart, setRestart] = useState(false);
  const [del, setDel] = useState(false);

  useEffect(() => {
    setF({ externalPort: env.external_port ?? '', internalPort: env.internal_port ?? '', domain: env.domain ?? '', httpsEnabled: env.https_enabled,
      pathPrefix: env.path_prefix ?? '', memoryLimitMb: env.memory_limit_mb ?? '', cpuLimit: env.cpu_limit ?? '', isDefault: env.is_default });
    setVolumes(env.volumes ?? []); setExtra(env.extra_ports ?? []); setRestart(false);
  }, [env]);

  // La ruta es obligatoria salvo que el ambiente tenga dominio propio
  const pathMissing = !String(f.pathPrefix ?? '').replace(/\//g, '') && !f.domain;

  const check = async () => {
    if (!f.externalPort || Number(f.externalPort) === env.external_port) return setPortMsg(null);
    const r = await api('/system/ports/check', { query: { port: f.externalPort, environmentId: env.id } });
    setPortMsg(r.free ? null : `${r.reason}. Sugerido: ${r.suggested}`);
  };

  const save = () => run(async () => {
    const num = (v: any) => (v === '' || v === null ? null : Number(v));
    const r = await api(`/applications/${app.id}/environments/${env.name}`, { method: 'PUT', body: {
      externalPort: num(f.externalPort), internalPort: num(f.internalPort), domain: f.domain || null, httpsEnabled: f.httpsEnabled,
      pathPrefix: f.pathPrefix || null, memoryLimitMb: num(f.memoryLimitMb), cpuLimit: num(f.cpuLimit), isDefault: f.isDefault || undefined,
      volumes: volumes.filter((v) => v.source && v.target), extraPorts: extra.filter((p) => p.internal && p.external),
    } });
    setRestart(r.restartRequired); reload();
  }, 'Configuración guardada');

  return (
    <div className="stack" style={{ gap: 16 }}>
      {restart && <div className="alert warn row">Los cambios se aplican al recrear el contenedor.
        <button className="btn sm primary right" onClick={() => run(async () => { await api(`/applications/${app.id}/recreate`, { body: { environment: env.name } }); setRestart(false); reload(); }, 'Contenedor recreado')}><RotateCw size={13} />Aplicar ahora</button></div>}
      <div className="card stack">
        <h3>Puertos</h3>
        <div className="grid c4">
          <Field label="Puerto interno" hint={`Por defecto el de la app (${app.internal_port})`}><input className="input" type="number" disabled={ro} value={f.internalPort} onChange={(e) => setF({ ...f, internalPort: e.target.value })} placeholder={String(app.internal_port)} /></Field>
          <Field label="Puerto externo" hint={portMsg ? <span style={{ color: 'var(--err)' }}>{portMsg}</span> : 'Se detectan conflictos antes de guardar y de cada deploy'}>
            <input className="input" type="number" disabled={ro} value={f.externalPort} onChange={(e) => setF({ ...f, externalPort: e.target.value })} onBlur={check} />
          </Field>
          <Field label="Límite de memoria (MB)" hint="Si la app lo supera, Docker la reinicia. Vacío = sin límite (puede afectar a las demás apps del servidor).">
            <input className="input" type="number" disabled={ro} value={f.memoryLimitMb} onChange={(e) => setF({ ...f, memoryLimitMb: e.target.value })} placeholder="sin límite" />
          </Field>
          <Field label="Límite de CPU (núcleos)"><input className="input" type="number" step="0.25" disabled={ro} value={f.cpuLimit} onChange={(e) => setF({ ...f, cpuLimit: e.target.value })} placeholder="sin límite" /></Field>
        </div>
        <div className="field">Puertos adicionales</div>
        {extra.map((p, i) => (
          <div key={i} className="row">
            <input className="input" style={{ width: 130 }} type="number" placeholder="externo" disabled={ro} value={p.external || ''} onChange={(e) => setExtra(extra.map((x, j) => (j === i ? { ...x, external: Number(e.target.value) } : x)))} />
            <span>→</span>
            <input className="input" style={{ width: 130 }} type="number" placeholder="interno" disabled={ro} value={p.internal || ''} onChange={(e) => setExtra(extra.map((x, j) => (j === i ? { ...x, internal: Number(e.target.value) } : x)))} />
            <select className="input" style={{ width: 90 }} disabled={ro} value={p.protocol ?? 'tcp'} onChange={(e) => setExtra(extra.map((x, j) => (j === i ? { ...x, protocol: e.target.value } : x)))}><option>tcp</option><option>udp</option></select>
            {!ro && <button className="btn ghost icon" onClick={() => setExtra(extra.filter((_, j) => j !== i))}><Trash2 size={15} /></button>}
          </div>
        ))}
        {!ro && <div><button className="btn sm outline" onClick={() => setExtra([...extra, { internal: 0, external: 0 }])}><Plus size={14} />Agregar puerto</button></div>}
      </div>
      <div className="card stack">
        <h3>Publicación</h3>
        <div className="grid c3">
          <Field label="Ruta *" hint={pathMissing ? <span style={{ color: 'var(--err)' }}>Obligatoria (ej. /{app.slug})</span> : 'Única por ambiente. La app debe funcionar dentro de esta ruta (ver instructivo)'}>
            <input className="input mono" disabled={ro} value={f.pathPrefix ?? ''} onChange={(e) => setF({ ...f, pathPrefix: e.target.value.trim().toLowerCase() })} placeholder={`/${app.slug}`} />
          </Field>
          <Field label="Dirección">{env.url ? <a className="mono" href={env.url} target="_blank" rel="noreferrer">{env.url}</a> : <span className="muted">Sin publicar</span>}</Field>
          <Field label="Ambiente principal"><Switch checked={!!f.isDefault} disabled={ro || env.is_default} onChange={(v) => setF({ ...f, isDefault: v })} label="Usar como ambiente por defecto" /></Field>
        </div>
        {(SHOW_DOMAIN || env.domain) && (
          <div className="grid c3">
            <Field label="Dominio" hint="Opcional. Subdominio propio para la app (requiere DNS hacia este servidor). Para publicar sólo por ruta, dejar vacío."><input className="input mono" disabled={ro} value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value.trim().toLowerCase() })} placeholder="crm.emaservicios.com.ar" /></Field>
            <Field label="HTTPS"><Switch checked={!!f.httpsEnabled} disabled={ro} onChange={(v) => setF({ ...f, httpsEnabled: v })} label="Certificado Let's Encrypt + redirección HTTP→HTTPS" /></Field>
          </div>
        )}
      </div>
      <div className="card stack"><h3>Volúmenes</h3><VolumesEditor rows={volumes} onChange={setVolumes} readOnly={ro} /></div>
      {!ro && (
        <div className="row">
          {can('apps.delete') && app.environments.length > 1 && <button className="btn danger" onClick={() => setDel(true)}><Trash2 size={14} />Eliminar ambiente {ENV_LABEL[env.name]}</button>}
          <button className="btn primary right" disabled={busy || pathMissing} title={pathMissing ? 'Complete la ruta' : undefined} onClick={save}><Save size={14} />Guardar configuración</button>
        </div>
      )}
      {del && <Confirm title={`Eliminar ambiente ${ENV_LABEL[env.name]}`} danger requireText={env.name} confirmLabel="Eliminar"
        text="Se detendrán y eliminarán los contenedores, volúmenes y la base de datos de este ambiente. Esta acción no se puede deshacer."
        onConfirm={() => run(async () => { await api(`/applications/${app.id}/environments/${env.name}`, { method: 'DELETE' }); location.search = ''; }, 'Ambiente eliminado')} onClose={() => setDel(false)} />}
    </div>
  );
}
