// ============================================================
// parsers/roche.js — Parser específico para Productos Roche S.A.Q. e I.
// ============================================================

const { limpiarImporte, normalizarTexto, textoEnLinea, REGEX_GTIN } = require('./utils');

const CUIT_ROCHE = '30527444280';

function detectar(textoPlano) {
    if (textoPlano.includes(CUIT_ROCHE) || textoPlano.includes('30-52744428-0')) return true;
    if (/Roche S\.A\.Q/i.test(textoPlano)) return true;
    return false;
}

function extraerDatos(textoOCR) {
    const texto = normalizarTexto(textoOCR);
    const plano = textoEnLinea(texto);

    const cuit = CUIT_ROCHE;

    let puntoVenta = '', numeroComprobante = '';
    const matchNro = plano.match(/N[°º*]?\s*:\s*([0-9]{4,5})\s*[-–—]\s*([0-9]{8})/i) || 
                     plano.match(/(?<![0-9])([0-9]{4,5})[\s\-_]+([0-9]{8})(?![0-9])/);
    if (matchNro) {
        puntoVenta = matchNro[1];
        numeroComprobante = matchNro[2];
    }

    let fecha = '';
    const matchFecha = plano.match(/Fecha\s*:\s*([0-9]{2})[\s\/\-.]+([0-9]{2})[\s\/\-.]+([0-9]{4})/i) || 
                       plano.match(/(?<![0-9])([0-9]{2})[\s\/\-.]+([0-9]{2})[\s\/\-.]+([0-9]{4})(?![0-9])/);
    if (matchFecha) fecha = `${matchFecha[1]}/${matchFecha[2]}/${matchFecha[3]}`;

    let cae = '';
    const matchCae = plano.match(/C\.?[AΑa]\.?[EΕe]\.?[AΑa]?\.?\s*N?[°º*]?\s*([0-9]{14})/i) || 
                     [...plano.matchAll(/(?<![0-9])([0-9]{14})(?![0-9])/g)].pop();
    if (matchCae) cae = matchCae[1];

    // --- IMPORTE TOTAL (Estrategia: De abajo hacia arriba) ---
    let importeFloat = 0;
    let textoParaTotal = plano.replace(/TOTAL[\s\-_]*(?:IMP\.?\s*BRUTO|BRUTO|DESCUENTOS?|UNIDADES)/gi, 'IGNORE');
    const matchTotalExacto = [...textoParaTotal.matchAll(/(?:TOTAL|IMPORTE TOTAL(?: FACTURA)?|IMPORTE FINAL|NETO A PAGAR|A PAGAR)[\s:.$A-Za-z=\-_]{0,80}?([0-9]{1,3}(?:[.\-\s,][0-9]{3})+[.,][0-9]{2}|[0-9]{4,15}[.,][0-9]{2})(?![0-9])/gi)];
    
    if (matchTotalExacto.length > 0) {
        const ultimaCoincidencia = matchTotalExacto[matchTotalExacto.length - 1];
        importeFloat = parseFloat(limpiarImporte(ultimaCoincidencia[1]));
    }

    if (!importeFloat || importeFloat === 0) {
        const REGEX_MONTO = /([0-9]{1,3}(?:[.\-,\s][0-9]{3})+[.,][0-9]{2}|[0-9]{4,15}[.,][0-9]{2})(?![0-9])/g;
        const todosLosMontos = [...plano.matchAll(REGEX_MONTO)];
        for (let i = todosLosMontos.length - 1; i >= 0; i--) {
            const val = parseFloat(limpiarImporte(todosLosMontos[i][1]));
            if (val > 10 && val < 500000000) {
                importeFloat = val; break;
            }
        }
    }

    let importe = importeFloat ? importeFloat.toFixed(2) : '';

    return {
        cuit, cae, fecha, importe, puntoVenta, numeroComprobante,
        tipoComprobanteTexto: /mipyme/i.test(plano) ? 'mipyme' : 'facturas a',
        tipoEmisionTexto: /anticipada|C\.A\.E\.A/i.test(plano) ? 'anticipada' : 'electr',
    };
}

function extraerDatosAnexo(textoAnexo, importeFactura) {
    let gtin = '', serie = '', fechaPrescripcion = '', fechaDispensa = '', valorErogado = '';

    const matchGtin = textoAnexo.match(REGEX_GTIN);
    if (matchGtin) gtin = matchGtin[1];

    if (gtin) {
        const regexSeriePost = new RegExp(gtin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s|\\-.,]*([A-Za-z0-9]{5,25})');
        const matchSerie = textoAnexo.match(regexSeriePost);
        if (matchSerie) serie = matchSerie[1];
    }
    if (!serie) {
        const alfanumericos = [...textoAnexo.matchAll(/\b([A-Za-z]+[0-9]+[A-Za-z0-9]*)\b/g)];
        if (alfanumericos.length > 0) serie = alfanumericos[0][1];
    }
    if (/^6\d{6,}/.test(serie)) serie = 'G' + serie.substring(1);

    const regexFechas = /([0-9]{2})[\s\/\-.,|]+([0-9]{2})[\s\/\-.,|]+([0-9]{4})/g;
    const todasFechas = [...textoAnexo.matchAll(regexFechas)];
    if (todasFechas.length >= 2) {
        fechaPrescripcion = `${todasFechas[0][1]}/${todasFechas[0][2]}/${todasFechas[0][3]}`;
        fechaDispensa = `${todasFechas[1][1]}/${todasFechas[1][2]}/${todasFechas[1][3]}`;
    } else if (todasFechas.length === 1) {
        fechaPrescripcion = `${todasFechas[0][1]}/${todasFechas[0][2]}/${todasFechas[0][3]}`;
        fechaDispensa = fechaPrescripcion;
    }

    const matchImporte = textoAnexo.match(/\$\s*([0-9]{1,3}(?:[.\-\s,][0-9]{3})+[.,][0-9]{2}|[0-9]+[.,][0-9]{2})/);
    if (matchImporte) {
        let val = parseFloat(limpiarImporte(matchImporte[1]));
        valorErogado = val ? val.toFixed(2) : ''; 
    } else {
        valorErogado = importeFactura || '';
    }

    return { gtin, serie, fechaPrescripcion, fechaDispensa, valorErogado };
}

module.exports = { CUIT: CUIT_ROCHE, nombre: 'Roche', detectar, extraerDatos, extraerDatosAnexo };