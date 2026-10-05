-- Esquema de la tienda online.
-- Se ejecuta al inicializar el contenedor de PostgreSQL (docker-entrypoint-initdb.d)
-- y tambien de forma idempotente al arrancar la API.

CREATE TABLE IF NOT EXISTS producto (
    id             SERIAL PRIMARY KEY,
    sku            TEXT NOT NULL UNIQUE,
    nombre         TEXT NOT NULL,
    precio         NUMERIC(12, 2) NOT NULL CHECK (precio >= 0),
    stock          INTEGER NOT NULL CHECK (stock >= 0),
    reservado      INTEGER NOT NULL DEFAULT 0 CHECK (reservado >= 0),
    CONSTRAINT producto_reservado_no_excede_stock CHECK (reservado <= stock),
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pedido (
    id                SERIAL PRIMARY KEY,
    idempotency_key   TEXT NOT NULL UNIQUE,
    cliente           TEXT NOT NULL,
    estado            TEXT NOT NULL CHECK (estado IN (
                          'CONFIRMADO',
                          'RESERVADO',
                          'PAGADO',
                          'EN_PREPARACION',
                          'DESPACHADO',
                          'CANCELADO',
                          'EN_REVISION'
                      )),
    total             NUMERIC(12, 2) NOT NULL CHECK (total >= 0),
    reserva_expira_en TIMESTAMPTZ,
    creado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pedido_reserva ON pedido (estado, reserva_expira_en);
CREATE INDEX IF NOT EXISTS idx_pedido_cliente ON pedido (cliente);

CREATE TABLE IF NOT EXISTS pedido_item (
    id            SERIAL PRIMARY KEY,
    pedido_id     INTEGER NOT NULL REFERENCES pedido (id) ON DELETE CASCADE,
    producto_id   INTEGER NOT NULL REFERENCES producto (id),
    cantidad      INTEGER NOT NULL CHECK (cantidad > 0),
    precio_unitario NUMERIC(12, 2) NOT NULL CHECK (precio_unitario >= 0),
    subtotal      NUMERIC(12, 2) GENERATED ALWAYS AS (cantidad * precio_unitario) STORED,
    UNIQUE (pedido_id, producto_id)
);

CREATE INDEX IF NOT EXISTS idx_pedido_item_pedido ON pedido_item (pedido_id);

-- Un pago por referencia: es la clave de idempotencia del webhook del proveedor.
CREATE TABLE IF NOT EXISTS pago (
    id           SERIAL PRIMARY KEY,
    referencia   TEXT NOT NULL UNIQUE,
    pedido_id    INTEGER NOT NULL REFERENCES pedido (id) ON DELETE CASCADE,
    estado       TEXT NOT NULL CHECK (estado IN ('APROBADO', 'RECHAZADO', 'ANULADO')),
    monto        NUMERIC(12, 2) NOT NULL CHECK (monto >= 0),
    motivo       TEXT,
    recibido_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pago_pedido ON pago (pedido_id);

CREATE TABLE IF NOT EXISTS evento_pedido (
    id              SERIAL PRIMARY KEY,
    pedido_id       INTEGER NOT NULL REFERENCES pedido (id) ON DELETE CASCADE,
    tipo            TEXT NOT NULL,
    estado_anterior TEXT,
    estado_nuevo    TEXT NOT NULL,
    detalle         TEXT,
    publicable      BOOLEAN NOT NULL DEFAULT FALSE,
    publicado_en    TIMESTAMPTZ,
    creado_en       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evento_pedido_pedido ON evento_pedido (pedido_id, id);