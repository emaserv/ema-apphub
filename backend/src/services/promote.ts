const ENV_LABEL: Record<string, string> = { development: 'Desarrollo', test: 'Test', staging: 'Staging', production: 'Producción' };

/** Datos mínimos para decidir si una versión se puede pasar de un ambiente a otro. */
export interface PromotionCheck {
  source: { name: string; status: string; deployed_version_id: string | null };
  target: { name: string; status: string; deployed_version_id: string | null };
  /** Imagen registrada en el último deploy exitoso de esa versión en el ambiente de origen. */
  sourceImageId: string | null;
  /** La versión se editó (código o Dockerfile) y el próximo deploy la recompilaría. */
  versionDirty: boolean;
  versionLabel: string;
}

/**
 * Promover = desplegar en `target` exactamente la imagen que corre en `source`, sin recompilar.
 * Devuelve el motivo por el que no se puede, o null si se puede.
 */
export function promotionError(c: PromotionCheck): string | null {
  const from = ENV_LABEL[c.source.name] ?? c.source.name;
  const to = ENV_LABEL[c.target.name] ?? c.target.name;
  if (c.source.name === c.target.name) return 'Elija un ambiente de destino distinto al de origen';
  if (!c.source.deployed_version_id) return `${from} no tiene ninguna versión desplegada`;
  if (c.source.status !== 'running') return `${from} no está funcionando (estado: ${c.source.status}): no se puede confirmar que la versión ande`;
  if (c.target.status === 'deploying') return `Ya hay un deploy en curso en ${to}`;
  if (c.target.deployed_version_id === c.source.deployed_version_id) return `${to} ya tiene la versión ${c.versionLabel}`;
  if (c.versionDirty) {
    return `La versión ${c.versionLabel} se modificó después de desplegarse en ${from}. Despliéguela de nuevo en ${from} y pruébela antes de pasarla.`;
  }
  if (!c.sourceImageId) {
    return `No hay registro de la imagen que corre en ${from} (se desplegó antes de esta función). Haga un deploy en ${from} y vuelva a intentar.`;
  }
  return null;
}
