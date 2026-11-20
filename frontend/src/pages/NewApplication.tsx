import { DragEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { AlertTriangle, ArrowLeft, ArrowRight, Check, FileArchive, FolderUp, GitBranch, PackagePlus, RefreshCw, Rocket, Wand2 } from 'lucide-react';
import { api, ENV_LABEL, fmtBytes, SHOW_DOMAIN, uploadForm } from '../api/client';
import { useAuth } from '../auth';
import CodeEditor from '../components/CodeEditor';
import DeploymentLog from '../components/DeploymentLog';
import { VarRow, VarsEditor, VolumeRow, VolumesEditor } from '../components/Editors';
import { Field, Switch, useAction, useToast } from '../components/ui';

type Method = 'zip' | 'git' | 'files' | 'empty';
const slugify = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);

export default function NewApplication() {
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const { run, busy } = useAction();
  const [step, setStep] = useState(0);

  // paso 1
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [method, setMethod] = useState<Method>('zip');
  const [zip, setZip] = useState<File | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [drag, setDrag] = useState(false);
  const [progress, setProgress] = useState(0);
  const [git, setGit] = useState({ url: '', authType: 'none', username: '', credential: '', refType: 'branch', ref: 'main', subdirectory: '' });
  const [refs, setRefs] = useState<{ branches: string[]; tags: string[] } | null>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  // paso 2
  const [analysis, setAnalysis] = useState<any>(null);
  const [techs, setTechs] = useState<any[]>([]);
  const [technology, setTechnology] = useState('');
  const [internalPort, setInternalPort] = useState(80);
  const [healthPath, setHealthPath] = useState('/');
  const [buildConfig, setBuildConfig] = useState<any>({});
  const [dockerfile, setDockerfile] = useState('');

  // paso 3
  const [envName, setEnvName] = useState('production');
  const [externalPort, setExternalPort] = useState<number | ''>('');
  const [portMsg, setPortMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [domain, setDomain] = useState('');
  const [https, setHttps] = useState(true);
  const [pathPrefix, setPathPrefix] = useState('');
  const [pathTouched, setPathTouched] = useState(false);
  // La ruta es obligatoria: se propone /<identificador> hasta que el usuario la cambie
  const pathMissing = !pathPrefix.replace(/\//g, '') && !domain;
  const [vars, setVars] = useState<VarRow[]>([]);
  const [volumes, setVolumes] = useState<VolumeRow[]>([]);
  const [version, setVersion] = useState('1.0.0');
  const [comment, setComment] = useState('Versión inicial');

  // paso 4
  const [createDb, setCreateDb] = useState(false);
  const [dbName, setDbName] = useState('');
  const [dbUser, setDbUser] = useState('');
  const [deploy, setDeploy] = useState(true);
  const [result, setResult] = useState<any>(null);

  useEffect(() => { api<any[]>('/applications/technologies').then(setTechs).catch(() => undefined); }, []);
  useEffect(() => { if (!slugTouched) setSlug(slugify(name)); }, [name, slugTouched]);
  useEffect(() => { if (!pathTouched) setPathPrefix(slug ? `/${slug}` : ''); }, [slug, pathTouched]);
  useEffect(() => { api('/system/ports/check').then((r) => setExternalPort(r.suggested)).catch(() => undefined); }, []);
  useEffect(() => { const s = slug.replace(/-/g, '_'); setDbName(s); setDbUser(`${s}_user`); }, [slug]);

  const vars_default = (tech: string, port: number) => {
    const base: VarRow[] = [];
    if (['node', 'nestjs', 'nextjs', 'nuxt'].includes(tech)) base.push({ key: 'NODE_ENV', value: 'production', isSecret: false }, { key: 'PORT', value: String(port), isSecret: false });
    if (tech.startsWith('python')) base.push({ key: 'PORT', value: String(port), isSecret: false });
    return base;
  };

  const applyAnalysis = (r: any) => {
    setAnalysis(r);
    setTechnology(r.detection.technology);
    setInternalPort(r.detection.internalPort);
    setHealthPath(r.detection.healthcheckPath || '/');
    setBuildConfig(r.detection.buildConfig || {});
    setDockerfile(r.dockerfile);
    if (!vars.length) setVars(vars_default(r.detection.technology, r.detection.internalPort));
    setStep(1);
  };

  const analyze = () => run(async () => {
    if (!name.trim()) throw new Error('Ingrese el nombre de la aplicación');
    if (method === 'empty') { setAnalysis(null); setTechnology('static'); setInternalPort(80); setStep(1); return; }
    setProgress(0);
    if (method === 'git') {
      if (!git.url) throw new Error('Ingrese la URL del repositorio');
      const body = {
        method: 'git',
        git: { url: git.url, authType: git.authType, username: git.username || null, credential: git.credential || null,
          branch: git.refType === 'branch' ? git.ref : null, tag: git.refType === 'tag' ? git.ref : null, commit: git.refType === 'commit' ? git.ref : null,
          subdirectory: git.subdirectory || null },
      };
      applyAnalysis(await api('/applications/analyze', { body }));
      return;
    }
    const fd = new FormData();
    fd.append('method', method);
    if (method === 'zip') { if (!zip) throw new Error('Seleccione el archivo ZIP'); fd.append('file', zip); }
    else {
      if (!files.length) throw new Error('Seleccione archivos o una carpeta');
      for (const f of files) { fd.append('paths', (f as any).webkitRelativePath || f.name); fd.append('files', f); }
    }
    applyAnalysis(await uploadForm('/applications/analyze', fd, setProgress));
  });

  const regenerate = (tech = technology) => run(async () => {
    const r = await api('/applications/dockerfile/preview', { body: { technology: tech, internalPort, buildConfig, stagingId: analysis?.stagingId } });
    setDockerfile(r.dockerfile);
  }, 'Dockerfile regenerado');

  const listRefs = () => run(async () => {
    setRefs(await api('/git/refs', { body: { url: git.url, authType: git.authType, username: git.username || null, credential: git.credential || null } }));
  }, 'Conexión exitosa con el repositorio');

  const checkPort = async (p: number | '') => {
    if (!p) { setPortMsg(null); return; }
    const r = await api('/system/ports/check', { query: { port: p } });
    setPortMsg(r.free ? { ok: true, text: `Puerto ${p} disponible` } : { ok: false, text: `${r.reason}. Sugerido: ${r.suggested}` });
  };

  const create = () => run(async () => {
    const dup = vars.filter((v, i) => v.key && vars.findIndex((x) => x.key === v.key) !== i);
    if (dup.length) throw new Error('Hay variables duplicadas');
    const body: any = {
      name, slug, description: description || undefined, technology, detectedTechnology: analysis?.detection.technology,
      frameworkLabel: techs.find((t) => t.id === technology)?.label, internalPort, healthcheckPath: healthPath, buildConfig,
      dockerfile: method === 'empty' ? undefined : dockerfile, stagingId: analysis?.stagingId, version, comment,
      sourceType: method === 'git' ? 'git' : method === 'files' ? 'upload' : 'zip',
      environment: { name: envName, externalPort: externalPort === '' ? null : Number(externalPort), domain: domain || null, httpsEnabled: https, pathPrefix: pathPrefix || null,
        volumes: volumes.filter((v) => v.source && v.target), variables: vars.filter((v) => v.key).map(({ key, value, isSecret }) => ({ key, value, isSecret })) },
      createDatabase: createDb, database: createDb ? { databaseName: dbName, username: dbUser } : undefined,
      deploy: deploy && canDeployEnv && method !== 'empty',
    };
    if (method === 'git') {
      body.repository = { url: git.url, authType: git.authType, username: git.username || null, credential: git.credential || null,
        branch: git.refType === 'branch' ? git.ref : null, tag: git.refType === 'tag' ? git.ref : null, commit: git.refType === 'commit' ? git.ref : null,
        subdirectory: git.subdirectory || null };
    }
    const r = await api('/applications', { body });
    setResult(r);
    if (!r.deployment) { toast('Aplicación creada'); nav(`/aplicaciones/${r.application.id}`); }
  });

  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f && /\.zip$/i.test(f.name)) setZip(f); else toast('Arrastre un archivo .zip', 'err');
  };

  const totalSize = useMemo(() => files.reduce((s, f) => s + f.size, 0), [files]);
  const canDeployEnv = can(envName === 'production' ? 'apps.deploy.prod' : 'apps.deploy.nonprod');
  const STEPS = ['Origen del código', 'Tecnología y Docker', 'Configuración', 'Base de datos y deploy'];

  if (result?.deployment) {
    return (
      <>
        <div className="page-head"><div><span className="eyebrow">Nueva aplicación</span><h1>Desplegando {result.application.name}</h1></div></div>
        <div className="card stack">
          <DeploymentLog id={result.deployment.id} />
          <div className="row"><button className="btn primary" onClick={() => nav(`/aplicaciones/${result.application.id}`)}>Ir a la aplicación<ArrowRight size={15} /></button></div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div><span className="eyebrow">Repositorio</span><h1>Nueva aplicación</h1><p>Suba el código, revise la configuración Docker propuesta y despliegue.</p></div>
        <button className="btn outline" onClick={() => nav('/aplicaciones')}><ArrowLeft size={15} />Volver</button>
      </div>
      <div className="steps">{STEPS.map((s, i) => <div key={s} className={`s ${i === step ? 'active' : i < step ? 'done' : ''}`}><span className="n">{i < step ? <Check size={14} /> : i + 1}</span>{s}</div>)}</div>

      {step === 0 && (
        <div className="card stack" style={{ gap: 18 }}>
          <div className="grid c2">
            <Field label="Nombre de la aplicación *"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="CRM Clientes" /></Field>
            <Field label="Identificador" hint="Se usa en contenedores, imágenes y carpetas. Minúsculas, números y guiones.">
              <input className="input mono" value={slug} onChange={(e) => { setSlugTouched(true); setSlug(slugify(e.target.value)); }} />
            </Field>
          </div>
          <Field label="Descripción"><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Gestión de clientes del área comercial" /></Field>
          <div>
            <div className="field" style={{ marginBottom: 8 }}>Método de carga</div>
            <div className="grid c4">
              {([['zip', FileArchive, 'Subir ZIP', 'Archivo .zip con el proyecto completo'], ['git', GitBranch, 'Repositorio Git', 'GitHub, GitLab, Bitbucket o privado'],
                ['files', FolderUp, 'Carpeta / archivos', 'Seleccionar carpeta desde el navegador'], ['empty', PackagePlus, 'Proyecto vacío', 'Registrar y subir código más tarde']] as const).map(([id, Icon, t, d]) => (
                <button key={id} className={`choice ${method === id ? 'active' : ''}`} onClick={() => setMethod(id)}><Icon size={22} /><b>{t}</b><span className="muted small">{d}</span></button>
              ))}
            </div>
          </div>

          {method === 'zip' && (
            <label className={`dropzone ${drag ? 'drag' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
              <input type="file" accept=".zip" hidden onChange={(e) => setZip(e.target.files?.[0] ?? null)} />
              <FileArchive size={30} color="var(--ema-sky)" />
              <div><b>{zip ? zip.name : 'Arrastre aquí mi-aplicacion.zip'}</b></div>
              <div className="muted small">{zip ? fmtBytes(zip.size) : 'o haga clic para seleccionarlo'}</div>
            </label>
          )}
          {method === 'files' && (
            <div className="dropzone" onClick={() => folderInput.current?.click()}>
              <input ref={folderInput} type="file" hidden multiple {...({ webkitdirectory: '', directory: '' } as any)}
                onChange={(e) => setFiles(Array.from(e.target.files ?? []).filter((f) => !/(^|\/)(node_modules|\.git)\//.test((f as any).webkitRelativePath)))} />
              <FolderUp size={30} color="var(--ema-sky)" />
              <div><b>{files.length ? `${files.length} archivos seleccionados` : 'Seleccionar carpeta del proyecto'}</b></div>
              <div className="muted small">{files.length ? fmtBytes(totalSize) : 'Se excluyen node_modules y .git automáticamente'}</div>
            </div>
          )}
          {method === 'git' && (
            <div className="stack">
              <div className="grid c2">
                <Field label="URL del repositorio *" hint="https://github.com/usuario/proyecto.git o git@github.com:usuario/proyecto.git">
                  <input className="input mono" value={git.url} onChange={(e) => setGit({ ...git, url: e.target.value.trim() })} />
                </Field>
                <Field label="Autenticación">
                  <select className="input" value={git.authType} onChange={(e) => setGit({ ...git, authType: e.target.value })}>
                    <option value="none">Repositorio público</option><option value="token">Token de acceso (PAT)</option>
                    <option value="basic">Usuario y contraseña</option><option value="ssh">Clave SSH privada</option>
                  </select>
                </Field>
              </div>
              {git.authType !== 'none' && (
                <div className="grid c2">
                  {git.authType !== 'ssh' && <Field label="Usuario" hint={git.authType === 'token' ? 'Opcional para tokens' : undefined}><input className="input" value={git.username} onChange={(e) => setGit({ ...git, username: e.target.value })} /></Field>}
                  <Field label={git.authType === 'ssh' ? 'Clave privada SSH' : git.authType === 'token' ? 'Token' : 'Contraseña'} hint="Se guarda cifrada y nunca vuelve a mostrarse.">
                    {git.authType === 'ssh'
                      ? <textarea className="input" rows={5} value={git.credential} onChange={(e) => setGit({ ...git, credential: e.target.value })} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
                      : <input className="input" type="password" value={git.credential} onChange={(e) => setGit({ ...git, credential: e.target.value })} />}
                  </Field>
                </div>
              )}
              <div className="grid c3">
                <Field label="Referencia">
                  <div className="seg">{(['branch', 'tag', 'commit'] as const).map((t) => <button key={t} className={git.refType === t ? 'active' : ''} onClick={() => setGit({ ...git, refType: t, ref: t === 'branch' ? 'main' : '' })}>{t === 'branch' ? 'Branch' : t === 'tag' ? 'Tag' : 'Commit'}</button>)}</div>
                </Field>
                <Field label={git.refType === 'commit' ? 'Hash del commit' : git.refType === 'tag' ? 'Tag' : 'Branch'}>
                  <input className="input mono" list="git-refs" value={git.ref} onChange={(e) => setGit({ ...git, ref: e.target.value.trim() })} />
                  <datalist id="git-refs">{(git.refType === 'tag' ? refs?.tags : refs?.branches)?.map((b) => <option key={b} value={b} />)}</datalist>
                </Field>
                <Field label="Subdirectorio (monorepo)" hint="Opcional"><input className="input mono" value={git.subdirectory} onChange={(e) => setGit({ ...git, subdirectory: e.target.value })} placeholder="apps/frontend" /></Field>
              </div>
              <div><button className="btn sm outline" disabled={!git.url || busy} onClick={listRefs}><RefreshCw size={14} />Probar conexión y listar branches/tags</button></div>
            </div>
          )}
          {busy && method !== 'git' && method !== 'empty' && <div className="stack" style={{ gap: 4 }}><div className="progress"><i style={{ width: `${progress}%` }} /></div><span className="muted small">{progress < 100 ? `Subiendo… ${progress}%` : 'Analizando estructura…'}</span></div>}
          <div className="row"><button className="btn primary right" disabled={busy} onClick={analyze}>{busy ? <span className="spinner" /> : <Wand2 size={15} />}{method === 'empty' ? 'Continuar' : 'Subir y analizar'}</button></div>
        </div>
      )}

      {step === 1 && (
        <div className="stack" style={{ gap: 16 }}>
          {analysis && (
            <div className="card">
              <div className="row between">
                <div className="row"><h3>Tecnología detectada:</h3><span className="badge sky" style={{ fontSize: 13 }}>{analysis.detection.label}</span>
                  <span className={`badge ${analysis.detection.confidence === 'alta' ? 'ok' : analysis.detection.confidence === 'media' ? 'warn' : 'err'}`}>Confianza {analysis.detection.confidence}</span></div>
                <span className="muted small">{analysis.tree.filter((t: any) => t.type === 'file').length}+ archivos · {fmtBytes(analysis.sizeBytes)}{analysis.commitSha && ` · commit ${analysis.commitSha.slice(0, 8)}`}</span>
              </div>
              <div className="row small" style={{ marginTop: 10 }}><span className="muted">Archivos detectados:</span>{analysis.detection.markers.map((m: string) => <code key={m} className="badge">{m}</code>)}</div>
              {analysis.detection.warnings.map((w: string) => <div key={w} className="alert warn" style={{ marginTop: 8 }}><AlertTriangle size={15} />{w}</div>)}
            </div>
          )}
          <div className="card stack">
            <div className="grid c4">
              <Field label="Tecnología" hint="Puede modificarla manualmente">
                <select className="input" value={technology} onChange={(e) => { setTechnology(e.target.value); const t = techs.find((x) => x.id === e.target.value); if (t) setInternalPort(t.port); }}>
                  {techs.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </Field>
              <Field label="Puerto interno" hint="Puerto en el que escucha la app dentro del contenedor"><input className="input" type="number" value={internalPort} onChange={(e) => setInternalPort(Number(e.target.value))} /></Field>
              <Field label="Health check" hint="Ruta que debe responder HTTP 200"><input className="input mono" value={healthPath} onChange={(e) => setHealthPath(e.target.value)} placeholder="/api/health" /></Field>
              <Field label="Comando de test (opcional)">
                <input className="input mono" value={buildConfig.testCommand ?? ''} onChange={(e) => setBuildConfig({ ...buildConfig, testCommand: e.target.value })} placeholder="npm test" />
              </Field>
            </div>
            <div className="row">
              <Switch checked={!!buildConfig.runTests} onChange={(v) => setBuildConfig({ ...buildConfig, runTests: v })} label="Ejecutar tests en cada deploy" />
              <button className="btn sm outline right" disabled={method === 'empty'} onClick={() => regenerate()}><RefreshCw size={14} />Regenerar Dockerfile para {techs.find((t) => t.id === technology)?.label ?? technology}</button>
            </div>
            {method !== 'empty' ? (
              <>
                <div className="field">Dockerfile propuesto <span className="hint">Editable. Se guardará con la versión {version}.</span></div>
                <CodeEditor value={dockerfile} onChange={setDockerfile} language="dockerfile" height="380px" />
              </>
            ) : <div className="alert info">Proyecto vacío: podrá subir el código y configurar el Dockerfile desde la ficha de la aplicación.</div>}
          </div>
          <div className="row"><button className="btn outline" onClick={() => setStep(0)}><ArrowLeft size={15} />Atrás</button><button className="btn primary right" onClick={() => setStep(2)}>Siguiente<ArrowRight size={15} /></button></div>
        </div>
      )}

      {step === 2 && (
        <div className="stack" style={{ gap: 16 }}>
          <div className="card stack">
            <h3>Ambiente inicial y red</h3>
            <div className={`grid ${SHOW_DOMAIN ? 'c4' : 'c3'}`}>
              <Field label="Ambiente">
                <select className="input" value={envName} onChange={(e) => setEnvName(e.target.value)}>{Object.entries(ENV_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              </Field>
              <Field label="Puerto externo" hint={portMsg ? <span style={{ color: portMsg.ok ? 'var(--ok)' : 'var(--err)' }}>{portMsg.text}</span> : 'Vacío = sólo accesible por ruta o dominio'}>
                <input className="input" type="number" value={externalPort} onChange={(e) => setExternalPort(e.target.value ? Number(e.target.value) : '')} onBlur={() => checkPort(externalPort)} />
              </Field>
              {SHOW_DOMAIN && <>
                <Field label="Dominio" hint="Opcional. Requiere DNS apuntando al servidor"><input className="input mono" value={domain} onChange={(e) => setDomain(e.target.value.trim().toLowerCase())} placeholder="crm.emaservicios.com.ar" /></Field>
                <Field label="HTTPS"><Switch checked={https} onChange={setHttps} label="Let's Encrypt + redirección" /></Field>
              </>}
              <Field label="Ruta *" hint={pathMissing ? <span style={{ color: 'var(--err)' }}>Obligatoria (ej. /holaema)</span> : 'La app debe funcionar dentro de esta ruta (ver instructivo)'}>
                <input className="input mono" value={pathPrefix} onChange={(e) => { setPathTouched(true); setPathPrefix(e.target.value.trim().toLowerCase()); }} placeholder={`/${slug || 'mi-app'}`} />
              </Field>
            </div>
          </div>
          <div className="card stack"><h3>Variables de entorno</h3><VarsEditor rows={vars} onChange={setVars} /></div>
          <div className="card stack"><h3>Volúmenes persistentes</h3><VolumesEditor rows={volumes} onChange={setVolumes} /></div>
          <div className="card grid c2">
            <Field label="Versión"><input className="input mono" value={version} onChange={(e) => setVersion(e.target.value)} /></Field>
            <Field label="Comentario de la versión"><input className="input" value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
          </div>
          <div className="row"><button className="btn outline" onClick={() => setStep(1)}><ArrowLeft size={15} />Atrás</button><button className="btn primary right" disabled={pathMissing} title={pathMissing ? 'Complete la ruta' : undefined} onClick={() => setStep(3)}>Siguiente<ArrowRight size={15} /></button></div>
        </div>
      )}

      {step === 3 && (
        <div className="stack" style={{ gap: 16 }}>
          <div className="card stack">
            <Switch checked={createDb} onChange={setCreateDb} disabled={!can('db.manage')} label={<b>Crear base de datos PostgreSQL para esta aplicación</b>} />
            {createDb && (
              <>
                <div className="grid c3">
                  <Field label="Nombre de la base"><input className="input mono" value={dbName} onChange={(e) => setDbName(e.target.value)} /></Field>
                  <Field label="Usuario propietario"><input className="input mono" value={dbUser} onChange={(e) => setDbUser(e.target.value)} /></Field>
                  <Field label="Host (red interna)"><input className="input mono" disabled value={`ema-${slug}-${envName}-db`} /></Field>
                </div>
                <div className="alert info">La contraseña se genera automáticamente, se guarda cifrada y se inyecta en la app como <code>DATABASE_URL</code>, <code>DATABASE_HOST</code>, <code>DATABASE_PORT</code>, <code>DATABASE_NAME</code>, <code>DATABASE_USER</code> y <code>DATABASE_PASSWORD</code>.</div>
              </>
            )}
          </div>
          <div className="card stack">
            <h3>Resumen</h3>
            <div className="grid c3 small">
              <div><span className="muted">Aplicación</span><div><b>{name}</b> <code>{slug}</code></div></div>
              <div><span className="muted">Tecnología</span><div>{techs.find((t) => t.id === technology)?.label}</div></div>
              <div><span className="muted">Versión</span><div>v{version}</div></div>
              <div><span className="muted">Ambiente</span><div>{ENV_LABEL[envName]}</div></div>
              <div><span className="muted">Acceso</span><div>{pathPrefix ? `Ruta /${pathPrefix.replace(/^\/+|\/+$/g, '')}/` : domain ? `${https ? 'https' : 'http'}://${domain}` : externalPort ? `Puerto ${externalPort} → ${internalPort}` : 'Interno'}</div></div>
              <div><span className="muted">Variables / volúmenes</span><div>{vars.filter((v) => v.key).length} / {volumes.length}</div></div>
            </div>
            {method !== 'empty' && <Switch checked={deploy && canDeployEnv} disabled={!canDeployEnv} onChange={setDeploy} label={<b>Construir imagen y desplegar ahora</b>} />}
            {!canDeployEnv && <span className="muted small">Su rol no puede desplegar en {ENV_LABEL[envName]}; la aplicación quedará registrada para que un administrador la despliegue.</span>}
          </div>
          <div className="row"><button className="btn outline" onClick={() => setStep(2)}><ArrowLeft size={15} />Atrás</button>
            <button className="btn primary right" disabled={busy} onClick={create}>{busy ? <span className="spinner" /> : <Rocket size={15} />}{deploy && method !== 'empty' && canDeployEnv ? 'Crear y desplegar' : 'Crear aplicación'}</button></div>
        </div>
      )}
    </>
  );
}
