// ============================================================
// parsers/farmanet.js — Parser para Farmanet S.A.
// ============================================================
// CUIT: 30682519416 (30-68251941-6)
//
// Layout factura (2 hojas):
//   - Número:  "FACTURA 0111-02007761" → puntoVenta=111, comp=02007761
//   - Fecha:   "Fecha: 01/10/2025"
//   - CAEA:    "CAEA Nro.: 35396021158227 Fecha Vto.: 15/10/2025"
//   - Total:   "534.885.861,84" (formato argentino: punto=miles, coma=decimal)
//              Aparece solo en la hoja 2 (hoja 1 tiene el campo TOTAL vacío)
//   - CAEA → tipoComp='facturas a', tipoEmision='anticipada'
//
// Layout anexo "Detalle de la Factura" (pág. 3 — tabla):
//   - Cod. Trazabilidad: "077921834888146000351920" (24 dígitos) → GTIN + Serie
//   - FECHA:    "01/10/2025" → fechaDispensa
//   - IMP. UNIT / Total general: "186,974.86" (formato US) → valorErogado
//
// IMPORTANTE: Farmanet va ANTES de medifarm en parsers/index.js porque la
// factura incluye "SCIENZA HORNOS" como dirección de entrega, lo que
// dispararía medifarm.detectar() con falso positivo.
// ============================================================

const { limpiarImporte, normalizarTexto, textoEnLinea, REGEX_GTIN } = require('./utils');

const CUIT_FARMANET = '30682519416';

// ── Detección ──────────────────────────────────────────────────────────────────
function detectar(textoPlano) {
    if (textoPlano.includes(CUIT_FARMANET) || textoPlano.includes('30-68251941-6')) return true;
    if (/\bFARMANET\b/i.test(textoPlano)) return true;
    return false;
}

// ── Datos principales de la factura ───────────────────────────────────────────
function extraerDatos(textoOCR) {
    const texto = normalizarTexto(textoOCR);
    const plano = textoEnLinea(texto);

    const cuit = CUIT_FARMANET;

    // ── NÚMERO DE COMPROBANTE ──────────────────────────────────────────────────
    // "FACTURA 0111-02007761" o "FACTURA A 0111-02007761"
    let puntoVenta = '', numeroComprobante = '';
    const matchNro =
        plano.match(/FACTURA\s+(?:A\s+)?0*([0-9]{4,5})\s*[-–—]\s*0*([0-9]{7,8})(?![0-9])/i) ||
        plano.match(/N[°oº*]?\s*(?:ro\.?)?\s*0*([0-9]{4,5})\s*[-–—]\s*0*([0-9]{7,8})(?![0-9])/i) ||
        plano.match(/(?<![0-9])([0-9]{4,5})\s*[-–—]\s*([0-9]{7,8})(?![0-9])/);
    if (matchNro) {
        puntoVenta        = matchNro[1];
        numeroComprobante = matchNro[2].padStart(8, '0');
    }

    // ── FECHA ──────────────────────────────────────────────────────────────────
    let fecha = '';
    const matchFecha =
        plano.match(/Fecha\s*:\s*([0-9]{2})[\/\-]([0-9]{2})[\/\-]([0-9]{4})/i) ||
        plano.match(/(?<![0-9])([0-9]{2})[\/\-]([0-9]{2})[\/\-]([0-9]{4})(?![0-9])/);
    if (matchFecha) fecha = `${matchFecha[1]}/${matchFecha[2]}/${matchFecha[3]}`;

    // ── CAEA ───────────────────────────────────────────────────────────────────
    // "CAEA Nro.: 35396021158227 Fecha Vto.: 15/10/2025"
    const esCaea = /\bCAEA\b/i.test(plano);
    let cae = '';
    const matchCAE = plano.match(/C\.?A\.?E\.?A?\.?\s*(?:Nro\.?|N[°oº]\.?)?\s*:?\s*([0-9]{14})(?![0-9])/i);
    if (matchCAE) {
        cae = matchCAE[1];
    } else {
        // Fallback: último número de 14 dígitos en el documento
        const posibles = [...plano.matchAll(/(?<![0-9])([0-9]{14})(?![0-9])/g)];
        if (posibles.length > 0) cae = posibles[posibles.length - 1][1];
    }

    // ── IMPORTE TOTAL ──────────────────────────────────────────────────────────
    // Formato argentino: "534.885.861,84" (punto=miles, coma=decimal)
    // Solo aparece en la hoja 2: "TOTAL 534.885.861,84"
    const REGEX_MONTO = /([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2})(?![0-9])/g;
    let importe = '';

    // Estrategia 1: última línea "TOTAL NNN"
    const allTotal = [...plano.matchAll(/\bTOTAL\b[^0-9]{0,5}([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2})/gi)];
    if (allTotal.length > 0) {
        const val = parseFloat(limpiarImporte(allTotal[allTotal.length - 1][1]));
        if (val > 0) importe = val.toFixed(2);
    }

    // Estrategia 2: máximo del documento
    if (!importe) {
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
        tipoEmisionTexto:     esCaea ? 'anticipada' : 'electr',
    };
}

// ── Datos del anexo "Detalle de la Factura" ───────────────────────────────────
function extraerDatosAnexo(textoAnexo, importeFactura) {
    let gtin = '', serie = '', fechaPrescripcion = '', fechaDispensa = '', valorErogado = '';

    // ── GTIN y SERIE desde código de trazabilidad ──────────────────────────────
    // Ej: "077921834888146000351920" (24 dígitos) → GTIN(14) + Serie(10)
    const matchTraza = textoAnexo.match(/\b(0(?:779|780|080)[0-9]{17,})\b/);
    if (matchTraza) {
        const codigo = matchTraza[1];
        const matchGtin = codigo.match(REGEX_GTIN);
        if (matchGtin) {
            gtin  = matchGtin[1];
            serie = codigo.substring(gtin.length);
        } else {
            gtin  = codigo.substring(0, 14);
            serie = codigo.substring(14);
        }
    }

    // ── FECHA dispensa (columna FECHA de la tabla) ─────────────────────────────
    const matchFecha = textoAnexo.match(/([0-9]{2})[\/\-]([0-9]{2})[\/\-]([0-9]{4})/);
    if (matchFecha) {
        fechaDispensa     = `${matchFecha[1]}/${matchFecha[2]}/${matchFecha[3]}`;
        fechaPrescripcion = fechaDispensa; // Farmanet no provee fecha de prescripción separada
    }

    // ── VALOR EROGADO (IMP. UNIT / Total general) ──────────────────────────────
    // "Total general 1 $ 186,974.86" (formato US: coma=miles, punto=decimal)
    const matchValor = textoAnexo.match(/Total\s+general[^0-9$]*\$?\s*([0-9]{1,3}(?:[.,][0-9]{3})*[.,][0-9]{2})(?![0-9])/i);
    if (matchValor) {
        valorErogado = limpiarImporte(matchValor[1]);
    } else {
        valorErogado = importeFactura || '';
    }

    return { gtin, serie, fechaPrescripcion, fechaDispensa, valorErogado };
}

module.exports = {
    CUIT: CUIT_FARMANET,
    nombre: 'Farmanet S.A.',
    detectar,
    extraerDatos,
    extraerDatosAnexo,
};
