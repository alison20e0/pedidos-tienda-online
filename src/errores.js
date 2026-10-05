'use strict';

// Error de negocio: se traduce a una respuesta HTTP con código estable.
class ErrorDeNegocio extends Error {
  constructor(estadoHttp, codigo, mensaje, detalle) {
    super(mensaje);
    this.name = 'ErrorDeNegocio';
    this.estadoHttp = estadoHttp;
    this.codigo = codigo;
    this.detalle = detalle;
  }
}

const noEncontrado = (mensaje) => new ErrorDeNegocio(404, 'NO_ENCONTRADO', mensaje);
const peticionInvalida = (codigo, mensaje, detalle) =>
  new ErrorDeNegocio(400, codigo, mensaje, detalle);
const conflicto = (codigo, mensaje, detalle) => new ErrorDeNegocio(409, codigo, mensaje, detalle);

module.exports = { ErrorDeNegocio, noEncontrado, peticionInvalida, conflicto };