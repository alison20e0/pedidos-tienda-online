'use strict';

const { logger } = require('./log');

/**
 * Bloquea los productos implicados (ordenados por id para evitar deadlocks) y
 * calcula si hay stock disponible para TODOS los items.
 *
 * `plan.disponibles` permite aplicar la reserva; `plan.faltantes` describe que
 * impidio la reserva (unidades pedidas frente a unidades libres).
 */
async function planificarReserva(client, items) {
  const ids = items.map((i) => i.producto_id).sort((a, b) => a - b);
  const { rows: productos } = await client.query(
    `SELECT id, nombre, precio, stock, reservado
       FROM producto
      WHERE id = ANY($1::int[])
      ORDER BY id
      FOR UPDATE`,
    [ids]
  );

  const porId = new Map(productos.map((p) => [p.id, p]));
  const faltantes = [];

  for (const item of items) {
    const producto = porId.get(item.producto_id);
    if (!producto) {
      faltantes.push({ producto_id: item.producto_id, motivo: 'PRODUCTO_NO_EXISTE' });
      continue;
    }
    const libre = producto.stock - producto.reservado;
    if (libre < item.cantidad) {
      faltantes.push({
        producto_id: producto.id,
        nombre: producto.nombre,
        cantidad_pedida: item.cantidad,
        cantidad_libre: libre
      });
    }
  }

  return { productos, faltantes };
}

/**
 * Reserva stock con un UPDATE atomico por producto:
 *   UPDATE producto SET reservado = reservado + $2
 *    WHERE id = $1 AND stock - reservado >= $2
 * Nunca se ejecuta si el plan tiene faltantes, de modo que una reserva es
 * todo-o-nada.
 */
async function reservarStock(client, items) {
  for (const item of items) {
    const { rowCount } = await client.query(
      `UPDATE producto
          SET reservado = reservado + $2
        WHERE id = $1
          AND stock - reservado >= $2`,
      [item.producto_id, item.cantidad]
    );
    if (rowCount !== 1) {
      throw new Error(
        `reserva atomica fallo para producto ${item.producto_id} (filas: ${rowCount})`
      );
    }
  }
  logger.info('inventario', 'stock reservado', {
    items: items.map((i) => `${i.producto_id}x${i.cantidad}`).join(',')
  });
}

/** Libera la reserva: el stock vuelve a estar disponible. */
async function liberarReserva(client, pedidoId) {
  const { rowCount } = await client.query(
    `UPDATE producto p
        SET reservado = GREATEST(p.reservado - pi.cantidad, 0)
       FROM pedido_item pi
      WHERE pi.pedido_id = $1
        AND pi.producto_id = p.id`,
    [pedidoId]
  );
  logger.info('inventario', 'reserva liberada', { pedido_id: pedidoId, productos: rowCount });
  return rowCount;
}

/**
 * Convierte la reserva en stock real (el pago se aprobo): sale del stock fisico
 * y desaparece de lo reservado.
 */
async function confirmarReserva(client, pedidoId) {
  const { rowCount } = await client.query(
    `UPDATE producto p
        SET stock = p.stock - pi.cantidad,
            reservado = GREATEST(p.reservado - pi.cantidad, 0)
       FROM pedido_item pi
      WHERE pi.pedido_id = $1
        AND pi.producto_id = p.id
        AND p.stock >= pi.cantidad`,
    [pedidoId]
  );
  const { rows } = await client.query('SELECT COUNT(*)::int AS total FROM pedido_item WHERE pedido_id = $1', [
    pedidoId
  ]);
  if (rowCount !== rows[0].total) {
    throw new Error(`stock fisico insuficiente al confirmar el pedido ${pedidoId}`);
  }
  logger.info('inventario', 'reserva confirmada', { pedido_id: pedidoId, productos: rowCount });
  return rowCount;
}

module.exports = { planificarReserva, reservarStock, liberarReserva, confirmarReserva };