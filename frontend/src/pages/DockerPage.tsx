import { useState } from 'react';
import { Play, RotateCw, Square, Trash2, Eraser } from 'lucide-react';
import { api, fmtBytes, fmtDate } from '../api/client';
import { useAuth } from '../auth';
import { Confirm, Spinner, StatusBadge, Tabs, useAction, useData, useToast } from '../components/ui';

export default function DockerPage() {
  const [tab, setTab] = useState<'containers' | 'images'>('containers');
  const { data: info } = useData(() => api('/docker/info'), []);
  const { data: containers, reload } = useData<any[]>(() => api('/docker/containers', { query: { stats: 1 } }), [], 10000);
  const { data: images, reload: reloadImgs } = useData<any[]>(() => api('/docker/images'), [tab]);
  const { can } = useAuth();
  const { run, busy } = useAction();
  const toast = useToast();
  const [rm, setRm] = useState<any>(null);
  const act = (c: any, a: string) => run(async () => { await api(`/docker/containers/${c.name}/${a}`, { body: {} }); reload(); }, `${a}: ${c.name}`);
  const cleanup = () => run(async () => {
    const r = await api('/docker/images/prune', { body: {} });
    reloadImgs();
    const freed = (r.freedBytes ?? 0) + (r.danglingBytes ?? 0);
    toast(r.images?.length || freed
      ? `Limpieza lista: ${r.images?.length ?? 0} imágenes de versiones viejas, ${fmtBytes(freed)} liberados${r.buildCache ? ` (+ ${r.buildCache} de caché de build)` : ''}`
      : 'No había imágenes viejas para borrar');
  });

  return (
    <>
      <div className="page-head"><div><span className="eyebrow">Runtime</span><h1>Docker</h1><p>Contenedores e imágenes administrados por la plataforma (label <code>ema.managed=true</code>).</p></div></div>
      {info && (
        <div className="grid c4" style={{ marginBottom: 16 }}>
          <div className="card stat"><span className="l">Docker Engine</span><span className="v" style={{ fontSize: 22 }}>{info.serverVersion}</span><span className="muted small">{info.os}</span></div>
          <div className="card stat"><span className="l">Contenedores (host)</span><span className="v">{info.running}<span className="muted" style={{ fontSize: 16 }}>/{info.containers}</span></span></div>
          <div className="card stat"><span className="l">Imágenes</span><span className="v">{info.managedImages}<span className="muted" style={{ fontSize: 16 }}>/{info.images}</span></span></div>
          <div className="card stat"><span className="l">Recursos</span><span className="v" style={{ fontSize: 22 }}>{info.cpus} CPU</span><span className="muted small">{fmtBytes(info.memTotal)} RAM</span></div>
        </div>
      )}
      <Tabs value={tab} onChange={setTab} items={[{ id: 'containers', label: 'Contenedores' }, { id: 'images', label: 'Imágenes' }]} />
      {tab === 'containers' && (!containers ? <Spinner /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Contenedor</th><th>App / ambiente</th><th>Imagen</th><th>Puertos</th><th>CPU</th><th>RAM</th><th>Estado</th><th /></tr></thead>
          <tbody>{containers.map((c) => (
            <tr key={c.id}>
              <td className="mono small"><b>{c.name}</b><div className="muted">{c.id}</div></td>
              <td className="small">{c.app} · {c.environment} <span className="badge">{c.service}</span></td>
              <td className="mono small">{c.image}</td><td className="mono small">{c.ports.join(', ') || '—'}</td>
              <td className="small">{c.stats ? `${c.stats.cpuPercent}%` : '—'}</td><td className="small">{c.stats ? fmtBytes(c.stats.memoryBytes) : '—'}</td>
              <td><StatusBadge status={c.state} /><div className="muted small">{c.status}</div></td>
              <td className="nowrap">{can('docker.manage') && <>
                {c.state !== 'running' ? <button className="btn ghost icon" title="Iniciar" disabled={busy} onClick={() => act(c, 'start')}><Play size={15} /></button>
                  : <button className="btn ghost icon" title="Detener" disabled={busy} onClick={() => act(c, 'stop')}><Square size={15} /></button>}
                <button className="btn ghost icon" title="Reiniciar" disabled={busy} onClick={() => act(c, 'restart')}><RotateCw size={15} /></button>
                <button className="btn ghost icon" title="Eliminar" onClick={() => setRm(c)}><Trash2 size={15} /></button>
              </>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ))}
      {tab === 'images' && (
        <div className="stack">
          {can('docker.manage') && (
            <div className="row">
              <button className="btn outline sm" disabled={busy} onClick={cleanup}><Eraser size={14} />Limpiar imágenes viejas</button>
              <span className="muted small">Se hace sola cada noche y después de cada deploy. Conserva las imágenes de las últimas versiones de cada app, las desplegadas y la del rollback.</span>
            </div>
          )}
          {!images ? <Spinner /> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Tag</th><th>ID</th><th>Aplicación</th><th>Versión</th><th>Tamaño</th><th>Creada</th></tr></thead>
              <tbody>{images.map((i) => <tr key={i.id}><td className="mono small">{(i.tags ?? []).join(', ') || '<none>'}</td><td className="mono small">{i.id}</td><td>{i.app ?? '—'}</td><td>{i.version ?? '—'}</td><td className="small">{fmtBytes(i.size)}</td><td className="small">{fmtDate(new Date(i.created * 1000).toISOString())}</td></tr>)}</tbody>
            </table></div>
          )}
        </div>
      )}
      {rm && <Confirm title={`Eliminar contenedor ${rm.name}`} danger confirmLabel="Eliminar" text="El contenedor se elimina (los volúmenes se conservan). Un nuevo deploy o 'Iniciar' lo vuelve a crear."
        onConfirm={() => act(rm, 'remove')} onClose={() => setRm(null)} />}
    </>
  );
}
