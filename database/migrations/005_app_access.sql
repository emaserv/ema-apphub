-- Permisos por aplicación: Desarrollador y Consulta ven sólo las apps asignadas (o todas si all_apps).
-- Superadmin y Admin ven todas siempre (se decide por rol en el backend, no con esta columna).
ALTER TABLE users ADD COLUMN all_apps BOOLEAN NOT NULL DEFAULT FALSE;

-- Los usuarios que ya existen siguen viendo todo, para que nadie pierda acceso al actualizar.
-- Los que se creen desde ahora arrancan sin aplicaciones.
UPDATE users SET all_apps = TRUE;

CREATE TABLE user_applications (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, application_id)
);
CREATE INDEX idx_user_applications_app ON user_applications(application_id);
