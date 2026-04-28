// ============================================================
// parsers/montpellier.js — Parser específico para QUIMICA MONTPELLIER S.A.
// ============================================================
// CUIT conocido: 30-53599454-0 (30535994540)
//
// Layout típico:
//   Página 1: Factura con datos fiscales, detalle de productos, totales
//   Página 2: Anexo "DETALLE DE LA FACTURA" con GTIN, serie, fechas
//
// Datos a extraer de Página 1:
//   - Nro factura (punto de venta + número): "N° 0035 - 00000410"
//   - Fecha de emisión: "FECHA: 05/08/2025"
//   - Total Documento: línea "TOTAL DOCUMENTO 462.692.614,86"
//   - CAE: "CAE 75310081545691"
//   - Tipo: si dice "MiPyME" → mipyme, sino "facturas a"
//   - Emisión: si dice "CAEA" → anticipada, sino "electr"
//
// Datos a extraer de Página 2 (anexo):
//   - GTIN, Serie, Fecha Prescripción, Fecha Dispensa, Valor Erogado
// ============================================================

const { limpiarImporte, normalizarTexto, textoEnLinea, REGEX_GTIN } = require('./utils');

const CUIT_MONTPELLIER = '30535994540';

/**
 * Detecta si el texto OCR corresponde a una factura de Montpellier
 */
function detectar(textoPlano) {
    if (textoPlano.includes(CUIT_MONTPELLIER) || textoPlano.includes('30-53599454-0')) return true;
    if (/MONTPELLIER/i.test(textoPlano)) return true;
    if (/QU[IÍ]MICA\s+MONTPELLIER/i.test(textoPlano)) return true;
    return false;
}

/**
 * Extrae los datos principales de la factura (página 1)
 */
function extraerDatos(textoOCR) {
    const texto = normalizarTexto(textoOCR);
    const plano = textoEnLinea(texto);

    // --- CUIT (siempre el mismo, pero lo confirmamos del texto) ---
    const cuit = CUIT_MONTPELLIER;

    // --- NÚMERO DE COMPROBANTE ---
    // Montpellier pone "N° XXXX - YYYYYYYY" en la esquina superior derecha
    // El OCR suele leerlo como "N° 0035 - 00000410" o "N* 0035 - 00000410"
    let puntoVenta = '', numeroComprobante = '';
    const matchNro = plano.match(/N[°*º]?\s*([0-9]{4,5})\s*[-–—]\s*([0-9]{8})/i);
    if (matchNro) {
        puntoVenta = matchNro[1];
        numeroComprobante = matchNro[2];
    } else {
        // Fallback: buscar patrón XXXX-YYYYYYYY cerca de "factura"
        const matchFact = plano.match(/(?:FACTURA|COMPROBANTE)[^0-9]{0,150}?([0-9]{4,5})[\s\-_]+([0-9]{8})/i);
        if (matchFact) {
            puntoVenta = matchFact[1];
            numeroComprobante = matchFact[2];
        }
    }

    // --- FECHA DE EMISIÓN ---
    // Montpellier la pone como "FECHA: 05/08/2025" en la esquina superior derecha
    let fecha = '';
    const matchFecha = plano.match(/FECHA\s*:\s*([0-9]{2})[\s\/\-.]+([0-9]{2})[\s\/\-.]+([0-9]{4})/i);
    if (matchFecha) {
        fecha = `${matchFecha[1]}/${matchFecha[2]}/${matchFecha[3]}`;
    } else {
        // Fallback: buscar "Munro" o "ORIGINAL" seguido de fecha (layout alternativo)
        const matchAlt = plano.match(/(?:Munro|ORIGINAL)[^\d]{0,60}?([0-9]{2})[\s\/\-.]+([0-9]{2})[\s\/\-.]+([0-9]{4})/i);
        if (matchAlt) {
            fecha = `${matchAlt[1]}/${matchAlt[2]}/${matchAlt[3]}`;
        }
    }

    // --- IMPORTE TOTAL ---
    // Estrategia en cascada, específica para el layout de Montpellier:
    //   1. ANCLA "MILLONES" — el importe en letras está JUSTO después del TOTAL DOCUMENTO.
    //      El último monto antes de "MILLONES" (o "MIL PESOS") es el total. MUY confiable.
    //   2. Buscar "DOCUMENT" con tolerancia OCR
    //   3. Máximo monto después de NETO GRAVADO
    //   4. Último recurso: máximo de toda la factura
    let importe = '';
    const REGEX_MONTO = /([0-9]{1,3}(?:[.\-,\s][0-9]{3})+[.,][0-9]{2}|[0-9]{4,15}[.,][0-9]{2})(?![0-9])/g;

    // Estrategia 1: buscar "TOTAL DOCUMENTO" y tomar el MÁXIMO en ±2 líneas adyacentes.
    //
    // Cuando el PDF extrae por columnas, el monto puede estar en la línea ANTERIOR al label
    // (columna de resultados extraída antes que la columna de etiquetas), y la celda con borde
    // del TOTAL DOCUMENTO a veces no es extraída como texto por pdftotext.
    // El máximo en esas ±2 líneas siempre es el TOTAL DOCUMENTO porque:
    //   TOTAL DOC = NETO × 1.255 > BRUTO (con descuento ≤ 10%), y > cualquier impuesto individual.
    const lineas = texto.split('\n');
    for (let i = 0; i < lineas.length; i++) {
        if (/TOTAL\s+DOCUMENT/i.test(lineas[i])) {
            const candidatos = [];
            for (let d = -2; d <= 2; d++) {
                const linea = (lineas[i + d] || '')
                    .replace(/TOTAL\s+DOCUMENT[O0]?/i, '');
                const montos = [...linea.matchAll(REGEX_MONTO)];
                for (const m of montos) {
                    const val = parseFloat(limpiarImporte(m[1]));
                    if (val > 0 && val < 5000000000) candidatos.push(val);
                }
            }
            if (candidatos.length > 0) {
                importe = Math.max(...candidatos).toFixed(2);
                break;
            }
        }
    }

    // Estrategia 2: máximo global del documento (último recurso).
    if (!importe) {
        const todosLosMontos = [...plano.matchAll(REGEX_MONTO)];
        let maxMonto = 0;
        for (const m of todosLosMontos) {
            const val = parseFloat(limpiarImporte(m[1]));
            if (val > maxMonto && val < 5000000000) maxMonto = val;
        }
        if (maxMonto > 0) importe = maxMonto.toFixed(2);
    }

    // --- CAE ---
    // Montpellier pone "CAE 75310081545691" al pie de la factura
    let cae = '';
    let esCaea = false;

    // Primero buscar CAEA (tiene prioridad)
    const matchCaea = plano.match(/C[\s.\-_]*[AΑa][\s.\-_]*[EΕe][\s.\-_]*[AΑa]\s*[^0-9]{0,50}?([0-9]{14})/i);
    if (matchCaea) {
        cae = matchCaea[1];
        esCaea = true;
    } else {
        // Buscar CAE estándar
        const matchCae = plano.match(/CAE\s*[^0-9]{0,50}?([0-9]{14})/i);
        if (matchCae) {
            cae = matchCae[1];
        } else {
            const posibles = [...plano.matchAll(/(?<![0-9])([0-9]{14})(?![0-9])/g)]
                .filter(m => !/^0/.test(m[1]));
            if (posibles.length > 0) cae = posibles[posibles.length - 1][1];
        }
    }

    // --- TIPO DE COMPROBANTE ---
    const tipoComprobanteTexto = /mipyme/i.test(plano) ? 'mipyme' : 'facturas a';

    // --- TIPO DE EMISIÓN ---
    const tipoEmisionTexto = esCaea ? 'anticipada' : 'electr';

    return {
        cuit,
        cae,
        fecha,
        importe,
        puntoVenta,
        numeroComprobante,
        tipoComprobanteTexto,
        tipoEmisionTexto,
    };
}

/**
 * Extrae los datos del anexo/detalle de trazabilidad (página 2)
 */
function extraerDatosAnexo(textoAnexo, importeFactura) {
    let gtin = '', serie = '', fechaPrescripcion = '', fechaDispensa = '', valorErogado = '';

    // --- GTIN ---
    // En el anexo de Montpellier aparece como columna: "07795378004882"
    const matchGtin = textoAnexo.match(REGEX_GTIN);
    if (matchGtin) gtin = matchGtin[1];

    // --- SERIE ---
    // La serie aparece justo después del GTIN en la misma línea
    // Ejemplo: "07795378004882 4000RU0UJSKHXM 0035-00000410"
    if (gtin) {
        const regexSeriePost = new RegExp(gtin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s|\\-.,]*([A-Za-z0-9]{5,25})');
        const matchSerie = textoAnexo.match(regexSeriePost);
        if (matchSerie) {
            serie = matchSerie[1];
            // Corrección OCR común: el "G" inicial a veces se lee como "6"
            if (/^6\d{6,}/.test(serie)) serie = 'G' + serie.substring(1);
        }
    }
    // Fallback: primer alfanumérico mixto (letras+números) que no sea el GTIN ni la factura
    if (!serie) {
        const alfanumericos = [...textoAnexo.matchAll(/\b([A-Za-z]+[0-9]+[A-Za-z0-9]*)\b/g)];
        if (alfanumericos.length > 0) serie = alfanumericos[0][1];
    }

    // --- FECHAS DE PRESCRIPCIÓN Y DISPENSA ---
    // Montpellier las pone después de "REMITO" como:
    //   Fecha Prescripción    Fecha Dispensa
    //   18/08/2025            25/08/2025
    const regexFechas = /([0-9]{2})[\s\/\-.,|]+([0-9]{2})[\s\/\-.,|]+([0-9]{4})/g;

    // Intentar primero con la etiqueta "Prescripción" / "Prescripc"
    const idxPresc = textoAnexo.toLowerCase().indexOf('prescrip');
    if (idxPresc !== -1) {
        const despues = textoAnexo.substring(idxPresc);
        const fechasDespues = [...despues.matchAll(regexFechas)];
        if (fechasDespues.length >= 2) {
            fechaPrescripcion = `${fechasDespues[0][1]}/${fechasDespues[0][2]}/${fechasDespues[0][3]}`;
            fechaDispensa = `${fechasDespues[1][1]}/${fechasDespues[1][2]}/${fechasDespues[1][3]}`;
        } else if (fechasDespues.length === 1) {
            fechaPrescripcion = `${fechasDespues[0][1]}/${fechasDespues[0][2]}/${fechasDespues[0][3]}`;
            fechaDispensa = fechaPrescripcion;
        }
    }

    // Fallback: las últimas 2 fechas del texto del anexo
    if (!fechaPrescripcion || !fechaDispensa) {
        const todasFechas = [...textoAnexo.matchAll(regexFechas)];
        if (todasFechas.length >= 2) {
            const f1 = todasFechas[todasFechas.length - 2];
            const f2 = todasFechas[todasFechas.length - 1];
            fechaPrescripcion = `${f1[1]}/${f1[2]}/${f1[3]}`;
            fechaDispensa = `${f2[1]}/${f2[2]}/${f2[3]}`;
        } else if (todasFechas.length === 1) {
            fechaPrescripcion = `${todasFechas[0][1]}/${todasFechas[0][2]}/${todasFechas[0][3]}`;
            fechaDispensa = fechaPrescripcion;
        }
    }

    // --- VALOR EROGADO ---
    // Buscar importe con signo $ en el anexo
    const matchImporte = textoAnexo.match(/\$\s*([0-9]{1,3}(?:[.\-\s,][0-9]{3})+[.,][0-9]{2}|[0-9]+[.,][0-9]{2})/);
    if (matchImporte) {
        valorErogado = limpiarImporte(matchImporte[1]);
    } else {
        // Si no hay importe en el anexo, usar el de la factura
        valorErogado = importeFactura || '';
    }

    return { gtin, serie, fechaPrescripcion, fechaDispensa, valorErogado };
}

module.exports = {
    CUIT: CUIT_MONTPELLIER,
    nombre: 'Montpellier',
    detectar,
    extraerDatos,
    extraerDatosAnexo,
};


