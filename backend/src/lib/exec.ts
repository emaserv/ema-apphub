import { spawn } from 'child_process';
import fs from 'fs';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string | Buffer;
  stdinFile?: string;
  stdoutFile?: string;
  onLine?: (line: string) => void;
}

export interface RunResult { code: number; stdout: string; stderr: string }

/**
 * Ejecuta un binario SIN shell (los argumentos nunca se interpretan),
 * opcionalmente transmitiendo cada línea a onLine.
 */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let buf = '';
    const emit = (chunk: string) => {
      if (!opts.onLine) return;
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      lines.forEach((l) => l.trim() && opts.onLine!(l));
    };
    let outDone: Promise<void> = Promise.resolve();
    if (opts.stdoutFile) {
      const out = fs.createWriteStream(opts.stdoutFile);
      outDone = new Promise((res) => { out.on('close', () => res()); out.on('error', () => res()); });
      child.stdout.pipe(out);
    } else {
      child.stdout.on('data', (d) => {
        const s = d.toString();
        if (stdout.length < 2_000_000) stdout += s;
        emit(s);
      });
    }
    child.stderr.on('data', (d) => {
      const s = d.toString();
      if (stderr.length < 2_000_000) stderr += s;
      emit(s);
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => { child.kill('SIGKILL'); stderr += '\n[timeout]'; }, opts.timeoutMs)
      : null;
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (buf.trim() && opts.onLine) opts.onLine(buf);
      void outDone.then(() => resolve({ code: code ?? 1, stdout, stderr }));
    });
    // Si el proceso termina sin leer toda la entrada, escribirle da EPIPE: sin este handler, ese error
    // no capturado tira abajo todo el proceso de Node (el backend). El resultado se informa por el código de salida.
    child.stdin.on('error', () => undefined);
    if (opts.stdinFile) fs.createReadStream(opts.stdinFile).pipe(child.stdin);
    else if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export async function runOk(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args[0] ?? ''} falló (${r.code}): ${(r.stderr || r.stdout).slice(-1500)}`);
  return r;
}
