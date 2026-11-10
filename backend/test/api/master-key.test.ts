import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { one, start, stop } from './helpers';
import { q } from '../../src/db/pool';
import { encrypt } from '../../src/lib/crypto';
import { verifyMasterKey, WRONG_KEY_MESSAGE } from '../../src/services/masterKey';

/** Cifra igual que lib/crypto pero con OTRA clave (como si el .env tuviera una MASTER_KEY distinta). */
function encryptWithOtherKey(plain: string): string {
  const key = crypto.createHash('sha256').update('otra-master-key').digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}
const wrongKey = { message: WRONG_KEY_MESSAGE };
const addRegistrySecret = (enc: string) =>
  q(`INSERT INTO docker_registries (name, kind, url, password_enc) VALUES ('reg', 'private', 'reg.local', $1)`, [enc]);

before(start);
after(stop);
beforeEach(async () => {
  await q(`DELETE FROM settings WHERE key = 'master_key_check'`);
  await q(`DELETE FROM docker_registries`);
});

test('instalación nueva: registra la clave y en los arranques siguientes la acepta', async () => {
  assert.equal(await verifyMasterKey(), 'created');
  assert.ok(await one(`SELECT 1 FROM settings WHERE key = 'master_key_check'`));
  assert.equal(await verifyMasterKey(), 'ok');
});

test('si la clave cambió, no arranca', async () => {
  await verifyMasterKey();
  await q(`UPDATE settings SET value = $1::jsonb WHERE key = 'master_key_check'`, [JSON.stringify({ enc: encryptWithOtherKey('ema-apphub-master-key') })]);
  await assert.rejects(verifyMasterKey(), wrongKey);
});

test('instalación existente sin registro: valida la clave contra los secretos ya guardados', async () => {
  await addRegistrySecret(encryptWithOtherKey('clave-del-registry'));
  await assert.rejects(verifyMasterKey(), wrongKey, 'los secretos son de otra clave');
  assert.equal(await one(`SELECT 1 FROM settings WHERE key = 'master_key_check'`), null, 'no registra una clave incorrecta');

  await q(`DELETE FROM docker_registries`);
  await addRegistrySecret(encrypt('clave-del-registry'));
  assert.equal(await verifyMasterKey(), 'created', 'los secretos son de esta clave');
});

test('MASTER_KEY_ACCEPT_NEW: acepta la clave nueva a propósito y desde ahí la verifica', async () => {
  await addRegistrySecret(encryptWithOtherKey('clave-del-registry'));
  assert.equal(await verifyMasterKey({ acceptNew: true }), 'accepted');
  assert.equal(await verifyMasterKey(), 'ok', 'ya no hace falta la variable');
});
