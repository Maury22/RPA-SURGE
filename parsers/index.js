// ============================================================
// parsers/index.js — Dispatcher: detecta proveedor y ejecuta el parser correcto
// ============================================================
//
// USO:
//   const { detectarProveedor, extraerDatos, extraerDatosAnexo } = require('./parsers');
//   const proveedor = detectarProveedor(textoOCR);
//   const datos = extraerDatos(proveedor, textoOCR);
//   const datosAnexo = extraerDatosAnexo(proveedor, textoAnexoOCR, datos.importe);
//
// AGREGAR UN PROVEEDOR NUEVO:
//   1. Crear parsers/nombre_proveedor.js con: detectar(), extraerDatos(), extraerDatosAnexo()
//   2. Agregarlo al array PARSERS de abajo
//   Listo. El dispatcher lo detecta automáticamente.
// ============================================================

const { parsearAnexo } = require('./utils');
const montpellier = require('./montpellier');
const sanofi      = require('./sanofi');
const bayer       = require('./bayer');
const merck       = require('./merck');
const pfizer      = require('./pfizer');
const globalfarm  = require('./globalfarm');
const farmanet    = require('./farmanet');
const abbvie      = require('./abbvie');
const medifarm    = require('./medifarm');
const roche       = require('./roche');
const biogen      = require('./biogen');
const monteverde  = require('./monteverde');
const orien       = require('./orien');
const rofina      = require('./rofina');
const takeda      = require('./takeda');
const varifarma   = require('./varifarma');
const tuteur      = require('./tuteur');
const generico    = require('./generico');

// Lista ordenada de parsers específicos (se chequean en orden).
// IMPORTANTE: merck, pfizer, globalfarm, farmanet y abbvie van ANTES de medifarm
// porque sus facturas incluyen "MEDIFARM" o "SCIENZA" como dirección de entrega,
// lo cual dispararía falsos positivos en medifarm.detectar() si se revisara
// antes. El CUIT del emisor los identifica correctamente.
const PARSERS = [
    montpellier, sanofi, bayer, merck, pfizer, globalfarm, farmanet, abbvie, medifarm, roche, biogen, monteverde,
    orien, rofina, takeda, varifarma, tuteur,
];

/**
 * Detecta qué proveedor es en base al texto OCR.
 * Devuelve el módulo parser correspondiente, o el genérico si no matchea ninguno.
 */
function detectarProveedor(textoOCR) {
    const textoPlano = textoOCR.replace(/\r|\n/g, ' ').replace(/\s+/g, ' ');

    for (const parser of PARSERS) {
        if (parser.detectar(textoPlano)) {
            return parser;
        }
    }
    return generico;
}

/**
 * Extrae datos de la factura usando el parser correspondiente.
 * @param {object|null} parser - Parser detectado (si es null, detecta automáticamente)
 * @param {string} textoOCR - Texto OCR completo de la(s) página(s) de la factura
 */
function extraerDatos(parser, textoOCR) {
    if (!parser) parser = detectarProveedor(textoOCR);
    return parser.extraerDatos(textoOCR);
}

/**
 * Extrae datos del anexo/trazabilidad usando el parser correspondiente.
 * @param {object|null} parser - Parser detectado
 * @param {string} textoAnexo - Texto OCR del anexo
 * @param {string} importeFactura - Importe de la factura (fallback para valor erogado)
 */
function extraerDatosAnexo(parser, textoAnexo, importeFactura) {
    if (!parser) parser = generico;
    // Orien tiene un formato de anexo completamente distinto (campos etiquetados),
    // los demás usan la tabla estándar GTIN / Nro de Serie / REMITO.
    if (parser === orien) {
        return orien.extraerDatosAnexo(textoAnexo, importeFactura);
    }
    return parsearAnexo(textoAnexo, importeFactura);
}

module.exports = {
    detectarProveedor,
    extraerDatos,
    extraerDatosAnexo,
    // Exportar parsers individuales por si se necesitan directo
    parsers: { montpellier, generico },
};
