'use strict';

const db = require('./db');
const inventario = require('./inventario');
const { registrarEvento, publicarEvento } = require('./eventos');
const config = require('./config');
const { logger } = require('./log');
const { peticionInvalida, conflicto, noEncontrado } = require('./errores');

const numero = (v) => (v === null || v === undefined ? null : Number(v));
const MS_POR_MINUTO = 60 * 1000;

// ---------------------------------------------------------------- validacion

function validarItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw peticionInvalida('ITENS_REQUERIDOS', 'Se espera items: [{ producto_id, cantidad }]');
  }

  const consolidado = new Map();
  for (const item of items) {
    const productoId = Number(item?.producto_id);
    const cantidad = Number(item?.cantidad);
    if (!Number.isInteger(productoId) || productoId <= 0) {
      throw peticionInvalida('PRODUCTO_ID_INVALIDO', 'producto_id debe ser un entero positivo', item);
    }
    if (!Number.isInteger(cantidad) || cantidad <= 0) {
      throw peticionInvalida('CANTIDAD_INVALIDA', 'cantidad debe ser un entero positivo', item);
    }
    consolidado.set(productoId, (consolidado.get(productoId) || 0) + cantidad);
  }

  return [...consolidado].map(([producto_id, cantidad]) => ({ producto_id, cantidad }));
}

// ------------------------------------------------------------------- lecturas

async function leerPedido(client, pedidoId) {
  const { rows: pedidos } = await client.query('SELECT * FROM pedido WHERE id = $1', [pedidoId]);
  if (pedidos.length === 0) throw noEncontrado(`El pedido ${pedidoId} no existe`);

  const { rows: items } = await client.query(
    `SELECT pi.producto_id, p.sku, p.nombre, pi.cantidad, pi.precio_unitario, pi.subtotal
       FROM pedido_item pi
       JOIN producto p ON p.id = pi.producto_id
      WHERE pi.pedido_id = $1
      ORDER BY pi.id`,
    [pedidoId]
  );

  const pedido = pedidos[0];
  return {
    id: pedido.id,
    idempotency_key: pedido.idempotency_key,
    cliente: pedido.cliente,
    estado: pedido.estado,
    total: numero(pedido.total),
    reserva_expira_en: pedido.reserva_expira_en,
    creado_en: pedido.creado_en,
    actualizado_en: pedido.actualizado_en,
    items: items.map((i) => ({
      producto_id: i.producto_id,
      sku: i.sku,
      nombre: i.nombre,
      cantidad: i.cantidad,
      precio_unitario: numero(i.precio_unitario),
      subtotal: numero(i.subtotal)
    }))
  };
}

async function obtenerPedido(pedidoId) {
  return leerPedido(db.pool, pedidoId);
}

async function obtenerEstado(pedidoId) {
  const pedido = await leerPedido(db.pool, pedidoId);

  const { rows: eventos } = await db.query(
    `SELECT tipo, estado_anterior, estado_nuevo, detalle, publicable, publicado_en, creado_en
       FROM evento_pedido
      WHERE pedido_id = $1
      ORDER BY id`,
    [pedidoId]
  );

  const { rows: pagos } = await db.query(
    `SELECT referencia, estado, monto, motivo, recibido_en
       FROM pago
      WHERE pedido_id = $1
      ORDER BY id`,
    [pedidoId]
  );

  return {
    pedido_id: pedido.id,
    estado: pedido.estado,
    reserva_expira_en: pedido.reserva_expira_en,
    reserva_vigente:
      pedido.estado === 'RESERVADO' &&
      pedido.reserva_expira_en !== null &&
      new Date(pedido.reserva_expira_en).getTime() > Date.now(),
    total: pedido.total,
    pagos: pagos.map((p) => ({
      referencia: p.referencia,
      estado: p.estado,
      monto: numero(p.monto),
      motivo: p.motivo,
      recibido_en: p.recibido_en
    })),
    historial: eventos.map((e) => ({
      tipo: e.tipo,
      de: e.estado_anterior,
      a: e.estado_nuevo,
      detalle: e.detalle,
      publicado_en: e.publicado_en,
      creado_en: e.creado_en
    }))
  };
}

const mapaPago = (p) => ({
  referencia: p.referencia,
  estado: p.estado,
  monto: numero(p.monto),
  motivo: p.motivo,
  recibido_en: p.recibido_en
});

async function actualizarEstado(client, pedidoId, nuevoEstado) {
  await client.query(
    `UPDATE pedido SET estado = $2, actualizado_en = now() WHERE id = $1`,
    [pedidoId, nuevoEstado]
  );
}

// ---------------------------------------------------------------- creacion

async function crearPedido({ idempotencyKey, cliente, items }) {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    throw peticionInvalida(
      'IDEMPOTENCY_KEY_REQUERIDA',
      'Falta el encabezado Idempotency-Key (obligatorio)'
    );
  }
  if (typeof cliente !== 'string' || cliente.trim() === '') {
    throw peticionInvalida('CLIENTE_REQUERIDO', 'Falta el campo cliente');
  }

  const itemsNormalizados = validarItems(items);
  const ttlMs = config.reservaTtlMinutos * MS_POR_MINUTO;

  const resultado = await db.transaccion(async (client) => {
    // Idempotencia: la misma clave devuelve siempre el mismo pedido.
    const { rows: repetidos } = await client.query('SELECT id FROM pedido WHERE idempotency_key = $1', [
      idempotencyKey
    ]);
    if (repetidos.length > 0) {
      return { pedido: await leerPedido(client, repetidos[0].id), repetido: true, evento: null };
    }

    const plan = await inventario.planificarReserva(client, itemsNormalizados);
    const inexistentes = plan.faltantes.filter((f) => f.motivo === 'PRODUCTO_NO_EXISTENTE');
    if (inexistentes.length > 0) {
      throw peticionInvalida('PRODUCTO_NO_EXISTE', 'Algun producto del pedido no existe', inexistentes);
    }

    const total = plan.productos.reduce((acc, producto) => {
      const item = itemsNormalizados.find((i) => i.producto_id === producto.id);
      return acc + Number(producto.precio) * item.cantidad;
    }, 0);

    let pedidoId;
    try {
      const { rows } = await client.query(
        `INSERT INTO pedido (idempotency_key, cliente, estado, total)
         VALUES ($1, $2, 'CONFIRMADO', $3)
         RETURNING id`,
        [idempotencyKey.trim(), cliente.trim(), total.toFixed(2)]
      );
      pedidoId = rows[0].id;
    } catch (err) {
      // Dos peticiones simultaneas con la misma clave: la primera gano el INSERT.
      if (err.code === '23505') {
        const { rows: ganador } = await client.query(
          'SELECT id FROM pedido WHERE idempotency_key = $1',
          [idempotencyKey]
        );
        return { pedido: await leerPedido(client, ganador[0].id), repetido: true, evento: null };
      }
      throw err;
    }

    for (const producto of plan.productos) {
      const item = itemsNormalizados.find((i) => i.producto_id === producto.id);
      await client.query(
        `INSERT INTO pedido_item (pedido_id, producto_id, cantidad, precio_unitario)
         VALUES ($1, $2, $3, $4)`,
        [pedidoId, producto.id, item.cantidad, producto.precio]
      );
    }

    await registrarEvento(client, {
      pedidoId,
      tipo: 'PEDIDO_CREADO',
      estadoAnterior: null,
      estadoNuevo: 'CONFIRMADO',
      detalle: `Ventana de pago: ${config.reservaTtlMinutos} minutos`
    });

    if (plan.faltantes.length > 0) {
      const detalle = plan.faltantes
        .map(
          (f) =>
            `producto ${f.producto_id} (${f.nombre}): pide ${f.cantidad_pedida}, libre ${f.cantidad_libre}`
        )
        .join('; ');
      await actualizarEstado(client, pedidoId, 'CANCELADO');
      const evento = await registrarEvento(client, {
        pedidoId,
        tipo: 'RESERVA_RECHAZADA',
        estadoAnterior: 'CONFIRMADO',
        estadoNuevo: 'CANCELADO',
        detalle: `Stock insuficiente: ${detalle}`
      });
      return { pedido: await leerPedido(client, pedidoId), repetido: false, evento };
    }

    // Reserva atomica: CONFIRMADO -> RESERVADO con vencimiento.
    await inventario.reservarStock(client, itemsNormalizados);
    await client.query(
      `UPDATE pedido
          SET reserva_expira_en = now() + ($2 * interval '1 millisecond')
        WHERE id = $1`,
      [pedidoId, ttlMs]
    );
    await actualizarEstado(client, pedidoId, 'RESERVADO');
    const evento = await registrarEvento(client, {
      pedidoId,
      tipo: 'PEDIDO_RESERVADO',
      estadoAnterior: 'CONFIRMADO',
      estadoNuevo: 'RESERVADO',
      detalle: `Stock reservado hasta ${new Date(Date.now() + ttlMs).toISOString()}`
    });

    return { pedido: await leerPedido(client, pedidoId), repetido: false, evento };
  });

  await publicarEvento(resultado.evento, resultado.pedido);
  return resultado;
}

// ------------------------------------------------------------ pago (webhook)

async function registrarPago({ referencia, pedidoId, estado, monto, motivo }) {
  if (typeof referencia !== 'string' || referencia.trim() === '') {
    throw peticionInvalida('REFERENCIA_REQUERIDA', 'Falta la referencia del pago');
  }
  if (!['aprobado', 'rechazado'].includes(estado)) {
    throw peticionInvalida('ESTADO_PAGO_INVALIDO', "estado debe ser 'aprobado' o 'rechazado'", estado);
  }
  const idPedido = Number(pedidoId);
  if (!Number.isInteger(idPedido) || idPedido <= 0) {
    throw peticionInvalida('PEDIDO_ID_INVALIDO', 'pedido_id debe ser un entero positivo');
  }

  // Idempotencia por referencia: la misma notificacion devuelve el mismo resultado.
  const { rows: yaRegistrados } = await db.query(
    'SELECT referencia, pedido_id, estado, monto, motivo, recibido_en FROM pago WHERE referencia = $1',
    [referencia]
  );
  if (yaRegistrados.length > 0) {
    return {
      repetido: true,
      pago: mapaPago(yaRegistrados[0]),
      pedido: await obtenerPedido(yaRegistrados[0].pedido_id)
    };
  }

  const resultado = await db.transaccion(async (client) => {
    const { rows: filas } = await client.query('SELECT * FROM pedido WHERE id = $1 FOR UPDATE', [
      idPedido
    ]);
    if (filas.length === 0) throw noEncontrado(`El pedido ${idPedido} no existe`);

    const pedido = filas[0];
    const estadoActual = pedido.estado;

    if (estadoActual === 'EN_REVISION') {
      throw conflicto(
        'PEDIDO_EN_REVISION',
        `El pedido ${idPedido} esta en EN_REVISION y requiere intervencion manual antes de cobrarlo`
      );
    }

    const totalPago = Number.isFinite(Number(monto)) ? Number(monto) : Number(pedido.total);

    if (estado === 'rechazado') {
      if (['PAGADO', 'EN_PREPARACION', 'DESPACHADO'].includes(estadoActual)) {
        throw conflicto(
          'PAGO_NO_APLICABLE',
          `El pedido ${idPedido} esta en ${estadoActual}: ya fue cobrado y no admite un rechazo`
        );
      }

      const pago = await insertarPago(client, {
        pedidoId,
        referencia,
        estado: 'RECHAZADO',
        monto: totalPago,
        motivo
      });

      if (estadoActual === 'RESERVADO' || estadoActual === 'CONFIRMADO') {
        await inventario.liberarReserva(client, idPedido);
        await client.query('UPDATE pedido SET reserva_expira_en = NULL WHERE id = $1', [idPedido]);
      }
      await actualizarEstado(client, idPedido, 'CANCELADO');
      const evento = await registrarEvento(client, {
        pedidoId,
        tipo: 'PAGO_RECHAZADO',
        estadoAnterior: estadoActual,
        estadoNuevo: 'CANCELADO',
        detalle: `Pago rechazado (referencia ${referencia.trim()}); reserva liberada`
      });
      return { pedidoId, pago, evento };
    }

    // --- pago aprobado -----------------------------------------------------
    const reservaVigente =
      estadoActual === 'RESERVADO' &&
      pedido.reserva_expira_en !== null &&
      new Date(pedido.reserva_expira_en).getTime() > Date.now();

    let renovo = false;
    if (!reservaVigente) {
      // La reserva no esta vigente (vencio o el pedido estaba cancelado): hay que
      // renovarla antes de poder cobrar.
      const { rows: items } = await client.query(
        'SELECT producto_id, cantidad FROM pedido_item WHERE pedido_id = $1 ORDER BY producto_id',
        [idPedido]
      );
      const plan = await inventario.planificarReserva(client, items);

      if (plan.faltantes.length > 0) {
        // REGLA CRITICA: el pago se anula y el pedido pasa a EN_REVISION.
        const detalle = plan.faltantes
          .map(
            (f) =>
              `producto ${f.producto_id} (${f.nombre}): libre ${f.cantidad_libre} de ${f.cantidad_pedida}`
          )
          .join('; ');
        await client.query(
          `INSERT INTO pago (referencia, pedido_id, estado, monto, motivo)
           VALUES ($1, $2, 'ANULADO', $3, $4)`,
          [
            referencia.trim(),
            idPedido,
            totalPago.toFixed(2),
            `Reserva ${estadoActual === 'RESERVADO' ? 'vencida' : 'no vigente'} y sin renovacion posible`
          ]
        );
        await actualizarEstado(client, idPedido, 'EN_REVISION');
        const evento = await registrarEvento(client, {
          pedidoId,
          tipo: 'PAGO_ANULADO',
          estadoAnterior: estadoActual,
          estadoNuevo: 'EN_REVISION',
          detalle:
            `Pago ${referencia.trim()} aprobado, pero la reserva vencio y no se pudo renovar ` +
            `(${detalle}). Requiere devolucion manual.`
        });
        const { rows: pagos } = await client.query(
          'SELECT referencia, estado, monto, motivo, recibido_en FROM pago WHERE referencia = $1',
          [referencia]
        );
        return { pedidoId, pago: pagos[0], evento, enRevision: true };
      }

      await inventario.reservarStock(client, items);
      renovo = true;
    }

    await inventario.confirmarReserva(client, idPedido);
    await client.query('UPDATE pedido SET reserva_expira_en = NULL WHERE id = $1', [idPedido]);
    await actualizarEstado(client, idPedido, 'PAGADO');
    const pago = await insertarPago(client, {
      pedidoId,
      referencia,
      estado: 'APROBADO',
      monto: totalPago,
      motivo
    });
    const evento = await registrarEvento(client, {
      pedidoId,
      tipo: 'PEDIDO_PAGADO',
      estadoAnterior: estadoActual,
      estadoNuevo: 'PAGADO',
      detalle: `Pago aprobado (referencia ${referencia.trim()})${
        renovo ? ' tras renovar la reserva vencida' : ''
      }`
    });
    return { pedidoId, pago, evento };
  });

  const pedido = await obtenerPedido(resultado.pedidoId);
  await publicarEvento(resultado.evento, pedido);
  return {
    repetido: false,
    pedido,
    pago: mapaPago(resultado.pago),
    enRevision: resultado.enRevision === true
  };
}

async function insertarPago(client, { pedidoId, referencia, estado, monto, motivo }) {
  const { rows } = await client.query(
    `INSERT INTO pago (referencia, pedido_id, estado, monto, motivo)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING referencia, estado, monto, motivo, recibido_en`,
    [referencia.trim(), pedidoId, estado, Number(monto).toFixed(2), motivo ?? null]
  );
  return rows[0];
}

// ------------------------------------------------------- preparar / despachar

async function prepararPedido(pedidoId) {
  return transicionar(pedidoId, 'PAGADO', 'EN_PREPARACION', 'PEDIDO_EN_PREPARACION');
}

async function despacharPedido(pedidoId) {
  return transicionar(pedidoId, 'EN_PREPARACION', 'DESPACHADO', 'PEDIDO_DESPACHADO');
}

async function transicionar(pedidoId, estadoEsperado, estadoNuevo, tipo) {
  const evento = await db.transaccion(async (client) => {
    const { rows } = await client.query('SELECT * FROM pedido WHERE id = $1 FOR UPDATE', [
      pedidoId
    ]);
    if (rows.length === 0) throw noEncontrado(`El pedido ${pedidoId} no existe`);

    const pedido = rows[0];
    if (pedido.estado !== estadoEsperado) {
      throw conflicto(
        'TRANSICION_INVALIDA',
        `El pedido ${pedidoId} esta en ${pedido.estado}: solo se permite ${estadoEsperado} -> ${estadoNuevo}`,
        { estado_actual: pedido.estado, estado_requerido: estadoEsperado }
      );
    }

    await actualizarEstado(client, pedidoId, estadoNuevo);
    return registrarEvento(client, {
      pedidoId,
      tipo,
      estadoAnterior: estadoEsperado,
      estadoNuevo
    });
  });

  const pedido = await obtenerPedido(pedidoId);
  await publicarEvento(evento, pedido);
  return pedido;
}

// ------------------------------------------------- barrido de reservas vencidas

/**
 * Libera las reservas cuyo plazo vencio sin pago: el pedido queda CANCELADO y el
 * stock vuelve a estar disponible.
 */
async function liberarReservasVencidas() {
  const expirados = await db.transaccion(async (client) => {
    const { rows } = await client.query(
      `SELECT id FROM pedido
        WHERE estado = 'RESERVADO'
          AND reserva_expira_en IS NOT NULL
          AND reserva_expira_en <= now()
        ORDER BY id
        FOR UPDATE SKIP LOCKED`
    );

    for (const pedido of rows) {
      await inventario.liberarReserva(client, pedido.id);
      await client.query('UPDATE pedido SET reserva_expira_en = NULL WHERE id = $1', [pedido.id]);
      await actualizarEstado(client, pedido.id, 'CANCELADO');
      await registrarEvento(client, {
        pedidoId: pedido.id,
        tipo: 'RESERVA_EXPIRADA',
        estadoAnterior: 'RESERVADO',
        estadoNuevo: 'CANCELADO',
        detalle: `Vencio la reserva de ${config.reservaTtlMinutos} minutos sin pago; stock liberado`
      });
    }
    return rows.map((r) => r.id);
  });

  if (expirados.length > 0) {
    logger.info('reservas', 'reservas vencidas liberadas', { pedidos: expirados });
  }
  return expirados;
}

module.exports = {
  crearPedido,
  registrarPago,
  prepararPedido,
  despacharPedido,
  obtenerPedido,
  obtenerEstado,
  liberarReservasVencidas
};