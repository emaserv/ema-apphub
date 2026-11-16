import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { KeyRound, Plus, Server, Trash2 } from 'lucide-react';
import { api, fmtDate } from '../api/client';
import { useAuth } from '../auth';
import { Field, Modal, useAction, useData } from '../components/ui';

export default function SettingsPage() {
  const [params] = useSearchParams();
  const { me, can, refresh } = useAuth();
  const { data: info } = useData(() => api('/system/info'), []);
  const { data: regs, reload } = useData<any[]>(() => api('/system/registries'), []);
  const { run, busy } = useAction();
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [addReg, setAddReg] = useState(false);

  return (
    <>
      <div className="page-head"><div><span className="eyebrow">Plataforma</span><h1>Configuración</h1></div></div>
      {(params.get('cambiar') || me?.mustChangePassword) && <div className="alert warn" style={{ marginBottom: 16 }}>Por seguridad debe cambiar su contraseña antes de continuar.</div>}
      <div className="grid c2">
        <div className="card stack">
          <h3 className="row"><KeyRound size={16} />Cambiar mi contraseña</h3>
          <Field label="Contraseña actual"><input className="input" type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></Field>
          <Field label="Nueva contraseña" hint="Mínimo 10 caracteres, con letras y números"><input className="input" type="password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></Field>
          <Field label="Repetir"><input className="input" type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></Field>
          <div><button className="btn primary" disabled={busy} onClick={() => run(async () => {
            if (pw.newPassword !== pw.confirm) throw new Error('Las contraseñas no coinciden');
            await api('/auth/change-password', { body: { currentPassword: pw.currentPassword, newPassword: pw.newPassword } });
            setPw({ currentPassword: '', newPassword: '', confirm: '' }); await refresh();
          }, 'Contraseña actualizada')}>Actualizar</button></div>
        </div>
        <div className="card stack">
          <h3 className="row"><Server size={16} />Plataforma</h3>
          {info && <table className="table"><tbody>
            {[['Versión', info.version], ['Directorio de datos', info.dataDir], ['Red de aplicaciones', info.appsNetwork], ['Host público', info.publicHost],
              ['Dominio base', info.baseDomain || '—'], ['Traefik', info.traefik ? 'Habilitado' : 'Deshabilitado'], ['Rango de puertos', `${info.portRange[0]} – ${info.portRange[1]}`],
              ['Tamaño máx. de carga', `${info.maxUploadMb} MB`], ['Terminal web', info.terminalEnabled ? 'Habilitada (sólo terminal.access)' : 'Deshabilitada']].map(([k, v]) => (
              <tr key={k}><td className="muted">{k}</td><td className="mono small">{v}</td></tr>))}
          </tbody></table>}
          <a className="btn outline" href="/api/docs" target="_blank" rel="noopener">Documentación de la API (Swagger)</a>
        </div>
      </div>
      <div className="card stack" style={{ marginTop: 16 }}>
        <div className="card-title"><div><h3>Docker registries</h3><p className="muted small" style={{ margin: '4px 0 0' }}>Registry local, Docker Hub, GitHub Container Registry u otro privado. Se asigna por aplicación (pestaña Avanzado).</p></div>
          {can('settings.manage') && <button className="btn sm primary" onClick={() => setAddReg(true)}><Plus size={14} />Agregar</button>}</div>
        <table className="table"><thead><tr><th>Nombre</th><th>Tipo</th><th>URL</th><th>Namespace</th><th>Usuario</th><th>Alta</th><th /></tr></thead>
          <tbody>
            {(regs ?? []).length === 0 && <tr><td colSpan={7} className="muted">Sin registries: las imágenes quedan sólo en el servidor local.</td></tr>}
            {(regs ?? []).map((r) => <tr key={r.id}><td><b>{r.name}</b></td><td>{r.kind}</td><td className="mono small">{r.url}</td><td className="mono small">{r.namespace ?? '—'}</td><td>{r.username ?? '—'}</td><td className="small">{fmtDate(r.created_at)}</td>
              <td>{can('settings.manage') && <button className="btn ghost icon" onClick={() => run(async () => { await api(`/system/registries/${r.id}`, { method: 'DELETE' }); reload(); }, 'Registry eliminado')}><Trash2 size={15} /></button>}</td></tr>)}
          </tbody></table>
      </div>
      {addReg && <RegistryModal onClose={() => setAddReg(false)} onSaved={() => { setAddReg(false); reload(); }} />}
    </>
  );
}

function RegistryModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: '', kind: 'private', url: '', namespace: '', username: '', password: '' });
  const { run, busy } = useAction();
  const presets: Record<string, string> = { dockerhub: 'docker.io', ghcr: 'ghcr.io', local: 'registry.empresa.local:5000', private: '' };
  return (
    <Modal title="Agregar registry" onClose={onClose} footer={<><button className="btn outline" onClick={onClose}>Cancelar</button>
      <button className="btn primary" disabled={busy} onClick={() => run(async () => { await api('/system/registries', { body: { ...f, namespace: f.namespace || null, username: f.username || null, password: f.password || null } }); onSaved(); }, 'Registry agregado')}>Guardar</button></>}>
      <div className="grid c2">
        <Field label="Nombre"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Tipo"><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, url: presets[e.target.value] || f.url })}>
          <option value="local">Registry local</option><option value="dockerhub">Docker Hub</option><option value="ghcr">GitHub Container Registry</option><option value="private">Otro privado</option></select></Field>
        <Field label="URL"><input className="input mono" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></Field>
        <Field label="Namespace" hint="Usuario u organización (ej: emaservicios)"><input className="input mono" value={f.namespace} onChange={(e) => setF({ ...f, namespace: e.target.value })} /></Field>
        <Field label="Usuario"><input className="input" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>
        <Field label="Contraseña / token" hint="Se guarda cifrada"><input className="input" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}
