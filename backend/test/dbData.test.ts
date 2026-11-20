import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deleteSql, editable, insertSql, lit, pgErrorMessage, quoteIdent, selectRowsSql, tableInfoSql, TableInfo, updateSql, writable,
} from '../src/services/dbData';

const col = (name: string, type: string, extra: Partial<TableInfo['columns'][0]> = {}) =>
  ({ name, type, nullable: true, hasDefault: false, identity: '', generated: '', ...extra });

const PRODUCTOS: TableInfo = {
  schema: 'public', name: 'productos', kind: 'r', pk: ['id'],
  columns: [
    col('id', 'integer', { nullable: false, hasDefault: true, identity: 'd' }),
    col('codigo', 'text', { nullable: false }),
    col('precio', 'numeric(12,2)', { nullable: false }),
    col('nota', 'text'),
    col('total', 'numeric', { generated: 's' }),
  ],
};

describe('escape de identificadores y valores', () => {
  test('comillas dobles en nombres y simples en valores se duplican', () => {
    assert.equal(quoteIdent('mi"tabla'), '"mi""tabla"');
    assert.equal(lit("O'Brien"), "'O''Brien'");
  });

  test('un valor con SQL malicioso queda como texto dentro del literal', () => {
    const sql = updateSql(PRODUCTOS, { id: '1' }, { nota: "x'; DROP TABLE productos; --" });
    assert.match(sql, /"nota" = CAST\('x''; DROP TABLE productos; --' AS text\)/);
    assert.equal((sql.match(/;/g) || []).length, 3, 'los únicos ";" son los del literal y el final');
  });

  test('el id del registro también va como literal con CAST al tipo de la columna', () => {
    assert.match(deleteSql(PRODUCTOS, { id: '1 OR 1=1' }), /WHERE "id" = CAST\('1 OR 1=1' AS integer\)/);
  });

  test('la consulta de estructura usa literales para esquema y tabla', () => {
    assert.match(tableInfoSql('public', "x' OR '1'='1"), /c\.relname = 'x'' OR ''1''=''1'/);
  });
});

describe('columnas que se pueden escribir', () => {
  test('rechaza columnas que no existen', () => {
    assert.throws(() => insertSql(PRODUCTOS, { inventada: '1' }), /no existe/);
    assert.throws(() => selectRowsSql(PRODUCTOS, { limit: 10, offset: 0, order: 'id; DROP TABLE x' }), /no existe/);
  });

  test('no deja escribir columnas generadas ni modificar la clave primaria', () => {
    assert.equal(writable(PRODUCTOS.columns[4]), false);
    assert.throws(() => insertSql(PRODUCTOS, { total: '5' }), /la calcula la base/);
    assert.throws(() => updateSql(PRODUCTOS, { id: '1' }, { id: '2' }), /clave primaria/);
  });

  test('identity BY DEFAULT se puede indicar al agregar; ALWAYS no', () => {
    assert.match(insertSql(PRODUCTOS, { id: '50', codigo: 'A', precio: '1' }), /"id", "codigo", "precio"/);
    const always: TableInfo = { ...PRODUCTOS, columns: [col('id', 'integer', { identity: 'a', nullable: false }), col('codigo', 'text')] };
    assert.throws(() => insertSql(always, { id: '1' }), /la calcula la base/);
  });

  test('NULL sólo en columnas que lo admiten', () => {
    assert.match(updateSql(PRODUCTOS, { id: '1' }, { nota: null }), /"nota" = NULL/);
    assert.throws(() => updateSql(PRODUCTOS, { id: '1' }, { codigo: null }), /no admite valores vacíos/);
  });
});

describe('qué tablas se pueden editar', () => {
  test('sin clave primaria o si es una vista: sólo lectura', () => {
    assert.equal(editable(PRODUCTOS), true);
    assert.equal(editable({ ...PRODUCTOS, pk: [] }), false);
    assert.equal(editable({ ...PRODUCTOS, kind: 'v' }), false);
    assert.throws(() => insertSql({ ...PRODUCTOS, pk: [] }, { codigo: 'x' }), /sólo se puede consultar/);
    assert.throws(() => deleteSql({ ...PRODUCTOS, kind: 'v' }, { id: '1' }), /sólo se puede consultar/);
  });

  test('para editar o eliminar hay que indicar la clave primaria completa', () => {
    const compuesta: TableInfo = { ...PRODUCTOS, pk: ['id', 'codigo'] };
    assert.throws(() => deleteSql(compuesta, { id: '1' }), /Identificación del registro inválida/);
    assert.match(deleteSql(compuesta, { id: '1', codigo: 'A' }), /"id" = CAST\('1' AS integer\) AND "codigo" = CAST\('A' AS text\)/);
  });
});

describe('SQL generado', () => {
  test('agregar sin valores usa los valores por defecto', () => {
    assert.equal(insertSql(PRODUCTOS, {}), 'WITH x AS (INSERT INTO "public"."productos" DEFAULT VALUES RETURNING 1) SELECT count(*) FROM x;');
  });

  test('listar: todo como texto, ordenado por la clave primaria y con tope de 200 por página', () => {
    const sql = selectRowsSql(PRODUCTOS, { limit: 5000, offset: -3 });
    assert.match(sql, /t\."precio"::text AS "precio"/);
    assert.match(sql, /ORDER BY t\."id" ASC NULLS LAST LIMIT 200 OFFSET 0/);
    assert.match(selectRowsSql(PRODUCTOS, { limit: 10, offset: 20, order: 'precio', dir: 'desc' }), /ORDER BY t\."precio" DESC NULLS LAST LIMIT 10 OFFSET 20/);
  });

  test('ordena por la columna original, no por su texto (si no, 10 quedaría antes que 2)', () => {
    assert.match(selectRowsSql(PRODUCTOS, { limit: 10, offset: 0 }), /FROM "public"\."productos" AS t ORDER BY t\."id"/);
  });
});

describe('mensajes de error de PostgreSQL', () => {
  test('se muestran sin el prefijo de psql, con el detalle', () => {
    const stderr = 'psql:<stdin>:2: ERROR:  duplicate key value violates unique constraint "productos_codigo_key"\nDETAIL:  Key (codigo)=(HER-001) already exists.\n';
    assert.equal(pgErrorMessage(stderr), 'duplicate key value violates unique constraint "productos_codigo_key" — Key (codigo)=(HER-001) already exists.');
  });
});
