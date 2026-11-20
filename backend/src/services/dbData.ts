import { one } from '../db/pool';
import { badRequest, notFound } from '../lib/http';
import * as dk from './docker';
import { ownerCredentials } from './database';

/**
 * Explorador de datos de la base PostgreSQL de un ambiente: listar tablas, ver registros y agregar, editar o eliminar.
 *
 * Las consultas se ejecutan con psql dentro del contenedor de la base (como el resto de la administración de bases):
 * AppHub no se conecta a la red interna de la app. Seguridad del SQL:
 * - tablas y columnas se validan contra el catálogo antes de usarlas y van entre comillas dobles (quoteIdent);
 * - los valores van siempre como literal de texto con las comillas duplicadas (lit) y se convierten al tipo de la
 *   columna con CAST; el tipo sale del catálogo (format_type), nunca del usuario.
 * Para editar o eliminar, la tabla necesita clave primaria: así cada operación afecta exactamente un registro.
 */

export const PAGE_MAX = 200;

export const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
export const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  hasDefault: boolean;
  /** 'a' = identity ALWAYS (no se puede escribir), 'd' = BY DEFAULT, '' = no es identity. */
  identity: string;
  /** 's' = columna generada (no se puede escribir), '' = normal. */
  generated: string;
}

export interface TableInfo {
  schema: string;
  name: string;
  /** 'r' tabla, 'p' tabla particionada, 'v' vista, 'm' vista materializada. */
  kind: string;
  columns: ColumnInfo[];
  pk: string[];
}

/** Se puede escribir la columna (no es generada ni identity ALWAYS). */
export const writable = (c: ColumnInfo) => c.generated === '' && c.identity !== 'a';
/** La tabla admite agregar, editar y eliminar desde el panel. */
export const editable = (t: TableInfo) => (t.kind === 'r' || t.kind === 'p') && t.pk.length > 0;

const rel = (t: Pick<TableInfo, 'schema' | 'name'>) => `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`;
const val = (v: string | null, type: string) => (v === null ? 'NULL' : `CAST(${lit(v)} AS ${type})`);

function columnOf(t: TableInfo, name: string): ColumnInfo {
  const c = t.columns.find((x) => x.name === name);
  if (!c) throw badRequest(`La columna ${name} no existe en ${t.name}`);
  return c;
}

function pkWhere(t: TableInfo, pk: Record<string, string>) {
  if (!editable(t)) throw badRequest('La tabla no tiene clave primaria: sólo se puede consultar');
  const keys = Object.keys(pk);
  if (keys.length !== t.pk.length || !t.pk.every((k) => typeof pk[k] === 'string')) throw badRequest('Identificación del registro inválida');
  return t.pk.map((k) => `${quoteIdent(k)} = ${val(pk[k], columnOf(t, k).type)}`).join(' AND ');
}

function setValues(t: TableInfo, values: Record<string, string | null>, forUpdate: boolean) {
  const cols = Object.keys(values);
  for (const name of cols) {
    const c = columnOf(t, name);
    if (!writable(c)) throw badRequest(`La columna ${name} la calcula la base: no se puede escribir`);
    if (forUpdate && t.pk.includes(name)) throw badRequest(`La columna ${name} es la clave primaria: no se puede modificar`);
    const v = values[name];
    if (v !== null && typeof v !== 'string') throw badRequest(`Valor inválido para ${name}`);
    if (v === null && !c.nullable) throw badRequest(`La columna ${name} no admite valores vacíos (NULL)`);
  }
  return cols.map((name) => ({ name, sql: val(values[name], columnOf(t, name).type) }));
}

// ───────── SQL (funciones puras, testeadas en test/dbData.test.ts) ─────────

// Cantidad de registros: exacta en tablas de hasta ~200.000 (count(*) vía query_to_xml, que permite armar la consulta
// por tabla); en las más grandes, la estimación de PostgreSQL (contar millones de filas sería lento). En vistas, ninguna.
export const LIST_TABLES_SQL = `SELECT coalesce(json_agg(t ORDER BY t.schema, t.name), '[]') FROM (
  SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind,
         CASE WHEN c.relkind = 'v' THEN NULL
              WHEN c.reltuples < 200000 THEN ((xpath('/row/n/text()',
                query_to_xml(format('SELECT count(*) AS n FROM %I.%I', n.nspname, c.relname), false, true, '')))[1])::text::bigint
              ELSE c.reltuples::bigint END AS rows,
         c.relkind = 'v' OR c.reltuples >= 200000 AS approx,
         EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary) AS "hasPk"
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm')
    AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
) t;`;

export function tableInfoSql(schema: string, table: string) {
  return `SELECT json_build_object('schema', n.nspname, 'name', c.relname, 'kind', c.relkind,
  'columns', (SELECT coalesce(json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
      'nullable', NOT a.attnotnull, 'hasDefault', a.atthasdef, 'identity', a.attidentity, 'generated', a.attgenerated) ORDER BY a.attnum), '[]')
    FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped),
  'pk', (SELECT coalesce(json_agg(a.attname ORDER BY array_position(i.indkey::int2[], a.attnum)), '[]')
    FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
    WHERE i.indrelid = c.oid AND i.indisprimary))
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = ${lit(schema)} AND c.relname = ${lit(table)} AND c.relkind IN ('r', 'p', 'v', 'm');`;
}

export function selectRowsSql(t: TableInfo, o: { limit: number; offset: number; order?: string; dir?: 'asc' | 'desc' }) {
  const limit = Math.min(Math.max(1, Math.trunc(o.limit) || 50), PAGE_MAX);
  const offset = Math.max(0, Math.trunc(o.offset) || 0);
  const dir = o.dir === 'desc' ? 'DESC' : 'ASC';
  const orderCols = o.order ? [columnOf(t, o.order).name] : t.pk.length ? t.pk : t.columns.slice(0, 1).map((c) => c.name);
  // El orden va sobre la columna original (t."x"), no sobre su versión en texto: si no, 10 quedaría antes que 2
  const orderBy = orderCols.length ? `ORDER BY ${orderCols.map((c) => `t.${quoteIdent(c)} ${dir} NULLS LAST`).join(', ')}` : '';
  // Todo como texto: es lo que se muestra y lo que se vuelve a mandar al editar (CAST al tipo de la columna)
  const cols = t.columns.map((c) => `t.${quoteIdent(c.name)}::text AS ${quoteIdent(c.name)}`).join(', ') || 'NULL';
  return `SELECT json_build_object(
  'rows', coalesce((SELECT json_agg(r) FROM (SELECT ${cols} FROM ${rel(t)} AS t ${orderBy} LIMIT ${limit} OFFSET ${offset}) r), '[]'),
  'total', (SELECT count(*) FROM ${rel(t)}));`;
}

export function insertSql(t: TableInfo, values: Record<string, string | null>) {
  if (!editable(t)) throw badRequest('La tabla no tiene clave primaria: sólo se puede consultar');
  const sets = setValues(t, values, false);
  const body = sets.length
    ? `(${sets.map((s) => quoteIdent(s.name)).join(', ')}) VALUES (${sets.map((s) => s.sql).join(', ')})`
    : 'DEFAULT VALUES';
  return `WITH x AS (INSERT INTO ${rel(t)} ${body} RETURNING 1) SELECT count(*) FROM x;`;
}

export function updateSql(t: TableInfo, pk: Record<string, string>, values: Record<string, string | null>) {
  const where = pkWhere(t, pk);
  const sets = setValues(t, values, true);
  if (!sets.length) throw badRequest('No hay cambios para guardar');
  return `WITH x AS (UPDATE ${rel(t)} SET ${sets.map((s) => `${quoteIdent(s.name)} = ${s.sql}`).join(', ')} WHERE ${where} RETURNING 1) SELECT count(*) FROM x;`;
}

export function deleteSql(t: TableInfo, pk: Record<string, string>) {
  return `WITH x AS (DELETE FROM ${rel(t)} WHERE ${pkWhere(t, pk)} RETURNING 1) SELECT count(*) FROM x;`;
}

/** Mensaje de error de PostgreSQL legible ("ERROR: …" y su "DETAIL: …"), sin el prefijo de psql. */
export function pgErrorMessage(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.replace(/^psql:[^:]*:\d+:\s*/, '').trim()).filter(Boolean);
  const msg = lines.filter((l) => /^(ERROR|DETAIL|HINT):/.test(l)).map((l) => l.replace(/^(ERROR|DETAIL|HINT):\s*/, '')).join(' — ');
  return msg || lines.slice(-2).join(' ') || 'Error de la base de datos';
}

// ───────── ejecución ─────────

export type Exec = (sql: string) => Promise<string>;

/**
 * Ejecuta SQL con psql dentro del contenedor, con el usuario propietario, y devuelve la salida (JSON o número).
 * Cada consulta devuelve un solo valor; json_agg lo puede partir en varias líneas, por eso se usa la salida completa.
 */
export async function execFor(envId: string): Promise<Exec> {
  const db = await one(`SELECT * FROM databases WHERE environment_id=$1`, [envId]);
  if (!db) throw notFound('El ambiente no tiene base de datos');
  const { username } = await ownerCredentials(db.id);
  return async (sql) => {
    const r = await dk.execIn(db.container_name, ['psql', '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-A', '-t', '-U', username, '-d', db.database_name],
      `SET statement_timeout = '15s';\n${sql}\n`);
    if (r.code !== 0) throw badRequest(`La base de datos rechazó la operación: ${pgErrorMessage(r.stderr)}`);
    return r.stdout.trim();
  };
}

export async function listTables(exec: Exec) {
  return JSON.parse((await exec(LIST_TABLES_SQL)) || '[]') as { schema: string; name: string; kind: string; rows: number | null; approx: boolean; hasPk: boolean }[];
}

export async function tableInfo(exec: Exec, schema: string, table: string): Promise<TableInfo> {
  const out = await exec(tableInfoSql(schema, table));
  if (!out) throw notFound(`La tabla ${schema}.${table} no existe`);
  return JSON.parse(out);
}

export async function readRows(exec: Exec, t: TableInfo, o: Parameters<typeof selectRowsSql>[1]) {
  const r = JSON.parse(await exec(selectRowsSql(t, o)));
  return { rows: r.rows as Record<string, string | null>[], total: Number(r.total) };
}

/** Ejecuta un INSERT/UPDATE/DELETE armado arriba y verifica que haya afectado exactamente un registro. */
export async function writeOne(exec: Exec, sql: string) {
  const n = Number(await exec(sql));
  if (n === 0) throw notFound('El registro ya no existe (puede que otro usuario lo haya modificado o eliminado)');
  if (n !== 1) throw badRequest(`La operación afectó ${n} registros`);
}
