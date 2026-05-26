// ============================================================
// parsers/rosfar.js - Parser para Drogueria ROSFAR
// ============================================================
// CUIT: 30698255141 (30-69825514-1)
//
// Layout factura:
//   - "FACTURA N° 0007-01522864"
//   - "Fecha: 18/08/2025"
//   - "CAE: 75331743070050"
//   - "TOTAL 3.764.706,23"
//
// Layout anexo:
//   - DETALLE DE LA FACTURA: DROGUERIA ROSFAR
//   - Cod. Trazabilidad = GTIN(14) + serie
// ============================================================

const { limpiarImporte, normalizarTexto, textoEnLinea, REGEX_GTIN } = require('./utils');

const CUIT_ROSFAR = '30698255141';

function detectar(textoPlano) {
    if (textoPlano.includes(CUIT_ROSFAR) || textoPlano.includes('30-69825514-1')) return true;
    return /\bROS\s*FAR\b|\bROSFAR\b|DROGUERIA\s+ROSFAR/i.test(textoPlano);
}

function montoToFixed(valor) {
    const n = parseFloat(limpiarImporte(valor));
    return Number.isFinite(n) && n > 0 ? n.toFixed(2) : '';
}

function extraerDatos(textoOCR) {
    const texto = normalizarTexto(textoOCR);
    const plano = textoEnLinea(texto);

    const cuit = CUIT_ROSFAR;

    let puntoVenta = '', numeroComprobante = '';
    const matchNro =
        plano.match(/FACTURA\s*N[°oº*]?\s*0*([0-9]{4,5})\s*[-–—]\s*0*([0-9]{7,8})(?![0-9])/i) ||
        plano.match(/(?<![0-9])0*([0-9]{4,5})\s*[-–—]\s*0*([0-9]{7,8})(?![0-9])/);
    if (matchNro) {
        puntoVenta = matchNro[1].padStart(4, '0');
        numeroComprobante = matchNro[2].padStart(8, '0');
    }

    let fecha = '';
    const matchFecha =
        plano.match(/Fecha\s*:?\s*([0-9]{2})[\/\-]([0-9]{2})[\/\-]([0-9]{4})/i) ||
        plano.match(/(?<![0-9])([0-9]{2})[\/\-]([0-9]{2})[\/\-]([0-9]{4})(?![0-9])/);
    if (matchFecha) fecha = `${matchFecha[1]}/${matchFecha[2]}/${matchFecha[3]}`;

    let cae = '';
    const matchCAE = plano.match(/C\.?A\.?E\.?\s*:?\s*([0-9]{14})(?![0-9])/i);
    if (matchCAE) {
        cae = matchCAE[1];
    } else {
        const posibles = [...plano.matchAll(/(?<![0-9])([0-9]{14})(?![0-9])/g)]
            .filter(m => !/^0/.test(m[1]) && m[1] !== '30654855168');
        if (posibles.length > 0) cae = posibles[posibles.length - 1][1];
    }

    let importe = '';
    const matchTotal = [...plano.matchAll(/\bTOTAL\b[^0-9]{0,40}([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2})/gi)];
    if (matchTotal.length > 0) importe = montoToFixed(matchTotal[matchTotal.length - 1][1]);

    if (!importe) {
        const subtotal = plano.match(/\bSubtotal\b[^0-9]{0,40}([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2})/i);
        const percep = plano.match(/\bPerc\.?\s*IB\b[^0-9]{0,40}([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2})/i);
        const s = subtotal ? parseFloat(limpiarImporte(subtotal[1])) : 0;
        const p = percep ? parseFloat(limpiarImporte(percep[1])) : 0;
        if (s > 0 && p > 0) importe = (s + p).toFixed(2);
    }

    if (!importe) {
        let maxMonto = 0;
        for (const m of plano.matchAll(/([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2})(?![0-9])/g)) {
            const val = parseFloat(limpiarImporte(m[1]));
            if (val > maxMonto && val < 5000000000) maxMonto = val;
        }
        if (maxMonto > 0) importe = maxMonto.toFixed(2);
    }

    return {
        cuit,
        cae,
        fecha,
        importe,
        puntoVenta,
        numeroComprobante,
        tipoComprobanteTexto: 'facturas c',
        tipoEmisionTexto: 'electr',
    };
}

function extraerDatosAnexo(textoAnexo, importeFactura) {
    let gtin = '', serie = '', fechaPrescripcion = '', fechaDispensa = '', valorErogado = '';

    const matchTraza = textoAnexo.match(/\b(0(?:779|780|080)[0-9]{17,})\b/);
    if (matchTraza) {
        const codigo = matchTraza[1];
        const matchGtin = codigo.match(REGEX_GTIN);
        if (matchGtin) {
            gtin = matchGtin[1];
            serie = codigo.substring(gtin.length);
        } else {
            gtin = codigo.substring(0, 14);
            serie = codigo.substring(14);
        }
    }

    const matchFecha = textoAnexo.match(/([0-9]{2})[\/\-]([0-9]{2})[\/\-]([0-9]{4})/);
    if (matchFecha) {
        fechaDispensa = `${matchFecha[1]}/${matchFecha[2]}/${matchFecha[3]}`;
        fechaPrescripcion = fechaDispensa;
    }

    const matchValor = textoAnexo.match(/Total\s+general\s+(?:[0-9]+\s+)?\$?\s*([0-9]{1,3}(?:[.,][0-9]{3})*[.,][0-9]{2})(?![0-9])/i);
    valorErogado = matchValor ? limpiarImporte(matchValor[1]) : (importeFactura || '');

    return { gtin, serie, fechaPrescripcion, fechaDispensa, valorErogado };
}

module.exports = {
    CUIT: CUIT_ROSFAR,
    nombre: 'Drogueria ROSFAR',
    detectar,
    extraerDatos,
    extraerDatosAnexo,
};
