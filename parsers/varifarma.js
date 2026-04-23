// ============================================================
// parsers/varifarma.js — Parser para Laboratorio Varifarma S.A.
// ============================================================
// CUIT: 30682667709 (30-68266770-9)
//
// Layout factura (1 hoja):
//   - Número:  "N° 0010-00044142" → puntoVenta=10, comp=00044142
//   - Fecha:   "16/10/2025" (encabezado, sin etiqueta explícita)
//   - CAE:     "CAI/CAE: 75429175191178 Vto: 26/10/2025"
//              (label "CAI/CAE" es genérico del sistema de Varifarma)
//   - Total:   "355.206,61" (formato argentino: punto=miles, coma=decimal)
//              Fila final: Subtotal | Descuento | Impuestos | Total
//   - FACTURA A → tipoComp='facturas a', tipoEmision='electr'
//
// Layout anexo "Detalle de la Factura" (pág. 2 — tabla):
//   - Cod. Trazabilidad: "077980353144859596730885" (24 dígitos) → GTIN + Serie
//   - FECHA:    "16/10/2025" → fechaDispensa
//   - IMP. UNIT / Total general: "289,256.19" (formato US) → valorErogado
// ============================================================

const { limpiarImporte, normalizarTexto, textoEnLinea, REGEX_GTIN } = require('./utils');

const CUIT_VARIFARMA = '30682667709';

// ── Detección ──────────────────────────────────────────────────────────────────
function detectar(textoPlano) {
    if (textoPlano.includes(CUIT_VARIFARMA) || textoPlano.includes('30-68266770-9')) return true;
    if (/\bVARIFARMA\b/i.test(textoPlano)) return true;
    return false;
}

// ── Datos principales de la factura ───────────────────────────────────────────
function extraerDatos(textoOCR) {
    const texto = normalizarTexto(textoOCR);
    const plano = textoEnLinea(texto);

    const cuit = CUIT_VARIFARMA;

    // ── NÚMERO DE COMPROBANTE ──────────────────────────────────────────────────
    // "N° 0010-00044142" o "FACTURA A N° 0010-00044142" o "3-FCA-0010-00044142"
    let puntoVenta = '', numeroComprobante = '';
    const matchNro =
        plano.match(/N[°oº*]?\s*(?:ro\.?)?\s*0*([0-9]{4,5})\s*[-–—]\s*0*([0-9]{7,8})(?![0-9])/i) ||
        plano.match(/FCA\s*[-–—]\s*0*([0-9]{4,5})\s*[-–—]\s*0*([0-9]{7,8})(?![0-9])/i) ||
        plano.match(/(?<![0-9])([0-9]{4,5})\s*[-–—]\s*([0-9]{7,8})(?![0-9])/);
    if (matchNro) {
        puntoVenta        = matchNro[1];
        numeroComprobante = matchNro[2].padStart(8, '0');
    }

    // ── FECHA ──────────────────────────────────────────────────────────────────
    // Aparece como "16/10/2025" en el encabezado (sin etiqueta "Fecha:")
    let fecha = '';
    const matchFecha =
        plano.match(/Fecha\s*(?:de\s*inicio\s*)?:\s*([0-9]{2})[\/\-]([0-9]{2})[\/\-]([0-9]{4})/i) ||
        plano.match(/(?<![0-9])([0-9]{2})[\/\-]([0-9]{2})[\/\-]([0-9]{4})(?![0-9])/);
    if (matchFecha) fecha = `${matchFecha[1]}/${matchFecha[2]}/${matchFecha[3]}`;

    // ── CAE ────────────────────────────────────────────────────────────────────
    // "CAI/CAE: 75429175191178 Vto: 26/10/2025"
    let cae = '';
    const matchCAE =
        plano.match(/CAI\/CAE\s*:?\s*([0-9]{14})(?![0-9])/i) ||
        plano.match(/C\.?A\.?[EI]\.?\s*:?\s*([0-9]{14})(?![0-9])/i);
    if (matchCAE) {
        cae = matchCAE[1];
    } else {
        const posibles = [...plano.matchAll(/(?<![0-9])([0-9]{14})(?![0-9])/g)]
            .filter(m => !/^0(?:779|080)/.test(m[1]));
        if (posibles.length > 0) cae = posibles[posibles.length - 1][1];
    }

    // ── IMPORTE TOTAL ──────────────────────────────────────────────────────────
    // Formato argentino: "355.206,61" (punto=miles, coma=decimal)
    // La fila de totales tiene 4 columnas: Subtotal | Descuento | Impuestos | Total
    // En el texto plano quedan seguidas: "Total $ 289.256,19 $ 0,00 $ 65.950,42 $ 355.206,61"
    // → "Total NNN" captura el subtotal (primera columna), no el total final.
    // Por eso se toma directamente el máximo del documento, que siempre es el total.
    const REGEX_MONTO = /([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2})(?![0-9])/g;
    let importe = '';
    let maxMonto = 0;
    for (const m of [...plano.matchAll(REGEX_MONTO)]) {
        const val = parseFloat(limpiarImporte(m[1]));
        if (val > maxMonto && val < 5000000000) maxMonto = val;
    }
    if (maxMonto > 0) importe = maxMonto.toFixed(2);

    return {
        cuit, cae, fecha, importe, puntoVenta, numeroComprobante,
        tipoComprobanteTexto: 'facturas a',
        tipoEmisionTexto:     'electr',
    };
}

// ── Datos del anexo "Detalle de la Factura" ───────────────────────────────────
function extraerDatosAnexo(textoAnexo, importeFactura) {
    let gtin = '', serie = '', fechaPrescripcion = '', fechaDispensa = '', valorErogado = '';

    // ── GTIN y SERIE desde código de trazabilidad ──────────────────────────────
    // Ej: "077980353144859596730885" (24 dígitos) → GTIN(14) + Serie(10)
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
        fechaPrescripcion = fechaDispensa; // Varifarma no provee fecha de prescripción separada
    }

    // ── VALOR EROGADO (IMP. UNIT / Total general) ──────────────────────────────
    // "Total general 1 $ 289,256.19" (formato US: coma=miles, punto=decimal)
    const matchValor = textoAnexo.match(/Total\s+general[^0-9$]*\$?\s*([0-9]{1,3}(?:[.,][0-9]{3})*[.,][0-9]{2})(?![0-9])/i);
    if (matchValor) {
        valorErogado = limpiarImporte(matchValor[1]);
    } else {
        valorErogado = importeFactura || '';
    }

    return { gtin, serie, fechaPrescripcion, fechaDispensa, valorErogado };
}

module.exports = {
    CUIT: CUIT_VARIFARMA,
    nombre: 'Laboratorio Varifarma S.A.',
    detectar,
    extraerDatos,
    extraerDatosAnexo,
};
