-- Promoción entre ambientes: cada deploy exitoso guarda el ID de la imagen Docker que quedó corriendo.
-- Al pasar una versión de un ambiente a otro (ej. Test → Producción) se exige esa misma imagen, sin recompilar.
ALTER TABLE deployments ADD COLUMN image_id VARCHAR(128);
ALTER TABLE deployments ADD COLUMN promoted_from VARCHAR(20);
