'use strict';

// Log estructurado minimo en una sola linea (compatible con `docker compose logs`).
function formatear(nivel, ambito, mensaje, extra) {
  const partes = [`[${nivel}]`, `[${ambito}]`, mensaje];
  if (extra && Object.keys(extra).length > 0) partes.push(JSON.stringify(extra));
  return partes.join(' ');
}

const emitir = (nivel) => (ambito, mensaje, extra) => {
  const linea = formatear(nivel, ambito, mensaje, extra);
  if (nivel === 'ERROR') console.error(linea);
  else console.log(linea);
};

module.exports = {
  logger: {
    info: emitir('INFO'),
    warn: emitir('WARN'),
    error: emitir('ERROR')
  }
};