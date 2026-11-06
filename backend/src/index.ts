import http from 'http';
import { createApp } from './app';
import { config } from './config';
import { migrate } from './db/migrate';
import { ensureNetwork, ping } from './services/docker';
import { startMonitors } from './services/monitor';
import { ensureDataDirs } from './services/storage';
import { attachWebSockets } from './ws';

async function main() {
  ensureDataDirs();
  await migrate();

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
  console.error('[apphub] error fatal', e);
  process.exit(1);
});
