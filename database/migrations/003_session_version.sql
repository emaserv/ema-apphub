-- Cierre de sesión real: cada sesión (JWT) lleva el session_version del usuario al momento del login.
-- Al cerrar sesión, cambiar o resetear la contraseña, o desactivar al usuario, se incrementa y
-- todas sus sesiones anteriores dejan de valer, aunque el token no haya vencido.
ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;
