// ============================================================
// parsers/takeda.js — Parser para Takeda Argentina S.A.
// ============================================================
// CUIT: 30708282150 (30-70828215-0)
//
// Layout factura (1 hoja):
//   - Número:  "Nro. 0004-00031377" → puntoVenta=0004, comp=00031377
//   - Fecha:   "Fecha: 12/02/2026"
//   - CAE:     "C.A.E: 86073659185720 Vto: 22/02/2026"
//   - Total:   "1.407.713,07" (formato argentino: punto=miles, coma=decimal)
//   - IVA 21% (gravado) → tipoComp='facturas a', tipoEmision='electr'
//
// Layout anexo "Detalle de la Factura" (pág. 2 — tabla):
//   - Cod. Trazabilidad: "0779813334022540048369073011" (28 dígitos) → GTIN + Serie
//   - FECHA:    "12/02/2026" → fechaDispensa
//   - Total general: "1,161,479.44" → valorErogado
// ============================================================

const { limpiarImporte, normalizarTexto, textoEnLinea, REGEX_GTIN } = require('./utils');

const CUIT_TAKEDA = '30708282150';

// ── Detección ──────────────────────────────────────────────────────────────────
function detectar(textoPlano) {
    // CUIT con tolerancia a espacios/guiones/puntos del OCR
    if (/30[\s\-\.]*708[\s\-\.]*282[\s\-\.]*15[\s\-\.]*0(?![0-9])/.test(textoPlano)) return true;
    // "TAKEDA" es suficientemente único como identificador solo
    if (/\bTAKEDA\b/i.test(textoPlano)) return true;
    return false;
}

// ── Datos principales de la factura ───────────────────────────────────────────
function extraerDatos(textoOCR) {
    const texto = normalizarTexto(textoOCR);
    const plano = textoEnLinea(texto);

    const cuit = CUIT_TAKEDA;

    // ── NÚMERO DE COMPROBANTE ──────────────────────────────────────────────────
    // "Nro. 0004-00031377" o "FACTURA A Nro. 0004-00031377"
    let puntoVenta = '', numeroComprobante = '';
    const matchNro =
        plano.match(/Nro\.?\s*0*([0-9]{4,5})\s*[-–—]\s*0*([0-9]{7,8})(?![0-9])/i) ||
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
    // "C.A.E: 86073659185720 Vto: 22/02/2026"
    // El OCR puede partir el número: "86073659 185720" → reparar pegando dígitos
    let cae = '';
    const planoReparado = plano.replace(/(?<![0-9])([0-9]{6,13})\s+([0-9]{2,8})(?![0-9])/g, '$1$2');
    const matchCAE =
        planoReparado.match(/C\.?A\.?E\.?\s*:?\s*([0-9]{14})(?![0-9])/i) ||
        plano.match(/C\.?A\.?E\.?\s*:?\s*([0-9]{14})(?![0-9])/i);
    if (matchCAE) {
        cae = matchCAE[1];
    } else {
        const posibles = [...planoReparado.matchAll(/(?<![0-9])([0-9]{14})(?![0-9])/g)];
        if (posibles.length > 0) cae = posibles[posibles.length - 1][1];
    }

    // ── IMPORTE TOTAL ──────────────────────────────────────────────────────────
    // Formato argentino: "1.407.713,07" (punto=miles, coma=decimal)
    // Al pie: "Total 1.407.713,07"
    const REGEX_MONTO = /([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2})(?![0-9])/g;
    let importe = '';

    // Estrategia 1: línea "Total NNN" — tomar la última (más abajo en el doc)
    const allTotal = [...plano.matchAll(/\bTotal\b[^0-9]{0,5}([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2})/gi)];
    if (allTotal.length > 0) {
        const val = parseFloat(limpiarImporte(allTotal[allTotal.length - 1][1]));
        if (val > 0) importe = val.toFixed(2);
    }

    // Estrategia 2: máximo del documento (total > importe gravado + IVA parciales)
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
    // Ej: "0779813334022540048369073011" → GTIN(14) + Serie(14)
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
        fechaPrescripcion = fechaDispensa; // Takeda no provee fecha de prescripción separada
    }

    // ── VALOR EROGADO (Total general / IMP. UNIT) ──────────────────────────────
    // "Total general 1 $ 1,161,479.44"
    const matchValor = textoAnexo.match(/Total\s+general[^0-9$]*\$?\s*([0-9]{1,3}(?:[.,][0-9]{3})*[.,][0-9]{2})(?![0-9])/i);
    if (matchValor) {
        valorErogado = limpiarImporte(matchValor[1]);
    } else {
        valorErogado = importeFactura || '';
    }

    return { gtin, serie, fechaPrescripcion, fechaDispensa, valorErogado };
}

module.exports = {
    CUIT: CUIT_TAKEDA,
    nombre: 'Takeda Argentina S.A.',
    detectar,
    extraerDatos,
    extraerDatosAnexo,
};
