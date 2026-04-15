// ============================================================
// parsers/orien.js — Parser para ORIEN S.A. y ORIEN ARGENTINA S.A.
// ============================================================
// CUITs conocidos:
//   30686262312  → ORIEN S.A.         (30-68626231-2)
//   30711534616  → ORIEN ARGENTINA S.A. (30-71153461-6)
//
// VARIANTES DE FACTURA:
//   1. "FACTURA A"                      (CAEA) → tipoComp='facturas a', tipoEmision='anticipada'
//   2. "FACTURA A"                      (CAE)  → tipoComp='facturas a', tipoEmision='electr'
//   3. "Factura Electrónica OASA - FdeC A" (CAE)  → tipoComp='mipyme',     tipoEmision='electr'
//      "FdeC" = Factura de Crédito Electrónica MiPyME.
//
// El tipo se determina por la etiqueta explícita del pie: "Número CAEA" vs "Número CAE".
//
// ADVERTENCIA OCR CONOCIDA:
//   La tipografía del encabezado de Orien hace que Tesseract lea
//   "N° 1045-00494024" como "AAEM" (garbage total).
//   Por eso el número de comprobante se extrae del ANEXO (pág. 4),
//   que tiene una tabla limpia con "FA1045" y "494024".
//   El server inyecta el texto del anexo como contexto adicional
//   cuando los campos faltan en el texto principal.
//
// Layout factura (págs. 1-3):
//   - CUIT: 30686262312 o 30711534616 en cada encabezado
//   - Fecha: "Fecha: 10/07/2025"
//   - CAEA al pie de pág. 3 (layout 2 columnas + QR):
//       "Número CAEA:" → "35262908510644"
//       El QR code produce ruido entre etiqueta y número.
//   - CAE estándar (variante FdeC): "Número CAE: 75406028711701"
//   - Total: "ARS 164,445,636.05" o "TOTAL ARS 201,473,998.75" (US format: coma=miles, punto=decimal)
//
// Layout anexo "Detalle de consumos" (pág. 4 — tabla estructurada):
//   - "Codigo Factura  FA1045   494024"  → puntoVenta=1045, comp=00494024
//   - "Codigo Factura  FA0139   598"     → puntoVenta=0139, comp=00000598  (comp puede ser 3+ dígitos)
//   - "Fecha RX  2025-06-09"             → prescripción
//   - "Fecha Factura  2025-07-10"        → dispensa
//   - "MODULO_PRECIO_1  437097.87"       → valorErogado
//   - "PRODUCTOS_GTIN_PRODUCTO_1  7795..." → gtin
//   - "PRODUCTOS_SERIE_PRODUCTO_1  430..." → serie
// ============================================================

const { limpiarImporte, normalizarTexto, textoEnLinea, REGEX_GTIN } = require('./utils');

const CUIT_ORIEN     = '30686262312';  // ORIEN S.A.
const CUIT_ORIEN_ARG = '30711534616';  // ORIEN ARGENTINA S.A.

// ── Detección ─────────────────────────────────────────────────────────────────
function detectar(textoPlano) {
    if (textoPlano.includes(CUIT_ORIEN)     || textoPlano.includes('30-68626231-2')) return true;
    if (textoPlano.includes(CUIT_ORIEN_ARG) || textoPlano.includes('30-71153461-6')) return true;
    if (/\bORIEN\s+(?:ARGENTINA\s+)?S\.?A\.?\b/i.test(textoPlano)) return true;
    if (/\bORIEN\b/i.test(textoPlano) && /orien\.com\.ar/i.test(textoPlano)) return true;
    return false;
}

// ── Datos principales de la factura ───────────────────────────────────────────
function extraerDatos(textoOCR) {
    const texto = normalizarTexto(textoOCR);   // multilinea normalizado
    const plano = textoEnLinea(texto);          // una sola línea

    // Detectar cuál de los dos CUITs de Orien es este documento.
    // REGLA: FACTURA MIPYME (FdeC / OASA) → ORIEN ARGENTINA S.A. (30711534616)
    //        FACTURA A normal              → ORIEN S.A.           (30686262312)
    // Se usa el tipo de factura porque el texto "FdeC"/"OASA" es más confiable
    // en OCR que intentar leer los dígitos del CUIT con posibles espacios/ruido.
    const esMipyme = /\bFdeC\b/i.test(plano) || /\bOASA\b/i.test(plano);
    const cuit = esMipyme ? CUIT_ORIEN_ARG : CUIT_ORIEN;

    // -------------------------------------------------------------------------
    // NÚMERO DE COMPROBANTE
    //
    // PROBLEMA CONOCIDO: Tesseract lee "N° 1045-00494024" como "AAEM" (garbage)
    // porque la fuente estilizada del header no es reconocible.
    //
    // SOLUCIÓN: extraer del ANEXO (el server pasa textoAnexo combinado en el retry).
    // El anexo tiene formato de tabla:
    //   "Codigo Factura  FA1045  494024"
    //   o   "FA1045    494024   46120012  ..."
    // -------------------------------------------------------------------------
    let puntoVenta = '', numeroComprobante = '';

    // Patrón 1: "FACTURA A/B XXXX-YYYYYYYY" (si el OCR lo captura bien)
    let matchNro = plano.match(/FACTURA\s+[AB]\s+([0-9]{4,5})\s*[-–—]\s*([0-9]{8})/i);

    // Patrón 2: "N° XXXX-YYYYYYYY" o "N* XXXX-YYYYYYYY"
    if (!matchNro) matchNro = plano.match(/N[°*º2oO]\s*([0-9]{4,5})\s*[-–—]\s*([0-9]{8})(?![0-9])/i);

    // Patrón 3: barcode visual "FA104500494024" (PV + comp concatenados)
    if (!matchNro) {
        const matchBarcode = plano.match(/\*?FA0*([0-9]{4,5})([0-9]{8})\*?/i);
        if (matchBarcode) matchNro = matchBarcode;
    }

    // Patrón 4: tabla del ANEXO → "FA1045  494024" o "FA0139  598"
    // El comp viene SIN ceros al frente y puede ser desde 3 dígitos (598 → 00000598)
    if (!matchNro) {
        const matchFA = plano.match(/\bFA0*([0-9]{3,5})\s+([0-9]{3,8})(?!\s*[-–—])/i);
        if (matchFA) {
            puntoVenta        = matchFA[1];
            numeroComprobante = matchFA[2].padStart(8, '0');
            matchNro = null; // ya asignados, no procesar abajo
        }
    }

    // Patrón 5: "Factura:\s* 494024" → solo número, buscar PV por separado
    if (!matchNro && !numeroComprobante) {
        const matchFacNum = plano.match(/Factura\s*[:\-]?\s*([0-9]{6,8})(?![0-9])/i);
        if (matchFacNum) numeroComprobante = matchFacNum[1].padStart(8, '0');
    }

    // Patrón 6: línea aislada "XXXX-YYYYYYYY" en texto multilinea
    if (!matchNro && !puntoVenta) {
        for (const linea of texto.split('\n')) {
            const m = linea.trim().match(/^([0-9]{4,5})\s*[-–—]\s*([0-9]{8})$/);
            if (m) { matchNro = m; break; }
        }
    }

    // Patrón 7: cualquier "XXXX-YYYYYYYY" genérico
    if (!matchNro && !puntoVenta) {
        matchNro = plano.match(/(?<![0-9])([0-9]{4,5})\s*[-–—]\s*([0-9]{8})(?![0-9])/);
    }

    if (matchNro) {
        puntoVenta        = matchNro[1];
        numeroComprobante = matchNro[2];
    }

    // -------------------------------------------------------------------------
    // FECHA
    // -------------------------------------------------------------------------
    let fecha = '';
    const matchFecha =
        plano.match(/Fecha\s*:\s*([0-9]{2})[\s\/\-.]+([0-9]{2})[\s\/\-.]+([0-9]{4})/i) ||
        plano.match(/(?<![0-9])([0-9]{2})[\s\/\-.]+([0-9]{2})[\s\/\-.]+([0-9]{4})(?![0-9])/);
    if (matchFecha) fecha = `${matchFecha[1]}/${matchFecha[2]}/${matchFecha[3]}`;

    // -------------------------------------------------------------------------
    // CAEA / CAE
    //
    // Tres variantes observadas:
    //   1. "Número CAEA: 35262908510644" → esCaea=true,  tipoEmision='anticipada'
    //   2. "Número CAE:  75496283998691" → esCaea=false, tipoEmision='electr' (FdeC)
    //   3. "Número CAE:  75492274576665" → esCaea=false, tipoEmision='electr' (Factura A)
    //
    // BUG ANTERIOR: /C\.?A\.?E\.?A\.?/i matcheaba "CAE" (la A final es opcional),
    // causando esCaea=true en facturas con CAE simple → tipoEmision='anticipada' erróneo.
    //
    // FIX: detectar tipo por etiqueta explícita ("Número CAEA" vs "Número CAE").
    //
    // PROBLEMA OCR CONOCIDO: el QR entre la etiqueta y el número produce ruido.
    // SOLUCIÓN: reparar fracturas (1+13 / 2+12 dígitos) antes de buscar 14 dígitos.
    // -------------------------------------------------------------------------
    let cae = '';
    // Detectar tipo por etiqueta explícita: "CAEA" (4 letras fijas) vs "CAE" (3 letras)
    const esCaea = /N[uú]mero\s+CAEA\b|Pedido\s+CAEA\b/i.test(plano);

    // Regex de la etiqueta correcta para buscar en texto multilinea
    const labelRegex = esCaea
        ? /N[uú]mero\s+CAEA\b|Pedido\s+CAEA\b/i
        : /N[uú]mero\s+CAE\b/i;

    // Estrategia A: multilinea — ventana de 600 chars desde la etiqueta, reparando fractura OCR
    const idxLabel = texto.search(labelRegex);
    if (idxLabel !== -1) {
        let ventana = texto.substring(idxLabel, idxLabel + 600);
        // Reparar fractura OCR: 1+13 o 2+12 dígitos separados por blancos → 14 dígitos
        ventana = ventana.replace(/(?<![0-9])([0-9]{1,2})\s+([0-9]{12,13})(?![0-9])/g, '$1$2');
        const m14 = ventana.match(/(?<![0-9])([0-9]{14})(?![0-9])/);
        if (m14) cae = m14[1];
    }

    // Estrategia B: plano — etiqueta + hasta 80 chars de ruido + 14 dígitos
    if (!cae) {
        const reB = esCaea
            ? /CAEA[^0-9]{0,80}([0-9]{14})(?![0-9])/i
            : /N[uú]mero\s+CAE[^A0-9][^0-9]{0,80}([0-9]{14})(?![0-9])/i;
        const mB = plano.match(reB);
        if (mB) cae = mB[1];
    }

    // Estrategia C: último recurso — último número de 14 dígitos en todo el texto
    if (!cae) {
        const posibles = [...plano.matchAll(/(?<![0-9])([0-9]{14})(?![0-9])/g)];
        if (posibles.length > 0) cae = posibles[posibles.length - 1][1];
    }

    // -------------------------------------------------------------------------
    // IMPORTE TOTAL
    //
    // PROBLEMA: el layout de dos columnas en Orien produce OCR en orden
    // impredecible. "Son Pesos:", "TOTAL", y los montos pueden aparecer
    // en cualquier secuencia según cómo Tesseract interpreta las columnas.
    //
    // PROPIEDAD CONFIABLE: el total (subtotal + percepciones) siempre es
    // el NÚMERO MÁS GRANDE del documento. Los ítems individuales, subtotales
    // parciales y percepciones son siempre menores.
    //   Ej: MHIVB1 fila = 390,869,576.28 < Total = 412,692,535.53 ✓
    //
    // Estrategia 1: "número\nTOTAL" — ÚLTIMA ocurrencia (evita el header
    //   de columna "TOTAL" que aparece en cada página de la tabla).
    // Estrategia 2: máximo del documento entero (respaldo si el OCR
    //   rompe la adyacencia número↔TOTAL).
    // -------------------------------------------------------------------------
    const REGEX_MONTO = /([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2}|[0-9]{4,15}[.,][0-9]{2})(?![0-9])/g;
    let importe = '';

    // "transporte: NNN" es el carry-forward acumulado entre páginas del detalle.
    // Puede ser MAYOR que el total real (ej: 254M carry-forward vs 164M total final)
    // porque en el último tramo solo se agregan ítems pequeños.
    // → Eliminarlo de ambas versiones del texto antes de buscar el importe.
    const textoSinTransp = texto.replace(/transporte\s*:\s*[0-9.,]+/gi, '');
    const planoSinTransp = plano.replace(/transporte\s*:\s*[0-9.,]+/gi, '');

    // Estrategia 1: ÚLTIMA ocurrencia de "número\nTOTAL" (sin carry-forward)
    const allAnteTOTAL = [...textoSinTransp.matchAll(/([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2})\s*\n\s*TOTAL\b/gi)];
    if (allAnteTOTAL.length > 0) {
        const val = parseFloat(limpiarImporte(allAnteTOTAL[allAnteTOTAL.length - 1][1]));
        if (val > 0) importe = val.toFixed(2);
    }

    // Estrategia 2: máximo en el documento sin carry-forward
    // El total (subtotal + percepciones) siempre supera cualquier ítem individual en Orien
    if (!importe) {
        let maxMonto = 0;
        for (const m of [...planoSinTransp.matchAll(REGEX_MONTO)]) {
            const val = parseFloat(limpiarImporte(m[1]));
            if (val > maxMonto && val < 5000000000) maxMonto = val;
        }
        if (maxMonto > 0) importe = maxMonto.toFixed(2);
    }

    // -------------------------------------------------------------------------
    // TIPO DE COMPROBANTE Y EMISIÓN
    // -------------------------------------------------------------------------
    // esMipyme ya fue calculado arriba para el CUIT — lo reusamos aquí
    const tipoComprobanteTexto = esMipyme ? 'mipyme' : 'facturas a';
    const tipoEmisionTexto     = esCaea ? 'anticipada' : 'electr';

    return { cuit, cae, fecha, importe, puntoVenta, numeroComprobante, tipoComprobanteTexto, tipoEmisionTexto };
}

// ── Datos del anexo "Detalle de consumos" ─────────────────────────────────────
function extraerDatosAnexo(textoAnexo, importeFactura) {
    let gtin = '', serie = '', fechaPrescripcion = '', fechaDispensa = '', valorErogado = '';

    // --- GTIN ---
    const matchGtinLabel = textoAnexo.match(/PRODUCTOS_GTIN_PRODUCTO_1\s+([0-9]{13,14})/i);
    if (matchGtinLabel) {
        gtin = matchGtinLabel[1];
    } else {
        const matchGtin = textoAnexo.match(REGEX_GTIN);
        if (matchGtin) gtin = matchGtin[1];
    }

    // --- SERIE ---
    const matchSerieLabel = textoAnexo.match(/PRODUCTOS_SERIE_PRODUCTO_1\s+([A-Za-z0-9]{5,30})/i);
    if (matchSerieLabel) {
        serie = matchSerieLabel[1];
        if (/^6\d{6,}/.test(serie)) serie = 'G' + serie.substring(1);
    }
    if (!serie && gtin) {
        const regexPost = new RegExp(
            gtin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s|\\-.,]*([A-Za-z0-9]{5,30})'
        );
        const m = textoAnexo.match(regexPost);
        if (m) {
            serie = m[1];
            if (/^6\d{6,}/.test(serie)) serie = 'G' + serie.substring(1);
        }
    }

    // --- FECHAS (ISO YYYY-MM-DD → dd/mm/yyyy) ---
    const matchRX       = textoAnexo.match(/Fecha\s+RX[^\d]*(\d{4})-(\d{2})-(\d{2})/i);
    if (matchRX) fechaPrescripcion = `${matchRX[3]}/${matchRX[2]}/${matchRX[1]}`;

    const matchFacFecha = textoAnexo.match(/Fecha\s+Factura[^\d]*(\d{4})-(\d{2})-(\d{2})/i);
    if (matchFacFecha) fechaDispensa = `${matchFacFecha[3]}/${matchFacFecha[2]}/${matchFacFecha[1]}`;

    // Fallback: cualquier fecha ISO en el texto
    if (!fechaPrescripcion || !fechaDispensa) {
        const isoFechas = [...textoAnexo.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)];
        if (isoFechas.length >= 2) {
            if (!fechaPrescripcion) fechaPrescripcion = `${isoFechas[0][3]}/${isoFechas[0][2]}/${isoFechas[0][1]}`;
            if (!fechaDispensa)     fechaDispensa     = `${isoFechas[1][3]}/${isoFechas[1][2]}/${isoFechas[1][1]}`;
        } else if (isoFechas.length === 1) {
            const f = `${isoFechas[0][3]}/${isoFechas[0][2]}/${isoFechas[0][1]}`;
            if (!fechaPrescripcion) fechaPrescripcion = f;
            if (!fechaDispensa)     fechaDispensa     = f;
        }
    }

    // --- VALOR EROGADO ---
    const matchModulo = textoAnexo.match(/MODULO_PRECIO_1\s+([0-9]+[.,][0-9]{2})/i);
    valorErogado = matchModulo ? limpiarImporte(matchModulo[1]) : (importeFactura || '');

    return { gtin, serie, fechaPrescripcion, fechaDispensa, valorErogado };
}

module.exports = {
    CUIT: CUIT_ORIEN,
    nombre: 'Orien S.A.',
    // Flag para el servidor: el OCR del pie de página de Orien es ruidoso (QR + hash de firma).
    // Cuando el OCR devuelve 'electr', el servidor debe verificar con pdftotext antes de confiar.
    caeaPosible: true,
    detectar,
    extraerDatos,
    extraerDatosAnexo,
};
