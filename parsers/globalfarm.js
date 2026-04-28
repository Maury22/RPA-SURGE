// ============================================================
// parsers/globalfarm.js — Parser específico para GLOBALFARM S.A.
// ============================================================
// CUIT: 30-70098905-0 (30700989050)
//
// Layout (2 págs. factura + 1 pág. anexo):
//   Págs. 1-2: Factura
//     - N°:    "Factura: 0024-01583381"  (esquina sup. derecha)
//     - Fecha: "Fecha: 26/09/2025"
//     - CAEA:  "CAEA 35370853570582  Emisión: 16/09/2025"  al pie de ambas páginas
//              ► CAEA (anticipada)
//     - Total: "TOTAL  629.264.625,51"  en tabla de pág. 2
//              "Son Pesos seiscientos veintinueve millones..." también disponible
//   Pág. 3: Anexo "DETALLE DE LA FACTURA: GLOBALFARM SA."
//     - Trazabilidad: GTIN (14 dígitos) + serie concatenados
//       ej. "07793081098495100405518590" → GTIN=07793081098495, serie=100405518590
//     - Nro. FACTURA: "0024-01583381"
//     - FECHA: "26/09/2025"
//     - IMP. UNIT.: "$ 10,532,236.12"  → valorErogado
//
// NOTA: El pie de la factura dice "Venta realizada por cuenta y orden de:
//       MSD Argentina S.R.L. CUIT: 30-50340307-9". Globalfarm opera como
//       intermediario de MSD (Merck Sharp & Dohme).
//       "SCIENZA" aparece como dirección de entrega → poner este parser
//       ANTES de medifarm en el array de parsers/index.js.
// ============================================================

const { limpiarImporte, normalizarTexto, textoEnLinea } = require('./utils');

const CUIT_GLOBALFARM = '30700989050';

// ── Detección ─────────────────────────────────────────────────────────────────
function detectar(textoPlano) {
    if (textoPlano.includes(CUIT_GLOBALFARM) || textoPlano.includes('30-70098905-0')) return true;
    if (/\bGLOBALFARM\b/i.test(textoPlano)) return true;
    return false;
}

// ── Datos principales de la factura ───────────────────────────────────────────
function extraerDatos(textoOCR) {
    const texto = normalizarTexto(textoOCR);
    const plano = textoEnLinea(texto);

    const cuit = CUIT_GLOBALFARM;

    // ── NÚMERO DE COMPROBANTE ────────────────────────────────────────────────
    // "Factura: 0024-01583381"  en la esquina superior derecha
    let puntoVenta = '', numeroComprobante = '';
    const matchNro =
        plano.match(/Factura\s*:\s*([0-9]{4,5})\s*[-–—]\s*([0-9]{8})/i) ||
        plano.match(/(?<![0-9])([0-9]{4,5})\s*[-–—]\s*([0-9]{8})(?![0-9])/);
    if (matchNro) {
        puntoVenta        = matchNro[1];
        numeroComprobante = matchNro[2];
    }

    // ── FECHA ────────────────────────────────────────────────────────────────
    // "Fecha: 26/09/2025" en el encabezado
    let fecha = '';
    const matchFecha =
        plano.match(/\bFecha\s*:\s*([0-9]{2})[\/\-.]+([0-9]{2})[\/\-.]+([0-9]{4})/i) ||
        plano.match(/(?<![0-9])([0-9]{2})[\/\-.]+([0-9]{2})[\/\-.]+([0-9]{4})(?![0-9])/);
    if (matchFecha) fecha = `${matchFecha[1]}/${matchFecha[2]}/${matchFecha[3]}`;

    // ── CAEA ─────────────────────────────────────────────────────────────────
    // "CAEA 35370853570582  Emisión: 16/09/2025"  al pie de cada página
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
    // "TOTAL  629.264.625,51" en la tabla de totales de pág. 2
    const REGEX_MONTO = /([0-9]{1,3}(?:[.\-,\s][0-9]{3})+[.,][0-9]{2}|[0-9]{4,15}[.,][0-9]{2})(?![0-9])/g;
    let importe = '';

    // Estrategia 1: "TOTAL" con valor > 10M
    // La factura tiene "Total Imp.Bruto: 979M", "Total Descuentos: 470M", percepciones (231K, 7.6M, 5M).
    // El total real es "TOTAL  629.264.625,51". Al exigir val > 10M se descartan las percepciones
    // automáticamente sin necesidad de enumerar qué labels excluir.
    // Se usa matchAll + loop (no .match()) para tolerar column-gaps > 30 chars y separadores distintos.
    const reTotalCandidato = /\bTOTAL\b(?!\s*(?:Imp\.?|Descuento|Bruto|Unidades|IMP))[^0-9]{0,60}([0-9]{1,3}(?:[.,\s][0-9]{3})+[.,][0-9]{2}|[0-9]{5,}[.,][0-9]{2})/gi;
    for (const m of [...plano.matchAll(reTotalCandidato)]) {
        const val = parseFloat(limpiarImporte(m[1]));
        if (val > 10000000 && val < 5000000000) { importe = val.toFixed(2); break; }
    }

    // Estrategia 2: ancla "Son Pesos" — tomar el ÚLTIMO monto > 10M antes del texto en letras
    if (!importe) {
        const idxSP = plano.search(/Son\s+Pesos\b/i);
        if (idxSP !== -1) {
            const montos = [...plano.substring(0, idxSP).matchAll(REGEX_MONTO)];
            for (let i = montos.length - 1; i >= 0; i--) {
                const val = parseFloat(limpiarImporte(montos[i][1]));
                if (val > 10000000) { importe = val.toFixed(2); break; }
            }
        }
    }

    // Estrategia 3: "Importe Total" en la tabla de vencimiento (el total se repite dos veces)
    if (!importe) {
        for (const m of [...plano.matchAll(/Importe\s+Total\b[^0-9]{0,60}/gi)]) {
            const ventana = plano.substring(m.index + m[0].length, m.index + m[0].length + 30);
            const matchNum = ventana.match(/([0-9]{1,3}(?:[.,\s][0-9]{3})+[.,][0-9]{2}|[0-9]{5,}[.,][0-9]{2})/);
            if (matchNum) {
                const val = parseFloat(limpiarImporte(matchNum[1]));
                if (val > 10000000 && val < 5000000000) { importe = val.toFixed(2); break; }
            }
        }
    }

    // Estrategia 4: máximo numérico (excluyendo Total Imp.Bruto que es el bruto antes de descuentos)
    if (!importe) {
        let maxMonto = 0;
        // Excluir la zona "Total Imp.Bruto ... Total Descuentos" del cálculo del máximo
        const planoSinBruto = plano.replace(/Total\s+Imp\.?Bruto[^0-9]{0,20}[0-9,. ]+/gi, '');
        for (const m of [...planoSinBruto.matchAll(REGEX_MONTO)]) {
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
    // Ej: "07793081098495100405518590" → GTIN=07793081098495, serie=100405518590
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

    // Valor erogado: "$ 10,532,236.12"
    const matchImp = textoAnexo.match(/\$\s*([0-9]{1,3}(?:[.,][0-9]{3})*[.,][0-9]{2}|[0-9]+[.,][0-9]{2})/);
    valorErogado = matchImp ? limpiarImporte(matchImp[1]) : (importeFactura || '');

    return { gtin, serie, fechaPrescripcion, fechaDispensa, valorErogado };
}

module.exports = {
    CUIT: CUIT_GLOBALFARM,
    nombre: 'Globalfarm S.A.',
    detectar,
    extraerDatos,
    extraerDatosAnexo,
};
