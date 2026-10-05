'use strict';

const entero = (valor, porDefecto) => {
  const n = Number.parseInt(valor ?? '', 10);
  return Number.isFinite(n) ? n : porDefecto;
};

const config = {
  port: entero(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV || 'development',

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: entero(process.env.DB_PORT, 5432),
    name: process.env.DB_NAME || 'pedidos_db',
    user: process.env.DB_USER || 'admin',
    password: process.env.DB_PASSWORD || 'secretpassword123',
    max: entero(process.env.DB_POOL_MAX, 10)
  },

  rabbit: {
    host: process.env.RABBITMQ_HOST || 'localhost',
    port: entero(process.env.RABBITMQ_PORT, 5672),
    user: process.env.RABBITMQ_USER || 'admin',
    password: process.env.RABBITMQ_PASSWORD || 'secretpassword123',
    exchange: process.env.RABBITMQ_EXCHANGE || 'pedidos.eventos',
    queue: process.env.RABBITMQ_QUEUE || 'notificaciones.cliente'
  },

  // Ventana de tiempo para completar el pago de un pedido reservado.
  reservaTtlMinutos: entero(process.env.RESERVA_TTL_MINUTOS, 15),
  // Cada cuánto se liberan las reservas vencidas.
  barridoReservasMs: entero(process.env.BARRIDO_RESERVAS_MS, 30000),

  directorioSql: process.env.DIRECTORIO_SQL || 'scripts/sql'
};

module.exports = config;