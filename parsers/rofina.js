// ============================================================
// parsers/rofina.js — Parser para Rofina S.A.I.C.F.
// ============================================================
// CUIT: 30538474858 (30-53847485-8)
//
// Layout factura (1 hoja):
//   - Número:  "N° 0015-01482513"  → puntoVenta=0015, comp=01482513
//   - Fecha:   "Fecha: 03/11/2025"
//   - CAE:     "C.A.E. Nro.: 75448326338791"
//   - Total:   "27.170.537,80" (formato argentino: punto=miles, coma=decimal)
//   - IVA 21% (gravado) → tipoComp='facturas a', tipoEmision='electr'
//
// Layout anexo "Detalle de la Factura" (pág. 2 — tabla):
//   - Cod. Trazabilidad: "0779816350101692344617750" (25 dígitos) → GTIN + Serie
//   - FECHA:    "03/11/2025" → fechaDispensa
//   - IMP. UNIT / Total general: "700,670.69" → valorErogado
// ============================================================

const { limpiarImporte, normalizarTexto, textoEnLinea, REGEX_GTIN } = require('./utils');

const CUIT_ROFINA = '30538474858';

// ── Detección ──────────────────────────────────────────────────────────────────
function detectar(textoPlano) {
    if (textoPlano.includes(CUIT_ROFINA) || textoPlano.includes('30-53847485-8')) return true;
    if (/\bROFINA\s+S\.?A\.?I\.?C\.?F\.?\b/i.test(textoPlano)) return true;
    return false;
}

// ── Datos principales de la factura ───────────────────────────────────────────
function extraerDatos(textoOCR) {
    const texto = normalizarTexto(textoOCR);
    const plano = textoEnLinea(texto);

    const cuit = CUIT_ROFINA;

    // ── NÚMERO DE COMPROBANTE ──────────────────────────────────────────────────
    // "N° 0015-01482513"
    let puntoVenta = '', numeroComprobante = '';
    const matchNro =
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

    // ── CAE ────────────────────────────────────────────────────────────────────
    // "C.A.E. Nro.: 75448326338791"
    let cae = '';
    const matchCAE = plano.match(/C\.?A\.?E\.?\s*(?:Nro\.?|N[°oº]\.?)?\s*:?\s*([0-9]{14})(?![0-9])/i);
    if (matchCAE) {
        cae = matchCAE[1];
    } else {
        const posibles = [...plano.matchAll(/(?<![0-9])([0-9]{14})(?![0-9])/g)]
            .filter(m => !/^0(?:779|080)/.test(m[1]));
        if (posibles.length > 0) cae = posibles[posibles.length - 1][1];
    }

    // ── IMPORTE TOTAL ──────────────────────────────────────────────────────────
    // Formato argentino: "27.170.537,80" (punto=miles, coma=decimal)
    // El total aparece como "TOTAL 27.170.537,80" al pie
    const REGEX_MONTO = /([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2})(?![0-9])/g;
    let importe = '';

    // Estrategia 1: "TOTAL NNN" (el total es la última mención de TOTAL)
    const allTotal = [...plano.matchAll(/\bTOTAL\b[^0-9]{0,5}([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2})/gi)];
    if (allTotal.length > 0) {
        const val = parseFloat(limpiarImporte(allTotal[allTotal.length - 1][1]));
        if (val > 0) importe = val.toFixed(2);
    }

    // Estrategia 2: máximo del documento (total > cualquier subtotal o percepción)
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
        tipoEmisionTexto:     'electr',
    };
}

// ── Datos del anexo "Detalle de la Factura" ───────────────────────────────────
function extraerDatosAnexo(textoAnexo, importeFactura) {
    let gtin = '', serie = '', fechaPrescripcion = '', fechaDispensa = '', valorErogado = '';

    // ── GTIN y SERIE desde código de trazabilidad ──────────────────────────────
    // El código completo es una secuencia de 20-30 dígitos que empieza con "0779"
    // Ej: "0779816350101692344617750" → GTIN(14) + Serie(11)
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
        fechaPrescripcion = fechaDispensa; // Rofina no provee fecha de prescripción separada
    }

    // ── VALOR EROGADO (IMP. UNIT / Total general) ──────────────────────────────
    // "Total general 1 700,670.69 $" o "Total general 1 $ 700,670.69"
    const matchValor = textoAnexo.match(/Total\s+general[^0-9$]*\$?\s*([0-9]{1,3}(?:[.,][0-9]{3})*[.,][0-9]{2})(?![0-9])/i);
    if (matchValor) {
        valorErogado = limpiarImporte(matchValor[1]);
    } else {
        valorErogado = importeFactura || '';
    }

    return { gtin, serie, fechaPrescripcion, fechaDispensa, valorErogado };
}

module.exports = {
    CUIT: CUIT_ROFINA,
    nombre: 'Rofina S.A.I.C.F.',
    detectar,
    extraerDatos,
    extraerDatosAnexo,
};
