// ============================================================
// parsers/pfizer.js — Parser específico para PFIZER S.R.L.
// ============================================================
// CUIT: 30-50351851-8 (30503518518)
//
// Layout (1 pág. factura + 1 pág. términos + 1 pág. anexo):
//   Pág. 1: Factura
//     - N°:    "NRO: 3026-00182455 / 1"  → PV=3026, comp=00182455
//              La barra " / 1" es número de página, NO parte del comprobante.
//     - Fecha: "FECHA: 17/12/2024"
//     - CAEA:  "C.A.E.A.N°: 34508314673084" al pie (anticipada)
//     - Total: "IMPORTE  426.549.490,40"  (formato AR: punto=miles, coma=decimal)
//              Aparece justo antes de la línea CAEA.
//   Pág. 2: Condiciones de pago (no tiene datos fiscales útiles)
//   Pág. 3: Anexo "DETALLE DE LA FACTURA: PFIZER S.R.L."
//     - Trazabilidad: GTIN (14 dígitos) + serie concatenados
//       ej. "07795381001328  80537636"  o  "077953810013288 0537636"
//       → GTIN=07795381001328, serie=80537636
//     - Nro. FACTURA: "A3026-00182455" (con prefijo "A")
//     - FECHA: "17/12/2024"
//     - IMP. UNIT.: "$ 516,233.36"  → valorErogado
//
// NOTA: "MEDIFARM" aparece como dirección de entrega → poner este parser
//       ANTES de medifarm en el array de parsers/index.js.
// ============================================================

const { limpiarImporte, normalizarTexto, textoEnLinea } = require('./utils');

const CUIT_PFIZER = '30503518518';

// ── Detección ─────────────────────────────────────────────────────────────────
function detectar(textoPlano) {
    if (textoPlano.includes(CUIT_PFIZER) || textoPlano.includes('30-50351851-8')) return true;
    if (/\bPFIZER\b/i.test(textoPlano)) return true;
    return false;
}

// ── Datos principales de la factura ───────────────────────────────────────────
function extraerDatos(textoOCR) {
    const texto = normalizarTexto(textoOCR);
    const plano = textoEnLinea(texto);

    const cuit = CUIT_PFIZER;

    // ── NÚMERO DE COMPROBANTE ────────────────────────────────────────────────
    // "NRO: 3026-00182455 / 1"  → ignorar la parte "/ 1" (número de página)
    let puntoVenta = '', numeroComprobante = '';
    const matchNro =
        plano.match(/NRO\s*:\s*([0-9]{4,5})\s*[-–—]\s*([0-9]{8})/i) ||
        plano.match(/FACTURA\s+[A-Z]?\s*([0-9]{4,5})\s*[-–—]\s*([0-9]{8})/i) ||
        plano.match(/(?<![0-9])([0-9]{4,5})\s*[-–—]\s*([0-9]{8})(?![0-9])/);
    if (matchNro) {
        puntoVenta        = matchNro[1];
        numeroComprobante = matchNro[2];
    }

    // ── FECHA ────────────────────────────────────────────────────────────────
    // "FECHA: 17/12/2024" en el bloque de encabezado
    let fecha = '';
    const matchFecha =
        plano.match(/FECHA\s*:\s*([0-9]{2})[\/\-.]+([0-9]{2})[\/\-.]+([0-9]{4})/i) ||
        plano.match(/(?<![0-9])([0-9]{2})[\/\-.]+([0-9]{2})[\/\-.]+([0-9]{4})(?![0-9])/);
    if (matchFecha) fecha = `${matchFecha[1]}/${matchFecha[2]}/${matchFecha[3]}`;

    // ── CAEA ─────────────────────────────────────────────────────────────────
    // "C.A.E.A.N°: 34508314673084" al pie de pág. 1
    let cae = '', esCaea = false;

    const matchCaea = plano.match(/C\.?A\.?E\.?A\.?\s*N?[°º*oO]?\s*:?\s*([0-9]{14})/i);
    if (matchCaea) {
        cae = matchCaea[1]; esCaea = true;
    } else {
        const matchCae = plano.match(/C\.?A\.?E\.?\s+N[°º*oO0]?\s*([0-9]{14})/i);
        if (matchCae) {
            cae = matchCae[1];
        } else {
            const posibles = [...plano.matchAll(/(?<![0-9])([0-9]{14})(?![0-9])/g)]
                .filter(m => !/^0/.test(m[1]));
            if (posibles.length > 0) cae = posibles[posibles.length - 1][1];
        }
    }

    // ── IMPORTE TOTAL ────────────────────────────────────────────────────────
    // El total "IMPORTE  426.549.490,40" aparece justo antes de la línea CAEA.
    const REGEX_MONTO = /([0-9]{1,3}(?:[.\-,\s][0-9]{3})+[.,][0-9]{2}|[0-9]{4,15}[.,][0-9]{2})(?![0-9])/g;
    let importe = '';

    // Estrategia 1: número grande justo antes de la línea "C.A.E.A"
    const idxCaeaStr = plano.search(/C\.?A\.?E\.?A/i);
    if (idxCaeaStr !== -1) {
        const antes = plano.substring(0, idxCaeaStr);
        const montos = [...antes.matchAll(REGEX_MONTO)];
        if (montos.length > 0) {
            const val = parseFloat(limpiarImporte(montos[montos.length - 1][1]));
            if (val > 0) importe = val.toFixed(2);
        }
    }

    // Estrategia 2: "IMPORTE" label seguido de número grande
    if (!importe) {
        // Buscar el IMPORTE que no sea el encabezado de columna
        for (const m of [...plano.matchAll(/\bIMPORTE\b[^0-9]{0,30}([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2})/gi)]) {
            const val = parseFloat(limpiarImporte(m[1]));
            if (val > 1000000) { importe = val.toFixed(2); break; }
        }
    }

    // Estrategia 3: ancla "Son Pesos"
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
    // Ej: "07795381001328  80537636"
    const matchTraz = textoAnexo.match(/(?<![0-9A-Za-z])([0-9]{14})([0-9]{6,16})(?![0-9A-Za-z])/);
    if (matchTraz) {
        gtin  = matchTraz[1];
        serie = matchTraz[2];
    }

    // Fecha: columna FECHA del anexo (única fecha disponible)
    const fechas = [...textoAnexo.matchAll(/([0-9]{2})[\/\-.]+([0-9]{2})[\/\-.]+([0-9]{4})/g)];
    if (fechas.length > 0) {
        fechaDispensa     = `${fechas[0][1]}/${fechas[0][2]}/${fechas[0][3]}`;
        fechaPrescripcion = fechaDispensa;
    }

    // Valor erogado: "$ 516,233.36" o "$ 516.233,36"
    const matchImp = textoAnexo.match(/\$\s*([0-9]{1,3}(?:[.,][0-9]{3})*[.,][0-9]{2}|[0-9]+[.,][0-9]{2})/);
    valorErogado = matchImp ? limpiarImporte(matchImp[1]) : (importeFactura || '');

    return { gtin, serie, fechaPrescripcion, fechaDispensa, valorErogado };
}

module.exports = {
    CUIT: CUIT_PFIZER,
    nombre: 'Pfizer S.R.L.',
    detectar,
    extraerDatos,
    extraerDatosAnexo,
};
