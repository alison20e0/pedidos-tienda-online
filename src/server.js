'use strict';

const app = require('./app');
const db = require('./db');
const rabbit = require('./rabbit');
const config = require('./config');
const pedidos = require('./pedidos');
const { logger } = require('./log');

let servidor;
let barrido;

async function arrancar() {
  logger.info('api', 'arrancando', { env: config.nodeEnv, port: config.port });

  await db.aplicarEsquema();
  await db.comprobarConexion();
  logger.info('db', 'conexion lista', {
    host: config.db.host,
    puerto: config.db.port,
    base: config.db.name
  });

  // Si RabbitMQ aun no responde, la API arranca igual y la reconexion sigue en
  // segundo plano; /health lo refleja.
  await rabbit.conectar().catch((err) => logger.warn('rabbit', 'arranque sin bus de eventos', { error: err.message }));
  await rabbit.iniciarConsumidor().catch((err) => logger.warn('rabbit', 'consumidor no iniciado', { error: err.message }));

  servidor = app.listen(config.port, () => {
    logger.info('api', `escuchando en http://0.0.0.0:${config.port} (interfaz web en /)`);
  });

  barrido = setInterval(() => {
    pedidos.liberarReservasVencidas().catch((err) =>
      logger.error('reservas', 'fallo el barrido de reservas', { error: err.message })
    );
  }, config.barridoReservasMs);
  barrido.unref();

  // Al arrancar, ejecuta un barrido por si quedo alguna reserva vencida.
  pedidos.liberarReservasVencidas().catch((err) =>
    logger.error('reservas', 'fallo el barrido inicial', { error: err.message })
  );
}

async function apagar(senal) {
  logger.info('api', `senal ${senal} recibida, apagando`);
  clearInterval(barrido);
  await new Promise((r) => (servidor ? servidor.close(r) : r()));
  await rabbit.cerrar();
  await db.cerrar();
  process.exit(0);
}

process.on('SIGTERM', () => apagar('SIGTERM'));
process.on('SIGINT', () => apagar('SIGINT'));
process.on('unhandledRejection', (motivo) => {
  logger.error('api', 'rechazo de promesa no gestionado', { motivo: String(motivo) });
});

arrancar().catch((err) => {
  logger.error('api', 'fallo al arrancar', { error: err.message, stack: err.stack });
  process.exit(1);
});