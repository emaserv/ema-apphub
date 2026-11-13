/**
 * Versiones de las imágenes base que usan las plantillas de Dockerfile.
 * Revisar periódicamente y actualizar acá (fechas de fin de soporte al 2026-11-05):
 *   nginx  → rama estable 1.30 (https://nginx.org)
 *   Alpine → 3.24, soporte hasta 2028-06 (https://alpinelinux.org/releases/)
 *   .NET   → 10 (LTS) hasta 2028-11; 8 y 9 sin soporte desde 2026-11-10 (https://dotnet.microsoft.com/platform/support/policy)
 *   Go     → se mantienen las 2 últimas versiones: 1.27 y 1.26 (https://go.dev/doc/devel/release)
 * Node.js se define en nodeVersion.ts.
 */
/**
 * Trivy (escaneo de vulnerabilidades en el deploy). Fijado por versión Y digest: en marzo de 2026 se publicaron
 * versiones maliciosas de Trivy (CVE-2026-33634, 0.69.4–0.69.6 y "latest"). Nunca usar "latest".
 * Para actualizar: elegir una versión con al menos 2 semanas publicada y sin reportes, y copiar su digest de
 * https://hub.docker.com/r/aquasec/trivy/tags (0.76.1, publicada el 2026-10-21).
 */
export const TRIVY_IMAGE = 'aquasec/trivy:0.76.1@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c';

export const NGINX_IMAGE = 'nginx:1.30-alpine';
export const ALPINE_IMAGE = 'alpine:3.24';

export const DOTNET_DEFAULT = '10';
/** Versiones mayores de .NET con soporte de Microsoft. */
export const DOTNET_SUPPORTED = ['10'];

export const GO_DEFAULT = '1.27';

/**
 * Elige la versión de Go para compilar. La directiva `go` de go.mod es la versión MÍNIMA requerida y Go
 * garantiza compatibilidad hacia atrás, así que se usa la más nueva entre go.mod y GO_DEFAULT.
 */
export function resolveGoVersion(goMod?: string | null): string {
  if (!goMod) return GO_DEFAULT;
  const minor = (v: string) => Number(v.split('.')[1] ?? 0);
  return minor(goMod) > minor(GO_DEFAULT) ? goMod : GO_DEFAULT;
}
