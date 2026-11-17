import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ShieldAlert } from 'lucide-react';
import { wsUrl } from '../api/client';

/** Terminal web (docker exec con TTY) — sólo usuarios con permiso terminal.access. Sesiones auditadas. */
export default function WebTerminal({ appId, environment, service }: { appId: string; environment: string; service: 'app' | 'db' }) {
  const el = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('Conectando…');
  const [session, setSession] = useState(0);

  useEffect(() => {
    const term = new Terminal({ cursorBlink: true, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 13,
      theme: { background: '#11122b', foreground: '#d6dbff', cursor: '#76C6E2', selectionBackground: '#3a3c8f' } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el.current!);
    fit.fit();
    const ws = new WebSocket(wsUrl('/ws/terminal', { app: appId, environment, service }));
    ws.onopen = () => {
      setStatus('Conectado');
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      term.focus();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string' && ev.data.startsWith('{"type":"error"')) {
        const m = JSON.parse(ev.data); term.writeln(`\r\n\x1b[31m${m.message}\x1b[0m`); return;
      }
      term.write(ev.data);
    };
    ws.onclose = (ev) => {
      const why = ev.reason ? `: ${ev.reason}` : '';
      setStatus(`Sesión finalizada${why}`);
      term.writeln(`\r\n\x1b[33m[sesión finalizada${why}]\x1b[0m`);
    };
    const d = term.onData((data) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'input', data })));
    const onResize = () => { fit.fit(); ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); };
    window.addEventListener('resize', onResize);
    return () => {
      // Primero se desconectan los avisos del socket: su cierre llega después y no debe escribir en una terminal ya destruida
      ws.onopen = ws.onmessage = ws.onclose = null;
      d.dispose();
      window.removeEventListener('resize', onResize);
      ws.close();
      term.dispose();
    };
  }, [appId, environment, service, session]);

  return (
    <div className="stack">
      <div className="alert warn"><ShieldAlert size={16} />Acceso privilegiado: la sesión y los comandos ingresados quedan registrados en auditoría.</div>
      <div className="row"><span className="badge">{status}</span><button className="btn sm outline right" onClick={() => setSession((s) => s + 1)}>Reconectar</button></div>
      <div className="term"><div ref={el} style={{ height: '100%' }} /></div>
    </div>
  );
}
