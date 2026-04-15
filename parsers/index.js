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

const montpellier = require('./montpellier');
const merck       = require('./merck');
const pfizer      = require('./pfizer');
const globalfarm  = require('./globalfarm');
const farmanet    = require('./farmanet');
const medifarm    = require('./medifarm');
const roche       = require('./roche');
const biogen      = require('./biogen');
const monteverde  = require('./monteverde');
const orien       = require('./orien');
const rofina      = require('./rofina');
const takeda      = require('./takeda');
const varifarma   = require('./varifarma');
const generico    = require('./generico');

// Lista ordenada de parsers específicos (se chequean en orden).
// IMPORTANTE: merck, pfizer, globalfarm y farmanet van ANTES de medifarm porque
// sus facturas incluyen "MEDIFARM" o "SCIENZA" como dirección de entrega, lo
// cual dispararía falsos positivos en medifarm.detectar() si se revisara
// antes. El CUIT del emisor los identifica correctamente.
const PARSERS = [
    montpellier, merck, pfizer, globalfarm, farmanet, medifarm, roche, biogen, monteverde, orien,
    rofina, takeda, varifarma,
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
    if (parser.extraerDatosAnexo) {
        return parser.extraerDatosAnexo(textoAnexo, importeFactura);
    }
    // Si el parser específico no tiene extraerDatosAnexo, usar el genérico
    return generico.extraerDatosAnexo(textoAnexo, importeFactura);
}

module.exports = {
    detectarProveedor,
    extraerDatos,
    extraerDatosAnexo,
    // Exportar parsers individuales por si se necesitan directo
    parsers: { montpellier, generico },
};
