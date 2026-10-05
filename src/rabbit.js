'use strict';

const amqp = require('amqplib');
const config = require('./config');
const { logger } = require('./log');

const ROUTING_KEYS = { pedidoPagado: 'PedidoPagado', pedidoDespachado: 'PedidoDespachado' };

let conexion = null;
let canal = null;
let conectado = false;
let reconectando = false;
let cerrando = false;

const url = () =>
  `amqp://${encodeURIComponent(config.rabbit.user)}:${encodeURIComponent(
    config.rabbit.password
  )}@${config.rabbit.host}:${config.rabbit.port}`;

async function crearCanal() {
  const nuevaConexion = await amqp.connect(url(), { heartbeat: 10 });
  conexion = nuevaConexion;

  conexion.on('error', (err) => logger.error('rabbit', 'error de conexion', { error: err.message }));
  conexion.on('close', () => {
    conectado = false;
    if (!cerrando) {
      logger.warn('rabbit', 'conexion cerrada, reintentando');
      programarReconexion();
    }
  });

  canal = await conexion.createConfirmChannel();
  canal.on('error', (err) => logger.error('rabbit', 'error de canal', { error: err.message }));
  canal.on('close', () => {
    conectado = false;
    if (!cerrando) programarReconexion();
  });

  await canal.assertExchange(config.rabbit.exchange, 'topic', { durable: true });
  await canal.assertQueue(config.rabbit.queue, { durable: true });
  for (const clave of Object.values(ROUTING_KEYS)) {
    await canal.bindQueue(config.rabbit.queue, config.rabbit.exchange, clave);
  }

  conectado = true;
}

/** Conecta con reintentos: el arranque no debe depender de un unico intento. */
async function conectar(intentos = 30, esperaMs = 2000) {
  for (let intento = 1; ; intento++) {
    try {
      await crearCanal();
      logger.info('rabbit', 'conectado', {
        host: config.rabbit.host,
        puerto: config.rabbit.port,
        exchange: config.rabbit.exchange,
        cola: config.rabbit.queue
      });
      return true;
    } catch (err) {
      if (intento >= intentos) {
        // Se sigue reintentando en segundo plano; /health lo refleja.
        programarReconexion();
        throw err;
      }
      logger.warn('rabbit', `conexion fallida (${intento}/${intentos}), reintentando`, {
        error: err.message
      });
      await new Promise((r) => setTimeout(r, esperaMs));
    }
  }
}

function programarReconexion() {
  if (reconectando || cerrando) return;
  reconectando = true;
  setTimeout(async () => {
    reconectando = false;
    try {
      await crearCanal();
      await iniciarConsumidor();
      logger.info('rabbit', 'reconexion completada');
    } catch (err) {
      logger.warn('rabbit', 'reconexion fallida', { error: err.message });
      programarReconexion();
    }
  }, 2000);
}

/** Publica un evento en el exchange y espera la confirmacion del broker. */
async function publicar(routingKey, cuerpo) {
  if (!canal || !conectado) throw new Error('RabbitMQ no esta conectado');
  const aceptado = canal.publish(
    config.rabbit.exchange,
    routingKey,
    Buffer.from(JSON.stringify(cuerpo)),
    { persistent: true, contentType: 'application/json' }
  );
  if (!aceptado) await new Promise((r) => canal.once('drain', r));
  await canal.waitForConfirms();
  return true;
}

/**
 * Consumidor que simula la notificacion al cliente (correo/SMS/push). Solo
 * escribe en el log: no consume el mensaje si no pudo procesarlo.
 */
async function iniciarConsumidor() {
  if (!canal || !conectado) {
    logger.warn('rabbit', 'consumidor no iniciado: sin canal abierto');
    return false;
  }

  await canal.consume(
    config.rabbit.queue,
    (msg) => {
      if (msg === null) return;
      let evento;
      try {
        evento = JSON.parse(msg.content.toString('utf8'));
      } catch (err) {
        logger.error('notificaciones', 'mensaje ilegible, descartado', { error: err.message });
        canal.nack(msg, false, false);
        return;
      }

      try {
        logger.info('notificaciones', simularNotificacion(evento), evento);
        canal.ack(msg);
      } catch (err) {
        logger.error('notificaciones', 'fallo al notificar, mensaje descartado', {
          pedido_id: evento.pedido_id,
          error: err.message
        });
        canal.nack(msg, false, false);
      }
    },
    { noAck: false }
  );
}

function simularNotificacion(evento) {
  switch (evento.tipo) {
    case ROUTING_KEYS.pedidoPagado:
      return `Enviando confirmacion de pago a ${evento.cliente} por el pedido ${evento.pedido_id} (${evento.total})`;
    case ROUTING_KEYS.pedidoDespachado:
      return `Enviando aviso de envio a ${evento.cliente} por el pedido ${evento.pedido_id}`;
    default:
      return `Evento ${evento.tipo} del pedido ${evento.pedido_id}`;
  }
}

const estado = () => ({
  conectado,
  exchange: config.rabbit.exchange,
  cola: config.rabbit.queue,
  eventos: Object.values(ROUTING_KEYS)
});

async function cerrar() {
  cerrando = true;
  try {
    if (canal) await canal.close();
  } catch { /* canal ya cerrado */ }
  try {
    if (conexion) await conexion.close();
  } catch { /* conexion ya cerrada */ }
  conectado = false;
}

module.exports = { conectar, publicar, iniciarConsumidor, estado, cerrar, ROUTING_KEYS };