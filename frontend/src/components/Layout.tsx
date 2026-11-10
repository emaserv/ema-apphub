import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Archive, Boxes, ClipboardList, Container, Database, GitBranch, LayoutDashboard, LogOut, Menu, Rocket, Settings, Users, Plus,
} from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../auth';
import Logo from './Logo';
import NotificationBell from './NotificationBell';

export default function Layout() {
  const { me, can, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState<{ total: number; running: number; stopped: number; error: number } | null>(null);
  const loc = useLocation();
  const nav = useNavigate();

  useEffect(() => { setOpen(false); }, [loc.pathname]);
  useEffect(() => {
    const load = () => api('/system/dashboard').then((d) => setCounts(d.applications)).catch(() => undefined);
    void load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { if (me?.mustChangePassword && loc.pathname !== '/configuracion') nav('/configuracion?cambiar=1'); }, [me, loc.pathname, nav]);

  const appsActive = loc.pathname.startsWith('/aplicaciones');
  const status = new URLSearchParams(loc.search).get('estado');
  const sub = (s: string | null) => `sub ${appsActive && status === s && loc.pathname === '/aplicaciones' ? 'active' : ''}`;

  return (
    <div className="shell">
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="brand"><Logo width={150} /><small>APPHUB · PLATAFORMA</small></div>
        <nav className="nav">
          <NavLink to="/" end><LayoutDashboard size={18} />Dashboard</NavLink>
          <div className="section">Aplicaciones</div>
          <NavLink to="/aplicaciones" className={() => (appsActive && !status ? 'active' : '')} end><Boxes size={18} />Todas<span className="count">{counts?.total ?? ''}</span></NavLink>
          <NavLink to="/aplicaciones?estado=running" className={() => sub('running')}>Ejecutando<span className="count">{counts?.running ?? ''}</span></NavLink>
          <NavLink to="/aplicaciones?estado=stopped" className={() => sub('stopped')}>Detenidas<span className="count">{counts?.stopped ?? ''}</span></NavLink>
          <NavLink to="/aplicaciones?estado=error" className={() => sub('error')}>Error<span className="count">{counts?.error ?? ''}</span></NavLink>
          <NavLink to="/deployments"><Rocket size={18} />Deployments</NavLink>
          <div className="section">Infraestructura</div>
          {can('db.view') && <NavLink to="/bases-de-datos"><Database size={18} />Bases de datos</NavLink>}
          {can('backups.view') && <NavLink to="/backups"><Archive size={18} />Backups</NavLink>}
          {can('docker.view') && <NavLink to="/docker"><Container size={18} />Docker</NavLink>}
          <NavLink to="/git"><GitBranch size={18} />Git</NavLink>
          <div className="section">Administración</div>
          {can('users.manage') && <NavLink to="/usuarios"><Users size={18} />Usuarios</NavLink>}
          {can('audit.view') && <NavLink to="/auditoria"><ClipboardList size={18} />Auditoría</NavLink>}
          <NavLink to="/configuracion"><Settings size={18} />Configuración</NavLink>
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="strip" />
          <button className="btn ghost icon menu-btn" onClick={() => setOpen(!open)} aria-label="Menú"><Menu size={20} /></button>
          <div className="spacer" />
          {can('apps.create') && <button className="btn primary" onClick={() => nav('/aplicaciones/nueva')}><Plus size={16} />Nueva aplicación</button>}
          {me?.role === 'superadmin' && <NotificationBell />}
          <div className="user">
            <div className="avatar">{me?.fullName?.[0] ?? '?'}</div>
            <div className="stack" style={{ gap: 0 }}>
              <b style={{ fontSize: 13 }}>{me?.fullName}</b>
              <span className="muted small">{me?.roleName}</span>
            </div>
            <button className="btn ghost icon" title="Cerrar sesión" onClick={logout}><LogOut size={18} /></button>
          </div>
        </header>
        <main className="content"><Outlet /></main>
      </div>
    </div>
  );
}
