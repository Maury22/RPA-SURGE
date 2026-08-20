// ============================================================
// parsers/astrazeneca.js - Parser para AstraZeneca S.A.
// ============================================================
// CUIT: 30500772324
//
// Layout observado:
//   - "Factura de credito MiPyME"
//   - "Numero: 0033-00025467"
//   - "FECHA: 10/06/2025"
//   - "C.A.E. No. 75234293115577"
//   - "Total 526.933.863,86"
// ============================================================

const { limpiarImporte, normalizarTexto, textoEnLinea } = require('./utils');

const CUIT_ASTRAZENECA = '30500772324';

function detectar(textoPlano) {
    const compactado = String(textoPlano || '').replace(/[-\s.]/g, '').toUpperCase();
    if (compactado.includes(CUIT_ASTRAZENECA)) return true;
    return /ASTRA\s*ZENECA/i.test(textoPlano) || /\bASTRAZENECA\b/i.test(textoPlano);
}

function montoToFixed(valor) {
    const n = parseFloat(limpiarImporte(valor));
    return Number.isFinite(n) && n > 0 ? n.toFixed(2) : '';
}

function extraerDatos(textoOCR) {
    const texto = normalizarTexto(textoOCR);
    const plano = textoEnLinea(texto);

    const cuit = CUIT_ASTRAZENECA;

    let puntoVenta = '', numeroComprobante = '';
    const matchNro =
        plano.match(/N[u\u00fa]mero\s*:?\s*0*([0-9]{4,5})\s*[-\u2013\u2014]\s*0*([0-9]{7,8})(?![0-9])/i) ||
        plano.match(/Factura[\s\S]{0,140}?0*([0-9]{4,5})\s*[-\u2013\u2014]\s*0*([0-9]{7,8})(?![0-9])/i) ||
        plano.match(/(?<![0-9])0*([0-9]{4,5})\s*[-\u2013\u2014]\s*0*([0-9]{7,8})(?![0-9])/);
    if (matchNro) {
        puntoVenta = matchNro[1].padStart(4, '0');
        numeroComprobante = matchNro[2].padStart(8, '0');
    }

    let fecha = '';
    const matchFecha =
        plano.match(/\bFECHA\b\s*:?\s*([0-9]{2})[\/\-.]([0-9]{2})[\/\-.]([0-9]{4})/i) ||
        plano.match(/Fecha\s+de\s+emisi[o\u00f3]n\s*:?\s*([0-9]{2})[\/\-.]([0-9]{2})[\/\-.]([0-9]{4})/i) ||
        plano.match(/(?<![0-9])([0-9]{2})[\/\-.]([0-9]{2})[\/\-.]([0-9]{4})(?![0-9])/);
    if (matchFecha) fecha = `${matchFecha[1]}/${matchFecha[2]}/${matchFecha[3]}`;

    let cae = '';
    const matchCae =
        plano.match(/C\.?\s*A\.?\s*E\.?\s*(?:No\.?|Nro\.?|N[\u00b0\u00baoO]\.?)?\s*:?\s*([0-9]{14})(?![0-9])/i) ||
        plano.match(/CAE\s*(?:No\.?|Nro\.?|N[\u00b0\u00baoO]\.?)?\s*:?\s*([0-9]{14})(?![0-9])/i);
    if (matchCae) {
        cae = matchCae[1];
    } else {
        const posibles = [...plano.matchAll(/(?<![0-9])([0-9]{14})(?![0-9])/g)]
            .filter(m => !/^0/.test(m[1]));
        if (posibles.length > 0) cae = posibles[posibles.length - 1][1];
    }

    let importe = '';
    const matchTotal = [...plano.matchAll(/\bTotal\b[^0-9]{0,60}([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2})(?![0-9])/gi)];
    if (matchTotal.length > 0) importe = montoToFixed(matchTotal[matchTotal.length - 1][1]);

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
        tipoComprobanteTexto: 'mipyme',
        tipoEmisionTexto: /CAEA/i.test(plano) ? 'anticipada' : 'electr',
    };
}

function extraerDatosAnexo(textoAnexo, importeFactura) {
    return {
        gtin: '',
        serie: '',
        fechaPrescripcion: '',
        fechaDispensa: '',
        valorErogado: importeFactura || '',
    };
}

module.exports = {
    CUIT: CUIT_ASTRAZENECA,
    nombre: 'AstraZeneca S.A.',
    detectar,
    extraerDatos,
    extraerDatosAnexo,
};
