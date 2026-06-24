// ============================================================
// parsers/amgen.js - Parser para Amgen Biotecnologia de Argentina SRL
// ============================================================
// CUIT: 30715588648
//
// Layout observado:
//   - "FACTURA DE CREDITO MiPyME N°: 0013-00006637"
//   - "Fecha de emisión: 02.12.2025"
//   - "C.A.E.: 75488128881839"
//   - "Total 305.962.434,69"
// ============================================================

const { limpiarImporte, normalizarTexto, textoEnLinea } = require('./utils');

const CUIT_AMGEN = '30715588648';

function detectar(textoPlano) {
    if (textoPlano.includes(CUIT_AMGEN)) return true;
    return /AMGEN\s+BIOTECNOLOG[IÍ]A/i.test(textoPlano) || /\bAMGEN\b/i.test(textoPlano);
}

function montoToFixed(valor) {
    const n = parseFloat(limpiarImporte(valor));
    return Number.isFinite(n) && n > 0 ? n.toFixed(2) : '';
}

function extraerDatos(textoOCR) {
    const texto = normalizarTexto(textoOCR);
    const plano = textoEnLinea(texto);

    const cuit = CUIT_AMGEN;

    let puntoVenta = '', numeroComprobante = '';
    const matchNro =
        plano.match(/MiPyME\s*N[°ºoO]?\s*:?\s*0*([0-9]{4,5})\s*[-–—]\s*0*([0-9]{7,8})(?![0-9])/i) ||
        plano.match(/FACTURA[\s\S]{0,120}?N[°ºoO]?\s*:?\s*0*([0-9]{4,5})\s*[-–—]\s*0*([0-9]{7,8})(?![0-9])/i) ||
        plano.match(/(?<![0-9])0*([0-9]{4,5})\s*[-–—]\s*0*([0-9]{7,8})(?![0-9])/);
    if (matchNro) {
        puntoVenta = matchNro[1].padStart(4, '0');
        numeroComprobante = matchNro[2].padStart(8, '0');
    }

    let fecha = '';
    const matchFecha =
        plano.match(/Fecha\s+de\s+emisi[oó]n\s*:?\s*([0-9]{2})[\/\-.]([0-9]{2})[\/\-.]([0-9]{4})/i) ||
        plano.match(/(?<![0-9])([0-9]{2})[\/\-.]([0-9]{2})[\/\-.]([0-9]{4})(?![0-9])/);
    if (matchFecha) fecha = `${matchFecha[1]}/${matchFecha[2]}/${matchFecha[3]}`;

    let cae = '';
    const matchCae =
        plano.match(/C\.?\s*A\.?\s*E\.?\s*:?\s*([0-9]{14})(?![0-9])/i) ||
        plano.match(/CAE\s*:?\s*([0-9]{14})(?![0-9])/i);
    if (matchCae) {
        cae = matchCae[1];
    } else {
        const posibles = [...plano.matchAll(/(?<![0-9])([0-9]{14})(?![0-9])/g)]
            .filter(m => !/^0/.test(m[1]));
        if (posibles.length > 0) cae = posibles[posibles.length - 1][1];
    }

    let importe = '';
    const matchTotal = [...plano.matchAll(/\bTotal\b[^0-9]{0,40}([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2})(?![0-9])/gi)];
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
    CUIT: CUIT_AMGEN,
    nombre: 'Amgen Biotecnologia de Argentina SRL',
    detectar,
    extraerDatos,
    extraerDatosAnexo,
};
