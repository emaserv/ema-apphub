-- Avisos dentro de AppHub (campanita) para los superadministradores:
-- deploy fallido, app caída / recuperada, backup programado fallido.
-- Una fila por destinatario, para que cada uno marque sus avisos como leídos.
CREATE TABLE notifications (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           VARCHAR(30) NOT NULL,   -- deploy_failed | deploy_rolled_back | app_down | app_recovered | backup_failed
  severity       VARCHAR(10) NOT NULL CHECK (severity IN ('error', 'warn', 'ok')),
  title          VARCHAR(300) NOT NULL,
  body           TEXT,
  application_id UUID REFERENCES applications(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at        TIMESTAMPTZ
);
CREATE INDEX idx_notifications_user ON notifications (user_id, created_at DESC);
