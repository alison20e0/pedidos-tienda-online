-- Datos de ejemplo. Idempotente: se puede volver a ejecutar sin duplicar filas.

INSERT INTO producto (sku, nombre, precio, stock, reservado) VALUES
    ('SKU-001', 'Auriculares inalámbricos',  79.90,  10, 0),
    ('SKU-002', 'Mochila urbana 25L',         119.50,   8, 0),
    ('SKU-003', 'Lámpara de escritorio LED',  34.00,  15, 0)
ON CONFLICT (sku) DO UPDATE
SET nombre = EXCLUDED.nombre,
    precio = EXCLUDED.precio;