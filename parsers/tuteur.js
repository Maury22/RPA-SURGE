// ============================================================
// parsers/tuteur.js — Parser para TUTEUR S.A.C.I.F.I.A.
// ============================================================
// CUIT: 30-58986464-2 (30589864642)
//
// Layout factura (pág. 1):
//   - Número:  "0018-00219929" (en cabecera "FACTURA 0018-00219929 ORIGINAL")
//   - Fecha:   "Buenos Aires, 03-11-2025"  (DD-MM-YYYY con guión)
//   - CAE:     "C.A.E.: 75442455166838"
//   - Total:   "Importe total factura: 155.406,09" (AR: punto=miles, coma=decimal)
//   - Tipo: Factura A electrónica
//
// Layout anexo "Detalle de la Factura" (pág. 2 — tabla):
//   - Header:  "DETALLE DE LA FACTURA: TUTEUR S.A.C.I.F.I.A."
//   - Cod. Trazabilidad: "0779339705121400039173" (22 dígitos) → GTIN(14) + Serie(8)
//   - FECHA:   "03/11/2025" → fechaDispensa (prescripción no separada, usar igual)
//   - IMP. UNIT.: "$ 124,234.71" (formato US: coma=miles, punto=decimal)
// ============================================================

const { limpiarImporte, normalizarTexto, textoEnLinea, REGEX_GTIN } = require('./utils');

const CUIT_TUTEUR = '30589864642';

function detectar(textoPlano) {
    if (textoPlano.includes(CUIT_TUTEUR) || /30[\s\-\.]*589[\s\-\.]*864[\s\-\.]*64[\s\-\.]*2(?![0-9])/.test(textoPlano)) return true;
    if (/\bTUTEUR\b/i.test(textoPlano)) return true;
    return false;
}

function extraerDatos(textoOCR) {
    const texto = normalizarTexto(textoOCR);
    const plano = textoEnLinea(texto);

    const cuit = CUIT_TUTEUR;

    // ── NÚMERO DE COMPROBANTE ──────────────────────────────────────────────────
    // "0018-00219929" en la cabecera del comprobante
    let puntoVenta = '', numeroComprobante = '';
    const matchNro =
        plano.match(/(?:FACTURA\s+[A-Z]?\s*)([0-9]{4,5})\s*[-–—]\s*([0-9]{8})(?![0-9])/i) ||
        plano.match(/(?<![0-9])([0-9]{4,5})\s*[-–—]\s*([0-9]{8})(?![0-9])/);
    if (matchNro) {
        puntoVenta        = matchNro[1];
        numeroComprobante = matchNro[2].padStart(8, '0');
    }

    // ── FECHA ──────────────────────────────────────────────────────────────────
    // "Buenos Aires, 03-11-2025" → DD-MM-YYYY (guión como separador)
    let fecha = '';
    const matchFecha =
        plano.match(/Buenos\s*Aires[^0-9]{0,10}([0-9]{2})[-\/\.]([0-9]{2})[-\/\.]([0-9]{4})/i) ||
        plano.match(/(?<![0-9])([0-9]{2})[-\/\.]([0-9]{2})[-\/\.]([0-9]{4})(?![0-9])/);
    if (matchFecha) fecha = `${matchFecha[1]}/${matchFecha[2]}/${matchFecha[3]}`;

    // ── CAE ────────────────────────────────────────────────────────────────────
    // "C.A.E.: 75442455166838"
    let cae = '';
    const matchCae = plano.match(/C\.?A\.?E\.?\s*:?\s*([0-9]{14})(?![0-9])/i);
    if (matchCae) {
        cae = matchCae[1];
    } else {
        const posibles = [...plano.matchAll(/(?<![0-9])([0-9]{14})(?![0-9])/g)]
            .filter(m => !/^0/.test(m[1]));
        if (posibles.length > 0) cae = posibles[posibles.length - 1][1];
    }

    // ── IMPORTE TOTAL ──────────────────────────────────────────────────────────
    // "Importe total factura: 155.406,09"
    let importe = '';
    const matchTotal = plano.match(/Importe\s+total\s+factura\s*:?\s*([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2})/i);
    if (matchTotal) {
        importe = limpiarImporte(matchTotal[1]);
    }
    if (!importe) {
        // Fallback: mayor monto en formato argentino
        const REGEX_MONTO = /([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2})(?![0-9])/g;
        let maxMonto = 0;
        for (const m of [...plano.matchAll(REGEX_MONTO)]) {
            const val = parseFloat(limpiarImporte(m[1]));
            if (val > maxMonto && val < 5000000000) maxMonto = val;
        }
        if (maxMonto > 0) importe = maxMonto.toFixed(2);
    }

    return {
        cuit, cae, fecha, importe, puntoVenta, numeroComprobante,
        tipoComprobanteTexto: 'facturas a',
        tipoEmisionTexto:     'electr',
    };
}

function extraerDatosAnexo(textoAnexo, importeFactura) {
    let gtin = '', serie = '', fechaPrescripcion = '', fechaDispensa = '', valorErogado = '';

    // ── GTIN y SERIE desde código de trazabilidad ──────────────────────────────
    // "0779339705121400039173" (22 dígitos) → GTIN(14) + Serie(8)
    const matchTraza = textoAnexo.match(/\b(0(?:779|780|080)[0-9]{17,})\b/);
    if (matchTraza) {
        const codigo    = matchTraza[1];
        const matchGtin = codigo.match(REGEX_GTIN);
        if (matchGtin) {
            gtin  = matchGtin[1];
            serie = codigo.substring(gtin.length);
        } else {
            gtin  = codigo.substring(0, 14);
            serie = codigo.substring(14);
        }
    }

    // ── FECHA dispensa ─────────────────────────────────────────────────────────
    const matchFecha = textoAnexo.match(/([0-9]{2})[\/\-]([0-9]{2})[\/\-]([0-9]{4})/);
    if (matchFecha) {
        fechaDispensa     = `${matchFecha[1]}/${matchFecha[2]}/${matchFecha[3]}`;
        fechaPrescripcion = fechaDispensa;
    }

    // ── VALOR EROGADO ──────────────────────────────────────────────────────────
    // "$ 124,234.71" (formato US: coma=miles, punto=decimal)
    const matchUS = textoAnexo.match(/\$\s*([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2})/);
    if (matchUS) {
        valorErogado = matchUS[1].replace(/,/g, '');
    } else {
        const matchAR = textoAnexo.match(/([0-9]{1,3}(?:\.[0-9]{3})+,[0-9]{2}|[0-9]+,[0-9]{2})/);
        if (matchAR) valorErogado = limpiarImporte(matchAR[1]);
        else valorErogado = importeFactura || '';
    }

    return { gtin, serie, fechaPrescripcion, fechaDispensa, valorErogado };
}

module.exports = {
    CUIT: CUIT_TUTEUR,
    nombre: 'Tuteur S.A.C.I.F.I.A.',
    detectar,
    extraerDatos,
    extraerDatosAnexo,
};
