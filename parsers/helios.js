// ============================================================
// parsers/helios.js - Parser especifico para HELIOS SALUD SA
// ============================================================
// CUIT: 30-68210722-3 (30682107223)
//
// Layout observado:
//   - Factura de Credito Electronica MiPyMEs (FCE), Cod. 201
//   - "Punto de Venta: 00021   Comp. Nro: 00000210"
//   - "Fecha de Emision: 31/12/2025"
//   - "Importe Total: $ 443839780,62"
//   - "CAE N°: 76013620082113"
//   - Anexo: "Detalle de consumos", con fecha YYYYMMDD, GTIN y SERIE entre comillas
// ============================================================

const { limpiarImporte, normalizarTexto, textoEnLinea, REGEX_GTIN } = require('./utils');

const CUIT_HELIOS = '30682107223';

function detectar(textoPlano) {
    if (textoPlano.includes(CUIT_HELIOS) || textoPlano.includes('30-68210722-3')) return true;
    if (/\bHELIOS\s+SALUD\s+S\.?A\.?\b/i.test(textoPlano)) return true;
    return false;
}

function extraerDatos(textoOCR) {
    const texto = normalizarTexto(textoOCR);
    const plano = textoEnLinea(texto);

    const cuit = CUIT_HELIOS;

    let puntoVenta = '', numeroComprobante = '';
    const matchNro =
        plano.match(/Punto\s+de\s+Venta\s*:\s*([0-9]{4,5})[\s\S]{0,80}?Comp\.?\s*Nro\s*:\s*([0-9]{1,8})/i) ||
        plano.match(/(?<![0-9])([0-9]{4,5})\s*[- ]\s*([0-9]{8})(?![0-9])/);
    if (matchNro) {
        puntoVenta = matchNro[1].padStart(4, '0');
        numeroComprobante = matchNro[2].padStart(8, '0');
    }

    let fecha = '';
    const matchFecha =
        plano.match(/Fecha\s+de\s+Emisi[oó]n\s*:\s*([0-9]{2})[\/\-.]+([0-9]{2})[\/\-.]+([0-9]{4})/i) ||
        plano.match(/(?<![0-9])([0-9]{2})[\/\-.]+([0-9]{2})[\/\-.]+([0-9]{4})(?![0-9])/);
    if (matchFecha) fecha = `${matchFecha[1]}/${matchFecha[2]}/${matchFecha[3]}`;

    let cae = '';
    const matchCae =
        plano.match(/CAE\s*N?[°ºoO]?\s*:?\s*([0-9]{14})(?![0-9])/i) ||
        plano.match(/C\.?A\.?E\.?\s*N?[°ºoO]?\s*:?\s*([0-9]{14})(?![0-9])/i);
    if (matchCae) {
        cae = matchCae[1];
    } else {
        const posibles = [...plano.matchAll(/(?<![0-9])([0-9]{14})(?![0-9])/g)]
            .filter(m => !/^0/.test(m[1]));
        if (posibles.length > 0) cae = posibles[posibles.length - 1][1];
    }

    let importe = '';
    const matchTotal =
        plano.match(/Importe\s+Total\s*:\s*\$?\s*([0-9]{1,15}(?:[.,][0-9]{2}))/i) ||
        plano.match(/SON\s+\$\s*[\s\S]{0,120}?([0-9]{1,15}(?:[.,][0-9]{2}))/i);
    if (matchTotal) {
        const val = parseFloat(limpiarImporte(matchTotal[1]));
        if (val > 0) importe = val.toFixed(2);
    }
    if (!importe) {
        let maxMonto = 0;
        const montos = [...plano.matchAll(/([0-9]{1,15}(?:[.,][0-9]{2}))(?![0-9])/g)];
        for (const m of montos) {
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
    let gtin = '', serie = '', fechaPrescripcion = '', fechaDispensa = '', valorErogado = '';

    const matchGtinSerie = textoAnexo.match(/"?(0?(?:779|080)[0-9]{10})"?\s+"?([A-Za-z0-9]{6,30})"?/);
    if (matchGtinSerie) {
        gtin = matchGtinSerie[1];
        serie = matchGtinSerie[2];
    } else {
        const matchGtin = textoAnexo.match(REGEX_GTIN);
        if (matchGtin) gtin = matchGtin[1];
    }

    if (!serie && gtin) {
        const idx = textoAnexo.indexOf(gtin);
        if (idx !== -1) {
            const after = textoAnexo.substring(idx + gtin.length);
            const matchSerie = after.match(/"?([A-Za-z0-9]{6,30})"?/);
            if (matchSerie) serie = matchSerie[1];
        }
    }

    const matchFechaCompacta = textoAnexo.match(/\b(20[0-9]{2})([0-9]{2})([0-9]{2})\b/);
    if (matchFechaCompacta) {
        fechaDispensa = `${matchFechaCompacta[3]}/${matchFechaCompacta[2]}/${matchFechaCompacta[1]}`;
        fechaPrescripcion = fechaDispensa;
    }

    const matchValor = textoAnexo.match(/ARV\s+([0-9]+[.,][0-9]{2})/i);
    valorErogado = matchValor ? limpiarImporte(matchValor[1]) : (importeFactura || '');

    return { gtin, serie, fechaPrescripcion, fechaDispensa, valorErogado };
}

module.exports = {
    CUIT: CUIT_HELIOS,
    nombre: 'Helios Salud S.A.',
    detectar,
    extraerDatos,
    extraerDatosAnexo,
};
