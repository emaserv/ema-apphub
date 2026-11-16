import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { LogIn, MapPin } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../auth';
import Logo from '../components/Logo';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { refresh } = useAuth();
  const nav = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api('/auth/login', { body: { username, password } });
      await refresh();
      nav('/');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <section className="login-hero">
        <span className="eyebrow"><MapPin size={13} />EMA SERVICIOS</span>
        <h1>Plataforma interna de<br /><span>aplicaciones.</span></h1>
        <p style={{ maxWidth: 480, lineHeight: 1.7, color: '#d9dcf5' }}>
          Repositorio centralizado y gestor de despliegues: suba sus aplicaciones, versionelas, configure sus bases de datos
          y publíquelas con <b>Docker</b> de forma segura y auditada.
        </p>
      </section>
      <section className="login-form">
        <form className="box" onSubmit={submit}>
          <div style={{ textAlign: 'center', marginBottom: 10 }}><Logo width={210} /></div>
          <div><h2>Iniciar sesión</h2><p className="muted" style={{ margin: '4px 0 0' }}>EMA AppHub</p></div>
          {error && <div className="alert err">{error}</div>}
          <label className="field">Usuario o email<input className="input" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></label>
          <label className="field">Contraseña<input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          <button className="btn primary" disabled={busy} style={{ padding: '11px 18px' }}>{busy ? <span className="spinner" /> : <LogIn size={16} />}INGRESAR</button>
          <p className="muted small" style={{ textAlign: 'center' }}>© {new Date().getFullYear()} EMA Servicios S.A.</p>
        </form>
      </section>
    </div>
  );
}
