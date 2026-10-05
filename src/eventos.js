'use strict';

const db = require('./db');
const rabbit = require('./rabbit');
const { logger } = require('./log');

// Tipos de evento que ademas se publican en RabbitMQ.
const PUBLICABLES = {
  PEDIDO_PAGADO: 'PedidoPagado',
  PEDIDO_DESPACHADO: 'PedidoDespachado'
};

/**
 * Guarda un evento en el historial del pedido (evento_pedido). Si el evento es
 * publicable, la fila queda marcada como tal y se devuelve el id para marcar
 * publicado_en cuando el broker confirme.
 */
async function registrarEvento(client, { pedidoId, tipo, estadoAnterior, estadoNuevo, detalle }) {
  const publicable = Object.prototype.hasOwnProperty.call(PUBLICABLES, tipo);
  const { rows } = await client.query(
    `INSERT INTO evento_pedido
       (pedido_id, tipo, estado_anterior, estado_nuevo, detalle, publicable)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [pedidoId, tipo, estadoAnterior, estadoNuevo, detalle ?? null, publicable]
  );
  return { id: rows[0].id, publicable, tipo };
}

/** Publica el evento en el bus y estampa la confirmacion del broker. */
async function publicarEvento(evento, pedido) {
  if (!evento || !evento.publicable) return;

  const cuerpo = {
    tipo: PUBLICABLES[evento.tipo],
    pedido_id: pedido.id,
    cliente: pedido.cliente,
    total: pedido.total,
    occurred_at: new Date().toISOString()
  };

  try {
    await rabbit.publicar(PUBLICABLES[evento.tipo], cuerpo);
    await db.query('UPDATE evento_pedido SET publicado_en = now() WHERE id = $1', [evento.id]);
    logger.info('eventos', `publicado ${cuerpo.tipo}`, { pedido_id: pedido.id });
  } catch (err) {
    // El estado del pedido ya quedo confirmado en la base; solo se pierde la
    // notificacion, que queda registrada como no publicada.
    logger.error('eventos', `fallo al publicar ${cuerpo.tipo}`, {
      pedido_id: pedido.id,
      error: err.message
    });
  }
}

module.exports = { registrarEvento, publicarEvento, PUBLICABLES };