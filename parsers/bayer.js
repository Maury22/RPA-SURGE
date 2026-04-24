// ============================================================
// parsers/bayer.js — Parser específico para Bayer S.A.
// ============================================================
// CUIT: 30503811061 (30-50381106-1)
//
// Layout factura:
//   - Número:  "Factura 0200-00582397" → pv=0200, comp=00582397
//   - Fecha:   "Fecha: 22.04.2025" (separador PUNTO, no barra)
//   - CAEA:    "N°.CAEA 36151098109382" → tipoEmision='anticipada'
//   - Total:   "Total ARS 67.038.893,70"
// ============================================================

const { limpiarImporte, normalizarTexto, textoEnLinea, REGEX_GTIN } = require('./utils');

const CUIT_BAYER = '30503811061';

function detectar(textoPlano) {
    if (textoPlano.includes(CUIT_BAYER) || textoPlano.includes('30-50381106-1')) return true;
    if (/\bBAYER\s+S\.?A\.?\b/i.test(textoPlano)) return true;
    return false;
}

function extraerDatos(textoOCR) {
    const texto = normalizarTexto(textoOCR);
    const plano = textoEnLinea(texto);

    const cuit = CUIT_BAYER;

    // Número de factura: "Factura 0200-00582397"
    // El Remito también tiene formato 4-8 (0204-00761796), por eso se ancla a "Factura"
    let puntoVenta = '', numeroComprobante = '';
    const matchNro = plano.match(/(?:Factura)[^0-9]{0,15}([0-9]{4})[- ]([0-9]{8})(?![0-9])/i) ||
                     plano.match(/(?<![0-9])([0-9]{4})[- ]([0-9]{8})(?![0-9])/);
    if (matchNro) {
        puntoVenta        = matchNro[1].padStart(4, '0');
        numeroComprobante = matchNro[2];
    }

    // Fecha: "22.04.2025" — Bayer usa PUNTOS como separador (≠ Sanofi que usa barras)
    let fecha = '';
    const matchFecha = plano.match(/Fecha\s*[:\-]?\s*([0-9]{2})\.([0-9]{2})\.([0-9]{4})/i) ||
                       plano.match(/(?<![0-9])([0-9]{2})\.([0-9]{2})\.([0-9]{4})(?![0-9])/);
    if (matchFecha) fecha = `${matchFecha[1]}/${matchFecha[2]}/${matchFecha[3]}`;

    // CAE / CAEA: 14 dígitos — "N°.CAEA 36151098109382"
    let cae = '';
    const matchCae = plano.match(/CAEA?\s*[:\-\.#N°o*\s]*([0-9]{14})(?![0-9])/i) ||
                     plano.match(/C\.?A\.?E\.?A?\s*:?\s*([0-9]{14})(?![0-9])/i);
    if (matchCae) {
        cae = matchCae[1];
    } else {
        const posibles = [...plano.matchAll(/(?<![0-9])([0-9]{14})(?![0-9])/g)]
            .filter(m => !/^(30|20|27|23|24|33|34)/.test(m[1]));
        if (posibles.length > 0) cae = posibles[posibles.length - 1][1];
    }

    // Importe TOTAL: "Total ARS 67.038.893,70"
    // Fallback: último monto grande del documento
    let importeFloat = 0;
    const matchTotal = plano.match(/Total\s+ARS\s+([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2})/i);
    if (matchTotal) {
        importeFloat = parseFloat(limpiarImporte(matchTotal[1]));
    }
    if (!importeFloat) {
        const montos = [...plano.matchAll(/([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2})(?![0-9])/g)];
        for (let i = montos.length - 1; i >= 0; i--) {
            const val = parseFloat(limpiarImporte(montos[i][1]));
            if (val > 100 && val < 500000000) { importeFloat = val; break; }
        }
    }

    const importe = importeFloat ? importeFloat.toFixed(2) : '';

    return {
        cuit, cae, fecha, importe, puntoVenta, numeroComprobante,
        tipoComprobanteTexto: /mipyme/i.test(plano) ? 'mipyme' : 'facturas a',
        // Bayer emite con CAEA (Código de Autorización Electrónico Anticipado)
        tipoEmisionTexto: /CAEA|anticipada|C\.A\.E\.A/i.test(plano) ? 'anticipada' : 'electr',
    };
}

function extraerDatosAnexo(textoAnexo, importeFactura) {
    let gtin = '', serie = '', fechaPrescripcion = '', fechaDispensa = '', valorErogado = '';

    const matchGtin = textoAnexo.match(REGEX_GTIN);
    if (matchGtin) {
        gtin = matchGtin[1];
        const regexSeriePost = new RegExp(
            gtin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s|\\-.,]*([A-Za-z0-9]{5,25})'
        );
        const matchSerie = textoAnexo.match(regexSeriePost);
        if (matchSerie) serie = matchSerie[1];
    }
    if (!serie) {
        const alfanumericos = [...textoAnexo.matchAll(/\b([A-Za-z]+[0-9]+[A-Za-z0-9]*)\b/g)];
        if (alfanumericos.length > 0) serie = alfanumericos[0][1];
    }

    const regexFechas = /([0-9]{2})[\s\/\-.,|]+([0-9]{2})[\s\/\-.,|]+([0-9]{4})/g;
    const todasFechas = [...textoAnexo.matchAll(regexFechas)];
    if (todasFechas.length >= 2) {
        fechaPrescripcion = `${todasFechas[0][1]}/${todasFechas[0][2]}/${todasFechas[0][3]}`;
        fechaDispensa     = `${todasFechas[1][1]}/${todasFechas[1][2]}/${todasFechas[1][3]}`;
    } else if (todasFechas.length === 1) {
        fechaPrescripcion = `${todasFechas[0][1]}/${todasFechas[0][2]}/${todasFechas[0][3]}`;
        fechaDispensa     = fechaPrescripcion;
    }

    const matchImporte = textoAnexo.match(/\$\s*([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2}|[0-9]+[.,][0-9]{2})/);
    if (matchImporte) {
        const val = parseFloat(limpiarImporte(matchImporte[1]));
        valorErogado = val ? val.toFixed(2) : '';
    } else {
        valorErogado = importeFactura || '';
    }

    return { gtin, serie, fechaPrescripcion, fechaDispensa, valorErogado };
}

module.exports = { CUIT: CUIT_BAYER, nombre: 'Bayer', detectar, extraerDatos, extraerDatosAnexo };
