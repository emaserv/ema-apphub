import { useState } from 'react';
import { Copy, Database, KeyRound, Plus, RotateCw, Trash2, Archive } from 'lucide-react';
import { api, ENV_LABEL, fmtBytes, fmtDate } from '../../api/client';
import { useAuth } from '../../auth';
import { Confirm, Empty, Field, Modal, Spinner, StatusBadge, useAction, useData, useToast } from '../../components/ui';
import DataPanel from './DataPanel';
import { TabProps } from './OverviewTab';

export default function DatabaseTab({ app, env, reload }: TabProps) {
  const { data: db, reload: reloadDb, loading } = useData(() => api(`/applications/${app.id}/database`, { query: { environment: env.name } }), [app.id, env.name], 15000);
  const { can } = useAuth();
  const { run, busy } = useAction();
  const toast = useToast();
  const [form, setForm] = useState({ databaseName: app.slug.replace(/-/g, '_'), username: `${app.slug.replace(/-/g, '_')}_user`, version: '16' });
  const [addUser, setAddUser] = useState(false);
  const [rotate, setRotate] = useState<any>(null);
  const [delUser, setDelUser] = useState<any>(null);
  const [delDb, setDelDb] = useState(false);
  const manage = can('db.manage');

  if (loading && db === null) return <Spinner />;
  if (!db) {
    return (
      <div className="card">
        <Empty icon={<Database size={36} />} title={`${ENV_LABEL[env.name]} no tiene base de datos`}>
          {manage && (
            <div className="stack" style={{ maxWidth: 620, margin: '10px auto', textAlign: 'left' }}>
              <div className="grid c3">
                <Field label="Base de datos"><input className="input mono" value={form.databaseName} onChange={(e) => setForm({ ...form, databaseName: e.target.value })} /></Field>
                <Field label="Usuario propietario"><input className="input mono" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></Field>
                <Field label="Versión PostgreSQL"><select className="input" value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })}>{['17', '16', '15', '14'].map((v) => <option key={v}>{v}</option>)}</select></Field>
              </div>
              <button className="btn primary" disabled={busy} onClick={() => run(async () => { await api(`/applications/${app.id}/database`, { body: { ...form, environment: env.name } }); reloadDb(); reload(); }, 'Base de datos creada')}>
                {busy ? <span className="spinner" /> : <Plus size={15} />}Crear PostgreSQL
              </button>
            </div>
          )}
        </Empty>
      </div>
    );
  }

  const copy = (t: string) => { void navigator.clipboard.writeText(t); toast('Copiado'); };
  const cx = db.connection;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="grid c2">
        <div className="card stack">
          <div className="card-title"><h3 className="row"><Database size={16} />PostgreSQL {db.engine_version}</h3><StatusBadge status={db.container?.health === 'healthy' ? 'running' : db.status} /></div>
          <table className="table"><tbody>
            {[['Aplicación', app.name], ['Host', cx.host], ['Puerto', cx.port], ['Database', cx.database], ['Usuario', cx.username], ['Contraseña', '******** (cifrada)'],
              ['Contenedor', db.container_name], ['Volumen', db.volume_name], ['Tamaño', fmtBytes(db.sizeBytes)], ['Creada', fmtDate(db.created_at)]].map(([k, v]) => (
              <tr key={k as string}><td className="muted" style={{ width: 140 }}>{k}</td><td className="mono">{v}</td></tr>
            ))}
          </tbody></table>
          <div className="row"><code className="badge" style={{ whiteSpace: 'normal' }}>{cx.url}</code><button className="btn ghost icon" onClick={() => copy(cx.url)}><Copy size={14} /></button></div>
          <p className="muted small" style={{ margin: 0 }}>La app recibe la conexión en <code>DATABASE_URL</code>. El host sólo es accesible dentro de la red interna del ambiente.</p>
        </div>
        <div className="card stack">
          <h3>Acciones</h3>
          {db.stats && <div className="row small muted"><span>CPU {db.stats.cpuPercent}%</span><span>RAM {fmtBytes(db.stats.memoryBytes)}</span></div>}
          {manage && (
            <div className="row">
              <button className="btn outline" disabled={busy} onClick={() => run(async () => { await api(`/applications/${app.id}/database/restart`, { body: { environment: env.name } }); reloadDb(); }, 'Base reiniciada')}><RotateCw size={14} />Reiniciar</button>
              {can('backups.manage') && <button className="btn outline" disabled={busy} onClick={() => run(async () => { await api(`/applications/${app.id}/backup`, { body: { environment: env.name, type: 'database' } }); }, 'Backup (pg_dump) generado')}><Archive size={14} />Backup ahora</button>}
              <button className="btn danger" onClick={() => setDelDb(true)}><Trash2 size={14} />Eliminar</button>
            </div>
          )}
          <p className="muted small">Logs: pestaña <b>Logs → PostgreSQL</b>. Restaurar: pestaña <b>Backups</b>.</p>
        </div>
      </div>
      {db.container?.running && <DataPanel app={app} env={env} reload={reload} />}
      <div className="card stack">
        <div className="card-title"><h3>Usuarios y credenciales</h3>{manage && <button className="btn sm primary" onClick={() => setAddUser(true)}><Plus size={14} />Nuevo usuario</button>}</div>
        <table className="table">
          <thead><tr><th>Usuario</th><th>Privilegios</th><th>Creado</th><th>Última rotación</th><th /></tr></thead>
          <tbody>{db.users.map((u: any) => (
            <tr key={u.id}>
              <td className="mono"><b>{u.username}</b></td>
              <td><span className={`badge ${u.is_owner ? 'sky' : ''}`}>{u.is_owner ? 'propietario' : u.privileges}</span></td>
              <td className="small">{fmtDate(u.created_at)}</td><td className="small">{fmtDate(u.rotated_at)}</td>
              <td className="nowrap">{manage && <>
                <button className="btn sm outline" onClick={() => setRotate(u)}><KeyRound size={13} />Cambiar contraseña</button>
                {!u.is_owner && <button className="btn ghost icon" onClick={() => setDelUser(u)}><Trash2 size={15} /></button>}
              </>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>

      {addUser && <AddUserModal onClose={() => setAddUser(false)} onSave={(b) => run(async () => { await api(`/applications/${app.id}/database/users`, { body: { ...b, environment: env.name } }); setAddUser(false); reloadDb(); }, 'Usuario creado (contraseña cifrada)')} />}
      {rotate && <RotateModal user={rotate} onClose={() => setRotate(null)} onSave={(password) => run(async () => {
        await api(`/applications/${app.id}/database/users/${rotate.id}/password`, { body: { password: password || undefined, environment: env.name } }); setRotate(null); reloadDb();
      }, 'Contraseña actualizada')} />}
      {delUser && <Confirm title={`Eliminar usuario ${delUser.username}`} danger text="Sus objetos se reasignan al propietario." confirmLabel="Eliminar"
        onConfirm={() => run(async () => { await api(`/applications/${app.id}/database/users/${delUser.id}?environment=${env.name}`, { method: 'DELETE' }); reloadDb(); }, 'Usuario eliminado')} onClose={() => setDelUser(null)} />}
      {delDb && <Confirm title="Eliminar base de datos" danger requireText={app.slug} confirmLabel="Eliminar definitivamente"
        text={<>Se eliminará el contenedor y el volumen <code>{db.volume_name}</code> con <b>todos los datos</b>. Se recomienda generar un backup antes.</>}
        onConfirm={() => run(async () => { await api(`/applications/${app.id}/database?environment=${env.name}&confirm=${app.slug}`, { method: 'DELETE' }); reloadDb(); reload(); }, 'Base eliminada')} onClose={() => setDelDb(false)} />}
    </div>
  );
}

function AddUserModal({ onClose, onSave }: { onClose: () => void; onSave: (b: any) => void }) {
  const [b, setB] = useState({ username: '', privileges: 'readonly', password: '' });
  return (
    <Modal title="Nuevo usuario de base de datos" onClose={onClose} footer={<><button className="btn outline" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={() => onSave(b)}>Crear</button></>}>
      <div className="stack">
        <Field label="Usuario" hint="minúsculas, números y _"><input className="input mono" value={b.username} onChange={(e) => setB({ ...b, username: e.target.value.toLowerCase() })} /></Field>
        <Field label="Privilegios"><select className="input" value={b.privileges} onChange={(e) => setB({ ...b, privileges: e.target.value })}><option value="readonly">Sólo lectura</option><option value="readwrite">Lectura / escritura</option></select></Field>
        <Field label="Contraseña" hint="Vacío = se genera una segura automáticamente. Nunca vuelve a mostrarse."><input className="input" type="password" value={b.password} onChange={(e) => setB({ ...b, password: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function RotateModal({ user, onClose, onSave }: { user: any; onClose: () => void; onSave: (pw: string) => void }) {
  const [pw, setPw] = useState('');
  return (
    <Modal title={`Cambiar contraseña de ${user.username}`} onClose={onClose} footer={<><button className="btn outline" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={() => onSave(pw)}>Actualizar</button></>}>
      <div className="stack">
        <Field label="Nueva contraseña" hint="Vacío = generar automáticamente (recomendado)"><input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
        {user.is_owner && <div className="alert warn">Es el usuario propietario: la nueva contraseña se inyecta en DATABASE_URL / DATABASE_PASSWORD y la aplicación se recrea automáticamente.</div>}
      </div>
    </Modal>
  );
}
