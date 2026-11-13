import path from 'path';

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}
const int = (v: string | undefined, d: number) => (v && !isNaN(Number(v)) ? Number(v) : d);
const bool = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'si'].includes(v.toLowerCase()));

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 4000),
  databaseUrl: req('DATABASE_URL', 'postgres://apphub:apphub@localhost:5432/apphub'),
  jwtSecret: req('JWT_SECRET', process.env.NODE_ENV === 'production' ? undefined : 'dev-jwt-secret-change-me'),
  jwtExpiresHours: int(process.env.JWT_EXPIRES_HOURS, 8),
  masterKey: req('MASTER_KEY', process.env.NODE_ENV === 'production' ? undefined : 'dev-master-key-change-me'),
  /** Sólo si la MASTER_KEY original se perdió: acepta la nueva aunque no pueda leer los secretos guardados. */
  masterKeyAcceptNew: bool(process.env.MASTER_KEY_ACCEPT_NEW, false),
  cookieSecure: bool(process.env.COOKIE_SECURE, false),
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  trustProxy: int(process.env.TRUST_PROXY, 1),

  dataDir: path.resolve(process.env.DATA_DIR || path.join(process.cwd(), '..', 'storage')),
  migrationsDir: process.env.MIGRATIONS_DIR || path.resolve(__dirname, '..', '..', 'database'),

  maxUploadMb: int(process.env.MAX_UPLOAD_MB, 500),
  maxUnzippedMb: int(process.env.MAX_UNZIPPED_MB, 2048),
  maxZipEntries: int(process.env.MAX_ZIP_ENTRIES, 60000),

  appsNetwork: process.env.APPS_NETWORK || 'ema_apps',
  imagePrefix: process.env.IMAGE_PREFIX || 'ema',
  baseDomain: process.env.APPS_BASE_DOMAIN || '',
  publicHost: process.env.PUBLIC_HOST || 'localhost',
  traefikEnabled: bool(process.env.TRAEFIK_ENABLED, true),
  traefikCertResolver: process.env.TRAEFIK_CERT_RESOLVER || 'letsencrypt',
  portRangeStart: int(process.env.PORT_RANGE_START, 8100),
  portRangeEnd: int(process.env.PORT_RANGE_END, 8999),

  healthIntervalSec: int(process.env.HEALTH_INTERVAL_SEC, 60),
  healthTimeoutMs: int(process.env.HEALTH_TIMEOUT_MS, 5000),
  deployHealthWaitSec: int(process.env.DEPLOY_HEALTH_WAIT_SEC, 90),
  buildTimeoutMin: int(process.env.BUILD_TIMEOUT_MIN, 30),

  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminEmail: process.env.ADMIN_EMAIL || 'admin@emaservicios.com.ar',
  adminPassword: process.env.ADMIN_PASSWORD || 'CambiarEsto123!',
  terminalEnabled: bool(process.env.TERMINAL_ENABLED, true),
  /** Escaneo de vulnerabilidades de las imágenes con Trivy durante el deploy. */
  scanEnabled: bool(process.env.SCAN_ENABLED, true),
};

export const paths = {
  apps: () => path.join(config.dataDir, 'applications'),
  app: (slug: string) => path.join(config.dataDir, 'applications', slug),
  versionSource: (slug: string, version: string) => path.join(config.dataDir, 'applications', slug, 'versions', version, 'source'),
  envDir: (slug: string, env: string) => path.join(config.dataDir, 'applications', slug, 'environments', env),
  uploads: () => path.join(config.dataDir, 'tmp'),
  backups: (slug: string) => path.join(config.dataDir, 'backups', slug),
  logs: () => path.join(config.dataDir, 'logs'),
  ssh: () => path.join(config.dataDir, '.ssh'),
};
