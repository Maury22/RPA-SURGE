// ============================================================
// parsers/abbvie.js — Parser específico para ABBVIE S.A.
// ============================================================
// CUIT: 30-71239962-3 (30712399623)
//
// Layout típico de factura:
//   - "Nro. FACTURA   0003-00068098"
//   - "FECHA          16.05.2025"  (puntos como separadores)
//   - "CAE N°: 75203589312414"    (CAE estándar, no CAEA)
//   - "VALOR TOTAL    320.490.906,09"
//   - Tipo: Factura A
//
// Trampa OCR conocida:
//   - El domicilio de entrega incluye "SWISS MEDICAL SA SCIENZA -HORNOS",
//     lo cual dispararía un falso positivo en medifarm.detectar() si
//     este parser no se evalúa antes.
//
// Anexo/detalle de trazabilidad:
//   - Encabezado: "DETALLE DE LA FACTURA: ABBVIE SA."
//   - GTIN: 14 dígitos (ej. 08054083017648) — empieza con "080"
//   - Serie: numérica larga (ej. 134131549612)
//   - Importe en formato US: "$ 350,626.43" (coma=miles, punto=decimal)
//   - Fechas de Prescripción y Dispensa: DD/MM/YYYY
// ============================================================

const { limpiarImporte, normalizarTexto, textoEnLinea } = require('./utils');

const CUIT_ABBVIE = '30712399623';

// GTIN de 14 dígitos que empieza con "080" (AbbVie usa prefijo 080)
// REGEX_GTIN de utils solo captura 13 chars para este prefijo, por eso regex propio
const REGEX_GTIN_ABBVIE = /(?<![0-9])(0(?:77|80)[0-9]{11})(?![0-9])/;

function detectar(textoPlano) {
    if (textoPlano.includes(CUIT_ABBVIE) || textoPlano.includes('30-71239962-3')) return true;
    if (/\bABBVIE\b/i.test(textoPlano)) return true;
    return false;
}

function extraerDatos(textoOCR) {
    const texto = normalizarTexto(textoOCR);
    const plano = textoEnLinea(texto);

    // --- CUIT (hardcodeado) ---
    const cuit = CUIT_ABBVIE;

    // --- NÚMERO DE COMPROBANTE ---
    // Layout: "Nro. FACTURA   0003-00068098"
    let puntoVenta = '', numeroComprobante = '';
    const matchNro =
        plano.match(/(?:Nro\.?\s*FACTURA|FACTURA\s*N[°º]?)\s*[:\-]?\s*([0-9]{4,5})\s*[-–—]\s*([0-9]{8})/i) ||
        plano.match(/(?<![0-9])([0-9]{4})\s*[-–—]\s*([0-9]{8})(?![0-9])/);
    if (matchNro) {
        puntoVenta       = matchNro[1];
        numeroComprobante = matchNro[2];
    }

    // --- FECHA DE EMISIÓN ---
    // La fecha de la factura está en la misma fila que el Nro. FACTURA.
    // Buscamos la fecha inmediatamente DESPUÉS del comprobante para evitar
    // capturar "FECHA DE VENCIMIENTO" (14.08.2025) que también tiene "FECHA".
    let fecha = '';
    if (puntoVenta && numeroComprobante) {
        const rePost = new RegExp(
            puntoVenta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
            '\\s*[-–—]\\s*' +
            numeroComprobante.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
            '[^0-9]{1,40}([0-9]{2})[.\\/-]([0-9]{2})[.\\/-]([0-9]{4})'
        );
        const mPost = plano.match(rePost);
        if (mPost) fecha = `${mPost[1]}/${mPost[2]}/${mPost[3]}`;
    }
    if (!fecha) {
        // Fallback: "FECHA" que NO sea "FECHA DE ..."
        const mFecha = plano.match(/\bFECHA\b(?!\s+DE\b)[^0-9]{0,30}([0-9]{2})[.\/-]([0-9]{2})[.\/-]([0-9]{4})/i);
        if (mFecha) fecha = `${mFecha[1]}/${mFecha[2]}/${mFecha[3]}`;
    }
    if (!fecha) {
        const mFecha = plano.match(/(?<![0-9])([0-9]{2})[.\/-]([0-9]{2})[.\/-]([0-9]{4})(?![0-9])/);
        if (mFecha) fecha = `${mFecha[1]}/${mFecha[2]}/${mFecha[3]}`;
    }

    // --- CAE ---
    // Layout: "CAE N°: 75203589312414"
    // TRAMPA OCR: el símbolo "°" puede leerse como "'", "2", etc., rompiendo
    // patrones estrictos como N[°º]?. Usamos [^0-9\n]{0,15} para ignorar
    // cualquier ruido entre la palabra CAE/CAEA y los 14 dígitos.
    // El GTIN del anexo (08054083017648) también tiene 14 dígitos, por lo que
    // el fallback genérico NO se usa; solo matcheamos con el label explícito.
    let cae = '';
    let esCaea = false;
    const matchCaea = plano.match(/\bCAEA\b[^0-9\n]{0,15}([0-9]{14})/i);
    if (matchCaea) {
        cae    = matchCaea[1];
        esCaea = true;
    } else {
        const matchCae = plano.match(/\bCAE\b[^0-9\n]{0,15}([0-9]{14})/i);
        if (matchCae) cae = matchCae[1];
    }

    // --- IMPORTE TOTAL ---
    // Layout: "VALOR TOTAL   320.490.906,09"
    let importe = '';
    const matchTotal = plano.match(/VALOR\s*TOTAL\s*[:\-]?\s*([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2}|[0-9]{4,}[.,][0-9]{2})/i);
    if (matchTotal) {
        importe = limpiarImporte(matchTotal[1]);
    }

    if (!importe) {
        // Fallback: el mayor monto en formato argentino (punto=miles, coma=decimal)
        const todosMontos = [...plano.matchAll(/([0-9]{1,3}(?:\.[0-9]{3})+,[0-9]{2})(?![0-9])/g)];
        let maxMonto = 0;
        for (const m of todosMontos) {
            const val = parseFloat(limpiarImporte(m[1]));
            if (val > maxMonto) maxMonto = val;
        }
        if (maxMonto > 0) importe = maxMonto.toFixed(2);
    }

    // --- TIPO ---
    const tipoComprobanteTexto = 'facturas a';
    const tipoEmisionTexto     = esCaea ? 'anticipada' : 'electr';

    return { cuit, cae, fecha, importe, puntoVenta, numeroComprobante, tipoComprobanteTexto, tipoEmisionTexto };
}

function extraerDatosAnexo(textoAnexo, importeFactura) {
    let gtin = '', serie = '', fechaPrescripcion = '', fechaDispensa = '', valorErogado = '';

    // --- GTIN (14 dígitos, prefijo 080) ---
    const matchGtin = textoAnexo.match(REGEX_GTIN_ABBVIE);
    if (matchGtin) gtin = matchGtin[1];

    // --- SERIE (número largo después del GTIN en la tabla) ---
    if (gtin) {
        const regexSeriePost = new RegExp(
            gtin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s|\\-.,]*([A-Za-z0-9]{5,20})'
        );
        const matchSerie = textoAnexo.match(regexSeriePost);
        if (matchSerie) serie = matchSerie[1];
    }
    if (!serie) {
        // Fallback: primer bloque alfanumérico o numérico largo (≥8 dígitos) en el anexo
        const matchSerieFallback = textoAnexo.match(/(?<![0-9])([0-9]{8,20})(?![0-9])/);
        if (matchSerieFallback && matchSerieFallback[1] !== gtin) serie = matchSerieFallback[1];
    }

    // --- FECHAS: Prescripción y Dispensa ---
    // El anexo usa formato DD/MM/YYYY
    const regexFecha = /([0-9]{2})[\/\-]([0-9]{2})[\/\-]([0-9]{4})/g;
    const idxPresc = textoAnexo.toLowerCase().indexOf('prescrip');
    if (idxPresc !== -1) {
        const despues = textoAnexo.substring(idxPresc);
        const fechas  = [...despues.matchAll(regexFecha)];
        if (fechas.length >= 2) {
            fechaPrescripcion = `${fechas[0][1]}/${fechas[0][2]}/${fechas[0][3]}`;
            fechaDispensa     = `${fechas[1][1]}/${fechas[1][2]}/${fechas[1][3]}`;
        } else if (fechas.length === 1) {
            fechaPrescripcion = `${fechas[0][1]}/${fechas[0][2]}/${fechas[0][3]}`;
        }
    }
    if (!fechaPrescripcion || !fechaDispensa) {
        const todasFechas = [...textoAnexo.matchAll(regexFecha)];
        if (todasFechas.length >= 2) {
            const f1 = todasFechas[todasFechas.length - 2];
            const f2 = todasFechas[todasFechas.length - 1];
            fechaPrescripcion = `${f1[1]}/${f1[2]}/${f1[3]}`;
            fechaDispensa     = `${f2[1]}/${f2[2]}/${f2[3]}`;
        }
    }

    // --- IMPORTE EROGADO ---
    // El anexo usa formato US: "$ 350,626.43" (coma=miles, punto=decimal)
    const matchUS = textoAnexo.match(/\$\s*([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2})/);
    if (matchUS) {
        // Quitar separadores de miles (comas) y dejar el punto decimal
        valorErogado = matchUS[1].replace(/,/g, '');
    } else {
        // Fallback: buscar formato argentino en el anexo
        const matchAR = textoAnexo.match(/([0-9]{1,3}(?:\.[0-9]{3})+,[0-9]{2}|[0-9]+,[0-9]{2})/);
        if (matchAR) valorErogado = limpiarImporte(matchAR[1]);
        else valorErogado = importeFactura || '';
    }

    return { gtin, serie, fechaPrescripcion, fechaDispensa, valorErogado };
}

module.exports = { CUIT: CUIT_ABBVIE, nombre: 'AbbVie S.A.', detectar, extraerDatos, extraerDatosAnexo };
