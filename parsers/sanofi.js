// ============================================================
// parsers/sanofi.js — Parser específico para Sanofi-Aventis Argentina S.A.
// ============================================================

const { limpiarImporte, normalizarTexto, textoEnLinea, REGEX_GTIN } = require('./utils');

const CUIT_SANOFI = '30501445416';

function detectar(textoPlano) {
    if (textoPlano.includes(CUIT_SANOFI) || textoPlano.includes('30-50144541-6')) return true;
    if (/SANOFI[\s\-]?AVENTIS/i.test(textoPlano)) return true;
    if (/SANOFI/i.test(textoPlano) && /ARGENTINA/i.test(textoPlano)) return true;
    return false;
}

function extraerDatos(textoOCR) {
    const texto = normalizarTexto(textoOCR);
    const plano = textoEnLinea(texto);

    const cuit = CUIT_SANOFI;

    // Número de factura: "N°: 0027 - 00094985" o "0027 - 00094985"
    let puntoVenta = '', numeroComprobante = '';
    const matchNro = plano.match(/N[°º*o]?\s*[:\-]?\s*([0-9]{4,5})\s*[\-\s_]+\s*([0-9]{8})(?![0-9])/i) ||
                     plano.match(/(?<![0-9])([0-9]{4,5})[\s\-_]+([0-9]{8})(?![0-9])/);
    if (matchNro) {
        puntoVenta = matchNro[1].padStart(4, '0');
        numeroComprobante = matchNro[2];
    }

    // Fecha: "8/07/2025" — puede tener día sin cero.
    // IMPORTANTE: el VENCIMIENTO del lote usa puntos (31.01.2027) → se excluye usando
    // solo barra "/" como separador. El fallback busca la primera fecha con barra de año ≥ 2020.
    let fecha = '';
    const mFecha1 = plano.match(/Fecha\s*:\s*([0-9]{1,2})\/([0-9]{2})\/([0-9]{4})/i);
    if (mFecha1) {
        fecha = `${mFecha1[1].padStart(2, '0')}/${mFecha1[2]}/${mFecha1[3]}`;
    } else {
        const fechasConBarra = [...plano.matchAll(/(?<![0-9])([0-9]{1,2})\/([0-9]{2})\/([0-9]{4})(?![0-9])/g)];
        const mFecha2 = fechasConBarra.find(m => parseInt(m[3]) >= 2020);
        if (mFecha2) fecha = `${mFecha2[1].padStart(2, '0')}/${mFecha2[2]}/${mFecha2[3]}`;
    }

    // CAE: exactamente 14 dígitos
    let cae = '';
    const matchCae = plano.match(/C\.?A\.?E\.?\s*:?\s*N?[°º]?\s*([0-9]{14})(?![0-9])/i);
    if (matchCae) {
        cae = matchCae[1];
    } else {
        // Fallback: buscar 14 dígitos que no sean CUIT ni número de comprobante
        const posibles = [...plano.matchAll(/(?<![0-9])([0-9]{14})(?![0-9])/g)]
            .filter(m => !m[1].startsWith('30') && !m[1].startsWith('20'));
        if (posibles.length > 0) cae = posibles[posibles.length - 1][1];
    }

    // Importe TOTAL: Sanofi pone "TOTAL" como cabecera de columna en la tabla de items,
    // NO como prefijo del monto final en el resumen. Por eso la búsqueda por keyword
    // captura incorrectamente el Importe Bruto (16.705.655). La estrategia correcta es
    // tomar el ÚLTIMO monto grande del documento, que en el resumen es el TOTAL final.
    let importeFloat = 0;
    const montos = [...plano.matchAll(/([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2})(?![0-9])/g)];
    for (let i = montos.length - 1; i >= 0; i--) {
        const val = parseFloat(limpiarImporte(montos[i][1]));
        if (val > 100 && val < 500000000) { importeFloat = val; break; }
    }

    const importe = importeFloat ? importeFloat.toFixed(2) : '';

    return {
        cuit, cae, fecha, importe, puntoVenta, numeroComprobante,
        tipoComprobanteTexto: /mipyme/i.test(plano) ? 'mipyme' : 'facturas a',
        tipoEmisionTexto: /anticipada|C\.A\.E\.A/i.test(plano) ? 'anticipada' : 'electr',
    };
}

function extraerDatosAnexo(textoAnexo, importeFactura) {
    let gtin = '', serie = '', fechaPrescripcion = '', fechaDispensa = '', valorErogado = '';

    // GTIN: extraer del código de trazabilidad (empieza con 077 o 080)
    const matchGtin = textoAnexo.match(REGEX_GTIN);
    if (matchGtin) {
        gtin = matchGtin[1];
        // Serie: dígitos alfanuméricos que siguen inmediatamente al GTIN en el código
        const regexSeriePost = new RegExp(
            gtin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s|\\-.,]*([A-Za-z0-9]{5,25})'
        );
        const matchSerie = textoAnexo.match(regexSeriePost);
        if (matchSerie) serie = matchSerie[1];
    }

    // Fallback serie: primer token alfanumérico mixto (letras + dígitos)
    if (!serie) {
        const alfanumericos = [...textoAnexo.matchAll(/\b([A-Za-z]+[0-9]+[A-Za-z0-9]*)\b/g)];
        if (alfanumericos.length > 0) serie = alfanumericos[0][1];
    }

    // Fechas: prescripción y dispensa
    const regexFechas = /([0-9]{2})[\s\/\-.,|]+([0-9]{2})[\s\/\-.,|]+([0-9]{4})/g;
    const todasFechas = [...textoAnexo.matchAll(regexFechas)];
    if (todasFechas.length >= 2) {
        fechaPrescripcion = `${todasFechas[0][1]}/${todasFechas[0][2]}/${todasFechas[0][3]}`;
        fechaDispensa     = `${todasFechas[1][1]}/${todasFechas[1][2]}/${todasFechas[1][3]}`;
    } else if (todasFechas.length === 1) {
        fechaPrescripcion = `${todasFechas[0][1]}/${todasFechas[0][2]}/${todasFechas[0][3]}`;
        fechaDispensa     = fechaPrescripcion;
    }

    // Valor erogado: importe unitario del detalle (con símbolo $)
    const matchImporte = textoAnexo.match(/\$\s*([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2}|[0-9]+[.,][0-9]{2})/);
    if (matchImporte) {
        const val = parseFloat(limpiarImporte(matchImporte[1]));
        valorErogado = val ? val.toFixed(2) : '';
    } else {
        valorErogado = importeFactura || '';
    }

    return { gtin, serie, fechaPrescripcion, fechaDispensa, valorErogado };
}

module.exports = { CUIT: CUIT_SANOFI, nombre: 'Sanofi', detectar, extraerDatos, extraerDatosAnexo };
