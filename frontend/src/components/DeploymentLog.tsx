import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { api, ENV_LABEL, fmtDate } from '../api/client';
import { StatusBadge } from './ui';

const STEPS = [
  ['prepare', 'Código'], ['validate', 'Validación'], ['build', 'Build'], ['test', 'Tests'], ['scan', 'Seguridad'], ['push', 'Imagen'], ['deploy', 'Deploy'], ['health', 'Health check'],
] as const;

/** Sigue un deployment (polling) mostrando el pipeline y su log. */
export default function DeploymentLog({ id, onDone }: { id: string; onDone?: (status: string) => void }) {
  const [d, setD] = useState<any>(null);
  const box = useRef<HTMLDivElement>(null);
  const done = useRef(false);

  useEffect(() => {
    done.current = false;
    let t: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const r = await api(`/deployments/${id}`);
        setD(r);
        if (['success', 'failed', 'rolled_back'].includes(r.status)) {
          if (!done.current) { done.current = true; onDone?.(r.status); }
          return;
        }
      } catch { /* reintenta */ }
      t = setTimeout(load, 1500);
    };
    void load();
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [d?.log]);
  if (!d) return <div className="muted">Cargando deployment…</div>;

  const curIdx = STEPS.findIndex(([k]) => k === d.current_step);
  const finished = d.status === 'success';
  return (
    <div className="stack">
      <div className="row between">
        <div className="row">
          <b>{d.application_name}</b><span className="badge sky">{ENV_LABEL[d.environment] ?? d.environment}</span><span className="badge">v{d.version}</span>
          <StatusBadge status={d.status} />
        </div>
        <span className="muted small">{fmtDate(d.created_at)} · {d.user_name ?? d.trigger}</span>
      </div>
      <div className="pipeline">
        {STEPS.map(([k, label], i) => {
          const cls = finished || i < curIdx || (d.current_step === 'done') ? 'done' : i === curIdx ? (['failed', 'rolled_back'].includes(d.status) ? 'fail' : 'cur') : '';
          return <span key={k} className={`p ${cls}`}>{cls === 'done' && <CheckCircle2 size={13} />}{cls === 'fail' && <XCircle size={13} />}{label}</span>;
        })}
      </div>
      {d.status === 'rolled_back' && <div className="alert warn">El deploy falló y se aplicó rollback automático a {d.previous_version ? `v${d.previous_version}` : 'la versión anterior'}.</div>}
      {d.status === 'failed' && d.error && <div className="alert err" style={{ whiteSpace: 'pre-wrap' }}>{d.error.slice(0, 1200)}</div>}
      <div className="console" ref={box} style={{ height: 360 }}>{d.log || 'Esperando en cola…'}</div>
    </div>
  );
}
