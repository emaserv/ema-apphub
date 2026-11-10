import http from 'http';
import { createApp } from './app';
import { config } from './config';
import { migrate } from './db/migrate';
import { ensureNetwork, ping } from './services/docker';
import { verifyMasterKey, WRONG_KEY_MESSAGE } from './services/masterKey';
import { startMonitors } from './services/monitor';
import { ensureDataDirs } from './services/storage';
import { attachWebSockets } from './ws';

async function main() {
  ensureDataDirs();
  await migrate();
  const key = await verifyMasterKey({ acceptNew: config.masterKeyAcceptNew });
  if (key === 'created') console.log('[apphub] MASTER_KEY registrada: en los próximos arranques se verificará que no cambie.');
  if (key === 'accepted') {
    console.warn('[apphub] ⚠ Se aceptó una MASTER_KEY NUEVA (MASTER_KEY_ACCEPT_NEW=true). Los secretos cifrados con la clave anterior');
    console.warn('[apphub] ⚠ no se pueden leer: vuelva a cargar las variables secretas, las credenciales de Git/registries y rote las');
    console.warn('[apphub] ⚠ contraseñas de las bases. Después quite MASTER_KEY_ACCEPT_NEW del .env.');
  }

  const server = http.createServer(createApp());
  server.requestTimeout = 30 * 60_000; // subidas grandes
  attachWebSockets(server);
  server.listen(config.port, () => console.log(`[apphub] API escuchando en :${config.port} (DATA_DIR=${config.dataDir})`));

  if (await ping()) {
    await ensureNetwork().catch((e) => console.error('[docker] red', e.message));
  } else {
    console.warn('[docker] No se pudo conectar al daemon Docker: las operaciones de despliegue fallarán.');
  }
  await startMonitors();
}

main().catch((e) => {
  if (e instanceof Error && e.message === WRONG_KEY_MESSAGE) {
    // Mensaje claro y sin stack trace: es un problema de configuración, no un error del programa
    for (const line of e.message.split('\n')) console.error(`[apphub] ✖ ${line}`);
    process.exit(1);
  }
  console.error('[apphub] error fatal', e);
  process.exit(1);
});
