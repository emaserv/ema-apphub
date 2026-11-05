/**
 * Elige la versión mayor de Node.js para la imagen Docker a partir de `engines.node` del package.json.
 *
 * Regla: entre las LTS con soporte que cumplen el rango se prefiere la de NODE_LTS_PREFERENCE (en orden).
 * Si ninguna LTS con soporte cumple (p. ej. "16.x" o "^18"), se respeta el rango usando la mayor versión
 * que lo cumpla, con una advertencia. Sin `engines.node` o con un rango ilegible se usa NODE_DEFAULT.
 *
 * Mantener al día según https://nodejs.org/en/about/previous-releases
 *   22 → fin de soporte 2027-04-30 · 24 → 2028-04-30 · 26 → 2029-04-30
 */
export const NODE_LTS_PREFERENCE = [24, 26, 22];
export const NODE_DEFAULT = NODE_LTS_PREFERENCE[0];

/** Mayores más antigua y más nueva que se consideran al buscar una versión fuera de soporte. */
const MIN_MAJOR = 10;
const MAX_MAJOR = 30;

export interface NodeVersionResult {
  version: string;
  warning?: string;
}

// Versión codificada como número para comparar: major.minor.patch → major·1e12 + minor·1e6 + patch
const enc = (M: number, m = 0, p = 0) => M * 1e12 + m * 1e6 + p;
const INF = Number.POSITIVE_INFINITY;

type Interval = [lo: number, hi: number]; // [lo, hi)

const COMPARATOR = /^(<=|>=|<|>|=|\^|~)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:[-+][0-9A-Za-z.-]*)?$/;

/** Convierte un comparador semver (">=18", "^20.1", "22.x", "*") en un intervalo. null si no se entiende. */
function comparatorToInterval(token: string): Interval | null {
  const m = token.match(COMPARATOR);
  if (!m) return null;
  const op = m[1] || '=';
  const parts = [m[2], m[3], m[4]];
  const wild = (s?: string) => s === undefined || /^[xX*]$/.test(s);
  // Cantidad de componentes concretos antes del primer comodín: "20.x" → 1, "20.1.3" → 3, "*" → 0
  let n = 0;
  while (n < 3 && !wild(parts[n])) n++;
  const [M, mi, p] = [0, 1, 2].map((i) => (i < n ? Number(parts[i]) : 0));
  if (n === 0) return op === '<' || op === '>' ? [0, 0] : [0, INF];

  const lo = enc(M, mi, p);
  // Siguiente versión después del último componente concreto: "20" → 21.0.0, "20.1" → 20.2.0, "20.1.3" → 20.1.4
  const next = n === 1 ? enc(M + 1) : n === 2 ? enc(M, mi + 1) : enc(M, mi, p + 1);

  switch (op) {
    case '=': return [lo, next];
    case '>=': return [lo, INF];
    case '>': return [next, INF];
    case '<': return [0, lo];
    case '<=': return [0, next];
    case '~': return [lo, n === 1 ? enc(M + 1) : enc(M, mi + 1)];
    case '^': return [lo, M > 0 ? enc(M + 1) : n >= 2 && mi > 0 ? enc(0, mi + 1) : enc(1)];
  }
  return null;
}

/** Parsea un rango semver a una lista de intervalos (uno por alternativa "||"). null si no se entiende. */
function parseRange(range: string): Interval[] | null {
  const out: Interval[] = [];
  for (const alt of range.split('||')) {
    let set = alt.trim();
    if (!set) { out.push([0, INF]); continue; }
    // Rango con guion: "18 - 20" ≡ ">=18 <=20"
    const hyphen = set.match(/^(\S+)\s+-\s+(\S+)$/);
    if (hyphen) set = `>=${hyphen[1]} <=${hyphen[2]}`;
    // Une operadores separados de su versión: ">= 18" → ">=18"
    const tokens = set.replace(/(<=|>=|<|>|=|\^|~)\s+/g, '$1').split(/\s+/);
    let lo = 0, hi = INF;
    for (const t of tokens) {
      const iv = comparatorToInterval(t);
      if (!iv) return null;
      lo = Math.max(lo, iv[0]);
      hi = Math.min(hi, iv[1]);
    }
    out.push([lo, hi]);
  }
  return out;
}

/** ¿Alguna versión de la mayor `major` cumple el rango? */
function allowsMajor(intervals: Interval[], major: number): boolean {
  return intervals.some(([lo, hi]) => lo < hi && lo < enc(major + 1) && hi > enc(major));
}

export function resolveNodeVersion(engines: unknown): NodeVersionResult {
  const range = typeof engines === 'string' ? engines.trim() : '';
  if (!range) return { version: String(NODE_DEFAULT) };

  const intervals = parseRange(range);
  if (!intervals) {
    return { version: String(NODE_DEFAULT), warning: `No se pudo interpretar engines.node "${range}": se usará Node ${NODE_DEFAULT}.` };
  }

  const lts = NODE_LTS_PREFERENCE.find((v) => allowsMajor(intervals, v));
  if (lts !== undefined) return { version: String(lts) };

  for (let v = MAX_MAJOR; v >= MIN_MAJOR; v--) {
    if (allowsMajor(intervals, v)) {
      return {
        version: String(v),
        warning: `engines.node "${range}" exige Node ${v}, que no es una LTS con soporte. Se usará igual; conviene actualizar la app a Node ${NODE_DEFAULT}.`,
      };
    }
  }
  return { version: String(NODE_DEFAULT), warning: `Ninguna versión de Node cumple engines.node "${range}": se usará Node ${NODE_DEFAULT}.` };
}
