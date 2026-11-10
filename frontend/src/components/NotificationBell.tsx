import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck } from 'lucide-react';
import { api } from '../api/client';

interface Notice {
  id: string; kind: string; severity: 'error' | 'warn' | 'ok'; title: string; body: string | null;
  applicationId: string | null; createdAt: string; readAt: string | null;
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'recién';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'ayer' : `hace ${d} días`;
}

/** Campanita de avisos (deploy fallido, app caída/recuperada, backup fallido). */
export default function NotificationBell() {
  const [data, setData] = useState<{ unread: number; items: Notice[] }>({ unread: 0, items: [] });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();

  const load = useCallback(() => api('/notifications').then(setData).catch(() => undefined), []);
  useEffect(() => {
    void load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const openItem = async (n: Notice) => {
    if (!n.readAt) await api(`/notifications/${n.id}/read`, { method: 'POST' }).catch(() => undefined);
    setOpen(false);
    void load();
    if (n.applicationId) nav(`/aplicaciones/${n.applicationId}`);
  };
  const readAll = async () => { await api('/notifications/read-all', { method: 'POST' }).catch(() => undefined); void load(); };

  return (
    <div className="notif" ref={ref}>
      <button className="btn ghost icon" title="Avisos" aria-label={`Avisos${data.unread ? ` (${data.unread} sin leer)` : ''}`}
        onClick={() => { setOpen(!open); if (!open) void load(); }}>
        <Bell size={19} />
        {data.unread > 0 && <span className="notif-badge">{data.unread > 99 ? '99+' : data.unread}</span>}
      </button>
      {open && (
        <div className="notif-panel">
          <div className="notif-head">
            <b>Avisos</b>
            {data.unread > 0 && <button className="btn ghost sm" onClick={readAll}><CheckCheck size={14} />Marcar todas como leídas</button>}
          </div>
          {data.items.length === 0 && <p className="muted small notif-empty">No hay avisos.</p>}
          <ul className="notif-list">
            {data.items.map((n) => (
              <li key={n.id} className={n.readAt ? '' : 'unread'} onClick={() => void openItem(n)}>
                <span className={`notif-dot ${n.severity}`} />
                <div className="stack" style={{ gap: 2, minWidth: 0 }}>
                  <b className="notif-title">{n.title}</b>
                  {n.body && <span className="muted small notif-body">{n.body}</span>}
                  <span className="muted small">{ago(n.createdAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
