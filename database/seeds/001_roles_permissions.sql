-- Seed idempotente de roles y permisos (se ejecuta en cada arranque)
INSERT INTO roles (code, name, description) VALUES
 ('superadmin', 'Super Administrador', 'Acceso completo a la plataforma'),
 ('admin',      'Administrador',       'Gestiona aplicaciones, deploys, bases de datos y backups'),
 ('developer',  'Desarrollador',       'Sube código, crea versiones, ve logs y despliega en ambientes no productivos'),
 ('viewer',     'Consulta',            'Sólo lectura de aplicaciones y estados')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description;

INSERT INTO permissions (code, description) VALUES
 ('apps.view',          'Ver aplicaciones, estado e información general'),
 ('apps.create',        'Crear e importar aplicaciones'),
 ('apps.edit',          'Modificar configuración de aplicaciones, ambientes y variables'),
 ('apps.delete',        'Eliminar aplicaciones'),
 ('apps.access',        'Asignar qué Desarrolladores y Consultas trabajan en cada aplicación'),
 ('apps.operate',       'Iniciar, detener y reiniciar ambientes'),
 ('apps.deploy.nonprod','Desplegar en development / test / staging'),
 ('apps.deploy.prod',   'Desplegar y hacer rollback en production'),
 ('apps.logs',          'Ver y descargar logs'),
 ('versions.create',    'Subir código y crear versiones'),
 ('db.view',            'Ver bases de datos y conexión'),
 ('db.manage',          'Crear, eliminar, reiniciar bases y administrar usuarios'),
 ('backups.view',       'Ver historial de backups'),
 ('backups.manage',     'Crear, restaurar, descargar y programar backups'),
 ('docker.view',        'Ver contenedores e imágenes'),
 ('docker.manage',      'Operar contenedores administrados por la plataforma'),
 ('git.manage',         'Configurar repositorios y credenciales Git'),
 ('users.manage',       'Administrar usuarios y roles'),
 ('audit.view',         'Ver auditoría'),
 ('settings.manage',    'Configurar registries y parámetros de la plataforma'),
 ('terminal.access',    'Abrir terminal web dentro de contenedores')
ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;

-- superadmin: todos
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.code = 'superadmin'
ON CONFLICT DO NOTHING;

-- admin: todo excepto usuarios y terminal
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON p.code NOT IN ('users.manage','terminal.access')
WHERE r.code = 'admin'
ON CONFLICT DO NOTHING;

-- developer
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON p.code IN ('apps.view','apps.create','apps.operate','apps.deploy.nonprod','apps.logs',
                'versions.create','db.view','backups.view','docker.view','git.manage')
WHERE r.code = 'developer'
ON CONFLICT DO NOTHING;

-- viewer
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON p.code IN ('apps.view','docker.view')
WHERE r.code = 'viewer'
ON CONFLICT DO NOTHING;
