'use strict';

const fs = require('fs/promises');
const path = require('path');
const { Pool } = require('pg');
const config = require('./config');
const { logger } = require('./log');

const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.name,
  user: config.db.user,
  password: config.db.password,
  max: config.db.max,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
  logger.error('pg', 'error inesperado en el pool', { error: err.message });
});

const query = (texto, valores) => pool.query(texto, valores);

/** Ejecuta `fn` dentro de una transacción; revierte si lanza. */
async function transaccion(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resultado = await fn(client);
    await client.query('COMMIT');
    return resultado;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function comprobarConexion() {
  const { rows } = await pool.query('SELECT now() AS ahora');
  return rows[0].ahora;
}

/**
 * Aplica los scripts de scripts/sql en orden. Es idempotente (IF NOT EXISTS /
 * ON CONFLICT), así que puede ejecutarse aunque PostgreSQL ya los aplico al
 * inicializar su volumen.
 */
async function aplicarEsquema(intentos = 3) {
  const directorio = path.resolve(__dirname, '..', config.directorioSql);
  const archivos = (await fs.readdir(directorio))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const archivo of archivos) {
    const sql = await fs.readFile(path.join(directorio, archivo), 'utf8');
    for (let intento = 1; ; intento++) {
      try {
        await query(sql);
        logger.info('db', `script aplicado: ${archivo}`);
        break;
      } catch (err) {
        if (intento >= intentos) throw err;
        logger.warn('db', `reintentando ${archivo} (${intento}/${intentos})`, {
          error: err.message
        });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

const cerrar = () => pool.end();

module.exports = { pool, query, transaccion, comprobarConexion, aplicarEsquema, cerrar };