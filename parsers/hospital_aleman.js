// ============================================================
// parsers/hospital_aleman.js - Parser para Hospital Aleman
// ============================================================
// CUIT: 30545843036 (30-54584303-6)
//
// Layout factura:
//   - "A0072-00048913"
//   - "FECHA 31/07/2025"
//   - "CAE: 75316428019370"
//   - "TOTAL $ 16.736.579,07"
//
// Layout anexo:
//   - DETALLE DE LA FACTURA: HOSPITAL ALEMAN
//   - Cod. Trazabilidad = GTIN(14) + serie
// ============================================================

const { limpiarImporte, normalizarTexto, textoEnLinea, REGEX_GTIN } = require('./utils');

const CUIT_HOSPITAL_ALEMAN = '30545843036';

function detectar(textoPlano) {
    if (textoPlano.includes(CUIT_HOSPITAL_ALEMAN) || textoPlano.includes('30-54584303-6')) return true;
    return /HOSPITAL\s+ALEM[AÁ]N/i.test(textoPlano);
}

function montoToNumber(valor) {
    const n = parseFloat(limpiarImporte(valor));
    return Number.isFinite(n) ? n : 0;
}

function buscarMonto(plano, etiqueta) {
    const re = new RegExp(etiqueta + '[^0-9]{0,80}([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2})', 'i');
    const m = plano.match(re);
    return m ? montoToNumber(m[1]) : 0;
}

function buscarMontoFlexible(plano, etiqueta, stopEtiqueta = '') {
    const re = new RegExp(etiqueta, 'i');
    const m = plano.match(re);
    if (!m) return 0;

    let ventana = plano.substring(m.index, m.index + 180);
    if (stopEtiqueta) {
        const stop = ventana.substring(1).search(new RegExp(stopEtiqueta, 'i'));
        if (stop !== -1) ventana = ventana.substring(0, stop + 1);
    }
    let mejor = 0;

    for (const exacto of ventana.matchAll(/([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{1,2})(?![0-9])/g)) {
        const val = montoToNumber(exacto[1]);
        if (val > mejor) mejor = val;
    }

    for (const raro of ventana.matchAll(/\b([0-9]\s+[0-9]{2}[.][0-9]{4})\b/g)) {
        const digits = raro[1].replace(/\D/g, '');
        const val = Number(digits) / 10;
        if (val > mejor) mejor = val;
    }

    return mejor;
}

function sumarUnDia(fecha) {
    const m = fecha.match(/^([0-9]{2})\/([0-9]{2})\/([0-9]{4})$/);
    if (!m) return fecha;
    const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    d.setDate(d.getDate() + 1);
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function extraerDatos(textoOCR) {
    const texto = normalizarTexto(textoOCR);
    const plano = textoEnLinea(texto);

    const cuit = CUIT_HOSPITAL_ALEMAN;

    let puntoVenta = '', numeroComprobante = '';
    const matchNro =
        plano.match(/\bA\s*0*([0-9]{4,5})\s*[-–—]\s*0*([0-9]{7,8})(?![0-9])/i) ||
        plano.match(/(?:NUMERO|N[ÚU]MERO|Factura)[^0-9]{0,80}0*([0-9]{4,5})\s*[-–—]\s*0*([0-9]{7,8})(?![0-9])/i) ||
        plano.match(/(?<![0-9])0*([0-9]{4,5})\s*[-–—]\s*0*([0-9]{7,8})(?![0-9])/);
    if (matchNro) {
        puntoVenta = matchNro[1].padStart(4, '0');
        numeroComprobante = matchNro[2].padStart(8, '0');
    }

    let fecha = '';
    const matchFechaCabecera = plano.match(/FECHA\s*:?\s*([0-9]{2})[\/\-]([0-9]{2})[\/\-]([0-9]{4})/i);
    if (matchFechaCabecera) {
        fecha = `${matchFechaCabecera[1]}/${matchFechaCabecera[2]}/${matchFechaCabecera[3]}`;
    } else {
        const matchFacturacion = plano.match(/Facturaci[oó]n[^0-9]{0,40}([0-9]{2})[\/\-]([0-9]{2})[\/\-]([0-9]{4})/i);
        if (matchFacturacion) {
            fecha = sumarUnDia(`${matchFacturacion[1]}/${matchFacturacion[2]}/${matchFacturacion[3]}`);
        } else {
            const matchFecha = plano.match(/(?<![0-9])([0-9]{2})[\/\-]([0-9]{2})[\/\-]([0-9]{4})(?![0-9])/);
            if (matchFecha) fecha = `${matchFecha[1]}/${matchFecha[2]}/${matchFecha[3]}`;
        }
    }

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
    const allTotal = [...plano.matchAll(/\bTOTAL\b[^0-9]{0,40}([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2})/gi)];
    if (allTotal.length > 0) {
        const val = montoToNumber(allTotal[allTotal.length - 1][1]);
        if (val > 0) importe = val.toFixed(2);
    }

    if (!importe) {
        const neto = buscarMonto(plano, 'IMPORTE\\s+NETO');
        const iva = neto > 0 ? Math.round(neto * 10.5) / 100 : buscarMontoFlexible(plano, 'IVA');
        const pba = buscarMonto(plano, 'PERCEP\\.?.{0,20}PBA') || buscarMontoFlexible(plano, 'PERCEP\\.?.{0,20}PBA', 'CABA');
        const caba = buscarMonto(plano, 'PERCEP\\.?.{0,20}CABA') || buscarMontoFlexible(plano, 'PERCEP\\.?.{0,20}CABA');
        const suma = neto + iva + pba + caba;
        if (neto > 0 && suma > neto) importe = suma.toFixed(2);
    }

    if (!importe) {
        let maxMonto = 0;
        for (const m of plano.matchAll(/([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2})(?![0-9])/g)) {
            const val = montoToNumber(m[1]);
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
        tipoComprobanteTexto: 'facturas a',
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
    CUIT: CUIT_HOSPITAL_ALEMAN,
    nombre: 'Hospital Aleman',
    detectar,
    extraerDatos,
    extraerDatosAnexo,
};
