// ============================================================
// parsers/merck.js — Parser específico para MERCK S.A.
// ============================================================
// CUIT: 30-50383256-5 (30503832565)
//
// Layout (2 págs. factura + 1 pág. anexo):
//   Pág. 1-2: Factura en formato monoespaciado
//     - N°:    bloque "FACTURA  0096-00132890"  (esquina sup. derecha)
//     - Fecha: "Fecha  08/09/2025"              (mismo bloque)
//     - Total: "TOTAL ARS  479060274,04"        (pie de pág. 1)
//     - CAE:   "C.A.E Nº 75365361877344"        (línea pie de ambas páginas)
//              "Impreso MERCK S.A.- CUIT 30-50383256-5 - Fecha XX.XX.XXXX C.A.E Nº XXXXXXXXXXXXXX"
//              ► CAE estándar (NO CAEA)
//   Pág. 3: Anexo "DETALLE DE LA FACTURA: MERCK SA."
//     - Trazabilidad: GTIN (14 dígitos) + serie concatenados en una sola cadena
//       ej. "07730949043112127155692762"  → GTIN=07730949043112, serie=127155692762
//     - Nro. FACTURA: "0096-00132890"
//     - FECHA: "08/09/2025"
//     - IMP. UNIT.: "$ 496,805.17"  → valorErogado
//
// NOTA: "MEDIFARM" aparece como dirección de entrega → poner este parser
//       ANTES de medifarm en el array de parsers/index.js para evitar
//       detección falsa positiva por nombre de empresa.
// ============================================================

const { limpiarImporte, normalizarTexto, textoEnLinea } = require('./utils');

const CUIT_MERCK = '30503832565';

// ── Detección ─────────────────────────────────────────────────────────────────
function detectar(textoPlano) {
    if (textoPlano.includes(CUIT_MERCK) || textoPlano.includes('30-50383256-5')) return true;
    if (/\bMERCK\s+S\.?A\.?\b/i.test(textoPlano) && /merck\.com\.ar/i.test(textoPlano)) return true;
    return false;
}

// ── Datos principales de la factura ───────────────────────────────────────────
function extraerDatos(textoOCR) {
    const texto = normalizarTexto(textoOCR);
    const plano = textoEnLinea(texto);

    const cuit = CUIT_MERCK;

    // ── NÚMERO DE COMPROBANTE ────────────────────────────────────────────────
    // "FACTURA  0096-00132890" en el bloque superior derecho
    let puntoVenta = '', numeroComprobante = '';
    const matchNro =
        plano.match(/FACTURA\s+([0-9]{4,5})\s*[-–—]\s*([0-9]{8})/i) ||
        plano.match(/(?<![0-9])([0-9]{4,5})\s*[-–—]\s*([0-9]{8})(?![0-9])/);
    if (matchNro) {
        puntoVenta        = matchNro[1];
        numeroComprobante = matchNro[2];
    }

    // ── FECHA ────────────────────────────────────────────────────────────────
    // PROBLEMA: el pie de página tiene "Fecha 11.09.2025" (fecha de impresión)
    // y puede aparecer antes que el encabezado "Fecha 08/09/2025" en el stream OCR.
    //
    // SOLUCIÓN: la fecha de emisión siempre está JUNTO AL número de comprobante
    // (encabezado: "FACTURA  0096-00132890 ... Fecha  08/09/2025"
    //  remito pág.2: "0096-00132890  08/09/2025  ...").
    // El pie "Fecha 11.09.2025" NUNCA aparece cerca del número de comprobante.
    let fecha = '';
    if (puntoVenta && numeroComprobante) {
        const nroStr = puntoVenta + '-' + numeroComprobante;
        const idxNro = plano.indexOf(nroStr);
        if (idxNro !== -1) {
            // Buscar fecha en los 250 chars siguientes al número de comprobante
            const ventana = plano.substring(idxNro + nroStr.length, idxNro + nroStr.length + 250);
            const mV = ventana.match(/([0-9]{2})[\/\-.]+([0-9]{2})[\/\-.]+([0-9]{4})/);
            if (mV) fecha = `${mV[1]}/${mV[2]}/${mV[3]}`;
        }
    }
    // Fallback: "Fecha DD/MM/YYYY" con barra (encabezado usa /, pie usa .)
    if (!fecha) {
        const mF = plano.match(/\bFecha\s+([0-9]{2})\/([0-9]{2})\/([0-9]{4})/i) ||
                   plano.match(/(?<![0-9])([0-9]{2})\/([0-9]{2})\/([0-9]{4})(?![0-9])/);
        if (mF) fecha = `${mF[1]}/${mF[2]}/${mF[3]}`;
    }

    // ── CAE ──────────────────────────────────────────────────────────────────
    // Merck usa CAE estándar (no CAEA):
    //   "Impreso MERCK S.A.- CUIT 30-50383256-5 - Fecha XX.XX.XXXX C.A.E Nº 75365361877344"
    let cae = '', esCaea = false;

    // Verificar primero si hay CAEA (por si acaso)
    const matchCaea = plano.match(/C\.?A\.?E\.?A\.?\s*N?[°º*oO]?\s*:?\s*([0-9]{14})/i);
    if (matchCaea) {
        cae = matchCaea[1]; esCaea = true;
    } else {
        // CAE estándar: "C.A.E Nº XXXXXXXXXXXXXX"
        const matchCae =
            plano.match(/C\.?A\.?E\.?\s+N[°º*oO0]?\s*([0-9]{14})/i) ||
            plano.match(/\bCAE\b[^0-9]{0,30}([0-9]{14})/i);
        if (matchCae) {
            cae = matchCae[1];
        } else {
            // Último número de 14 dígitos del texto
            const posibles = [...plano.matchAll(/(?<![0-9])([0-9]{14})(?![0-9])/g)];
            if (posibles.length > 0) cae = posibles[posibles.length - 1][1];
        }
    }

    // ── IMPORTE TOTAL ────────────────────────────────────────────────────────
    // Formato mixto en OCR: puede aparecer sin separador de miles ("479060274,04")
    // o con puntos ("479.060.274,04"). limpiarImporte() maneja ambos.
    const REGEX_MONTO = /([0-9]{1,3}(?:[.\-,\s][0-9]{3})+[.,][0-9]{2}|[0-9]{4,15}[.,][0-9]{2})(?![0-9])/g;
    let importe = '';

    // Estrategia 1: "TOTAL ARS"
    const matchTotalARS =
        plano.match(/TOTAL\s+ARS\s+([0-9]{1,3}(?:[.,][0-9]{3})*[.,][0-9]{2}|[0-9]{4,}[.,][0-9]{2})/i) ||
        plano.match(/\bTOTAL\s+ARS\b[^0-9]{0,20}([0-9]{5,}[.,][0-9]{2})/i);
    if (matchTotalARS) {
        const val = parseFloat(limpiarImporte(matchTotalARS[1]));
        if (val > 0) importe = val.toFixed(2);
    }

    // Estrategia 2: ancla "Son Pesos"
    if (!importe) {
        const idxSP = plano.search(/Son\s+Pesos\s*:/i);
        if (idxSP !== -1) {
            const montos = [...plano.substring(0, idxSP).matchAll(REGEX_MONTO)];
            if (montos.length > 0) {
                const val = parseFloat(limpiarImporte(montos[montos.length - 1][1]));
                if (val > 0) importe = val.toFixed(2);
            }
        }
    }

    // Estrategia 3: "TOTAL" genérico
    if (!importe) {
        const matchTot = plano.match(/\bTOTAL\b[^0-9]{0,40}([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2})/i);
        if (matchTot) {
            const val = parseFloat(limpiarImporte(matchTot[1]));
            if (val > 0) importe = val.toFixed(2);
        }
    }

    // Estrategia 4: máximo numérico
    if (!importe) {
        let maxMonto = 0;
        for (const m of [...plano.matchAll(REGEX_MONTO)]) {
            const val = parseFloat(limpiarImporte(m[1]));
            if (val > maxMonto && val < 5000000000) maxMonto = val;
        }
        if (maxMonto > 0) importe = maxMonto.toFixed(2);
    }

    const tipoComprobanteTexto = /mipyme/i.test(plano) ? 'mipyme' : 'facturas a';
    const tipoEmisionTexto     = esCaea ? 'anticipada' : 'electr';

    return { cuit, cae, fecha, importe, puntoVenta, numeroComprobante, tipoComprobanteTexto, tipoEmisionTexto };
}

// ── Datos del anexo ───────────────────────────────────────────────────────────
function extraerDatosAnexo(textoAnexo, importeFactura) {
    let gtin = '', serie = '', fechaPrescripcion = '', fechaDispensa = '', valorErogado = '';

    // Trazabilidad concatenada: GTIN (14 dígitos) + serie (dígitos restantes)
    // Ej: "07730949043112127155692762" → GTIN=07730949043112, serie=127155692762
    const matchTraz = textoAnexo.match(/(?<![0-9A-Za-z])([0-9]{14})([0-9]{6,16})(?![0-9A-Za-z])/);
    if (matchTraz) {
        gtin  = matchTraz[1];
        serie = matchTraz[2];
    }

    // Fecha: columna FECHA del anexo (única fecha disponible → usada para dispensa y prescripción)
    const fechas = [...textoAnexo.matchAll(/([0-9]{2})[\/\-.]+([0-9]{2})[\/\-.]+([0-9]{4})/g)];
    if (fechas.length > 0) {
        fechaDispensa     = `${fechas[0][1]}/${fechas[0][2]}/${fechas[0][3]}`;
        fechaPrescripcion = fechaDispensa;
    }

    // Valor erogado: "$ 496,805.17" o "$ 496.805,17"
    const matchImp = textoAnexo.match(/\$\s*([0-9]{1,3}(?:[.,][0-9]{3})*[.,][0-9]{2}|[0-9]+[.,][0-9]{2})/);
    valorErogado = matchImp ? limpiarImporte(matchImp[1]) : (importeFactura || '');

    return { gtin, serie, fechaPrescripcion, fechaDispensa, valorErogado };
}

module.exports = {
    CUIT: CUIT_MERCK,
    nombre: 'Merck S.A.',
    detectar,
    extraerDatos,
    extraerDatosAnexo,
};
