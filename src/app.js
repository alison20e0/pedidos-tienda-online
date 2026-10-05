'use strict';

const path = require('path');
const express = require('express');

const db = require('./db');
const rabbit = require('./rabbit');
const pedidos = require('./pedidos');
const { logger } = require('./log');
const { ErrorDeNegocio } = require('./errores');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// Express 4 no captura rechazos de promesas: cada ruta se envuelve a mano.
const ruta = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const pedidoId = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ErrorDeNegocio(400, 'PEDIDO_ID_INVALIDO', 'El id del pedido debe ser un entero positivo');
  }
  return id;
};

// ------------------------------------------------------------------- rutas

app.get(
  '/health',
  ruta(async (req, res) => {
    const postgres = await db
      .comprobarConexion()
      .then((ahora) => ({ conectado: true, ahora }))
      .catch((err) => ({ conectado: false, error: err.message }));

    const rabbitmq = rabbit.estado();
    const sano = postgres.conectado && rabbitmq.conectado;

    res.status(sano ? 200 : 503).json({
      estado: sano ? 'ok' : 'degradado',
      postgres,
      rabbitmq
    });
  })
);

app.post(
  '/pedidos',
  ruta(async (req, res) => {
    const { cliente, items } = req.body || {};
    const resultado = await pedidos.crearPedido({
      idempotencyKey: req.get('Idempotency-Key'),
      cliente,
      items
    });

    if (resultado.repetido) {
      return res.status(200).json({
        repetido: true,
        mensaje: 'Idempotency-Key ya utilizada: se devuelve el pedido original',
        pedido: resultado.pedido
      });
    }
    return res.status(201).json({ repetido: false, pedido: resultado.pedido });
  })
);

app.get(
  '/pedidos/:id',
  ruta(async (req, res) => {
    res.json({ pedido: await pedidos.obtenerPedido(pedidoId(req)) });
  })
);

app.get(
  '/pedidos/:id/estado',
  ruta(async (req, res) => {
    res.json(await pedidos.obtenerEstado(pedidoId(req)));
  })
);

app.post(
  '/pedidos/:id/preparar',
  ruta(async (req, res) => {
    res.json({ pedido: await pedidos.prepararPedido(pedidoId(req)) });
  })
);

app.post(
  '/pedidos/:id/despachar',
  ruta(async (req, res) => {
    res.json({ pedido: await pedidos.despacharPedido(pedidoId(req)) });
  })
);

app.post(
  '/webhooks/pago',
  ruta(async (req, res) => {
    const { referencia, pedido_id, estado, monto, motivo } = req.body || {};
    const resultado = await pedidos.registrarPago({
      referencia,
      pedidoId: pedido_id,
      estado,
      monto,
      motivo
    });

    res.status(resultado.repetido ? 200 : 202).json({
      repetido: resultado.repetido,
      aviso: resultado.enRevision
        ? 'Pago anulado: la reserva vencio y no pudo renovarse. El pedido quedo EN_REVISION y requiere devolucion manual.'
        : undefined,
      pago: resultado.pago,
      pedido: resultado.pedido
    });
  })
);

// Interfaz web minima.
app.use(express.static(path.join(__dirname, '..', 'public')));

// ------------------------------------------------------ errores y 404

app.use((req, res) => {
  res.status(404).json({
    error: { codigo: 'RUTA_NO_ENCONTRADA', mensaje: `No existe ${req.method} ${req.path}` }
  });
});

app.use((err, req, res, next) => {
  if (err instanceof ErrorDeNegocio) {
    return res.status(err.estadoHttp).json({
      error: { codigo: err.codigo, mensaje: err.message, detalle: err.detalle ?? null }
    });
  }
  if (err.type === 'entity.parse.failed') {
    return res
      .status(400)
      .json({ error: { codigo: 'JSON_INVALIDO', mensaje: 'El cuerpo de la peticion no es JSON valido' } });
  }

  logger.error('http', `error no controlado en ${req.method} ${req.path}`, {
    error: err.message,
    stack: err.stack
  });
  return res
    .status(500)
    .json({ error: { codigo: 'ERROR_INTERNO', mensaje: 'Error interno', detalle: err.message } });
});

module.exports = app;