import { one, q } from '../db/pool';
import { decrypt, encrypt } from '../lib/crypto';

/**
 * Verifica al arrancar que la MASTER_KEY del .env sea la misma que cifró los datos guardados.
 * Si no lo es, AppHub no arranca: así se evita mezclar secretos cifrados con dos claves distintas,
 * que después no se pueden separar.
 */

const SETTING = 'master_key_check';
const CANARY = 'ema-apphub-master-key';
/** Columnas con datos cifrados, para validar la clave la primera vez en una instalación existente. */
const ENCRYPTED: [table: string, column: string][] = [
  ['environment_variables', 'value_enc'],
  ['database_credentials', 'password_enc'],
  ['docker_registries', 'password_enc'],
  ['repositories', 'credential_enc'],
  ['application_versions', 'env_snapshot_enc'],
];

export const WRONG_KEY_MESSAGE = [
  'La MASTER_KEY configurada no es la que se usó para cifrar los datos de esta instalación.',
  'AppHub no arranca para no mezclar claves ni dañar los secretos guardados.',
  'Qué hacer: ponga en el .env la MASTER_KEY original (búsquela en el respaldo del .env) y reinicie.',
  'Si la clave original se perdió definitivamente, vea "Se perdió MASTER_KEY" en el README.',
].join('\n');

const canDecrypt = (payload: string, expected?: string) => {
  try {
    const plain = decrypt(payload);
    return expected === undefined || plain === expected;
  } catch {
    return false;
  }
};

async function saveCanary() {
  await q(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [SETTING, JSON.stringify({ enc: encrypt(CANARY) })],
  );
}

/**
 * - 'ok': la clave es la correcta.
 * - 'created': primera vez; se guardó el valor de control.
 * - 'accepted': la clave no coincidía y se aceptó la nueva (MASTER_KEY_ACCEPT_NEW=true).
 * Lanza un error con WRONG_KEY_MESSAGE si la clave no coincide.
 */
export async function verifyMasterKey(opts: { acceptNew?: boolean } = {}): Promise<'ok' | 'created' | 'accepted'> {
  const row = await one<{ value: { enc?: string } }>(`SELECT value FROM settings WHERE key=$1`, [SETTING]);
  let matches: boolean;
  if (row) {
    matches = !!row.value?.enc && canDecrypt(row.value.enc, CANARY);
  } else {
    // Primera vez: si ya hay secretos guardados, la clave tiene que poder leerlos
    matches = true;
    for (const [table, column] of ENCRYPTED) {
      const s = await one<{ v: string }>(`SELECT ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL LIMIT 1`);
      if (s && !canDecrypt(s.v)) { matches = false; break; }
    }
  }

  if (matches) {
    if (!row) await saveCanary();
    return row ? 'ok' : 'created';
  }
  if (!opts.acceptNew) throw new Error(WRONG_KEY_MESSAGE);
  await saveCanary();
  return 'accepted';
}
