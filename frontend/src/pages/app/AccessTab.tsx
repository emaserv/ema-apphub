import { Users } from 'lucide-react';
import { api } from '../../api/client';
import { Empty, Spinner, Switch, useAction, useData } from '../../components/ui';
import { TabProps } from './OverviewTab';

/** Qué Desarrolladores y Consultas pueden ver y trabajar en esta aplicación. */
export default function AccessTab({ app }: TabProps) {
  const { data, reload } = useData<any[]>(() => api(`/applications/${app.id}/access`), [app.id]);
  const { run, busy } = useAction();

  const toggle = (u: any, assigned: boolean) => run(async () => {
    await api(`/applications/${app.id}/access/${u.id}`, { method: 'PUT', body: { assigned } });
    reload();
  }, assigned ? `${u.full_name} ahora tiene acceso` : `${u.full_name} ya no tiene acceso`);

  return (
    <div className="card stack">
      <div>
        <h3 style={{ margin: 0 }}>Quién trabaja en esta aplicación</h3>
        <p className="muted small" style={{ margin: '4px 0 0' }}>
          Desarrolladores y Consultas sólo ven las aplicaciones que tienen asignadas. Lo que pueden hacer en ellas depende de su rol.
          Superadministradores y Administradores ven todas las aplicaciones.
        </p>
      </div>
      {!data ? <Spinner /> : !data.length ? <Empty icon={<Users size={36} />} title="No hay Desarrolladores ni Consultas activos" /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Acceso</th></tr></thead>
          <tbody>{data.map((u) => (
            <tr key={u.id}>
              <td><b>{u.full_name}</b></td>
              <td className="mono">{u.username}</td>
              <td><span className="badge sky">{u.role_name}</span></td>
              <td>{u.all_apps
                ? <span className="badge ok" title="Se cambia desde Usuarios">Todas las aplicaciones</span>
                : <Switch checked={u.assigned} disabled={busy} onChange={(v) => toggle(u, v)} label={u.assigned ? 'Con acceso' : 'Sin acceso'} />}
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}
