import { useNavigate } from 'react-router';
import { Database } from 'lucide-react';
import { api, ENV_LABEL, fmtDate } from '../api/client';
import { Empty, Spinner, StatusBadge, useData } from '../components/ui';

export default function Databases() {
  const { data } = useData<any[]>(() => api('/databases'), [], 15000);
  const nav = useNavigate();
  return (
    <>
      <div className="page-head"><div><span className="eyebrow">PostgreSQL</span><h1>Bases de datos</h1>
        <p>Una base aislada por ambiente de aplicación. Arquitectura preparada para MySQL, MariaDB, MongoDB y Redis.</p></div></div>
      {!data ? <Spinner /> : !data.length ? <div className="card"><Empty icon={<Database size={36} />} title="No hay bases de datos">Créelas desde la pestaña “Base de datos” de cada aplicación.</Empty></div> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Aplicación</th><th>Ambiente</th><th>Motor</th><th>Host</th><th>Database</th><th>Propietario</th><th>Usuarios</th><th>Último backup</th><th>Estado</th></tr></thead>
          <tbody>{data.map((d) => (
            <tr key={d.id} className="click" onClick={() => nav(`/aplicaciones/${d.application_id}?tab=database&env=${d.environment}`)}>
              <td><b>{d.application_name}</b></td><td><span className="badge sky">{ENV_LABEL[d.environment]}</span></td>
              <td>PostgreSQL {d.engine_version}</td><td className="mono small">{d.host}:{d.port}</td><td className="mono">{d.database_name}</td>
              <td className="mono small">{d.owner}</td><td>{d.users_count}</td><td className="small">{fmtDate(d.last_backup)}</td>
              <td><StatusBadge status={d.status} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}
