-- Publicación de apps por ruta (ej. https://apphub.emaservicios.com.ar/holaema):
-- Traefik envía a la app todo lo que empiece con la ruta, sin ella. Una ruta no puede repetirse entre ambientes.
ALTER TABLE application_environments ADD COLUMN path_prefix VARCHAR(64);
CREATE UNIQUE INDEX idx_environments_path_prefix ON application_environments(lower(path_prefix)) WHERE path_prefix IS NOT NULL;
