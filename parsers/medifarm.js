// ============================================================
// parsers/medifarm.js — Parser específico para SCIENZA / MEDIFARM S.A.
// ============================================================
// CUIT conocido: 30-68178305-5 (30681783055)
//
// Layout típico:
//   - Factura a nombre de "SCIENZA de Medifarm S.A."
//   - Formato de número: "FACTURA: 0118-00574438"
//   - Formato de fecha: "Fecha: 24.07.2025" (usa puntos)
//   - CAE/CAEA: "C.A.E.A N° 35285951425193" (suele ser anticipada)
// ============================================================

const { limpiarImporte, normalizarTexto, textoEnLinea, REGEX_GTIN } = require('./utils');

const CUIT_MEDIFARM = '30681783055';

/**
 * Detecta si el texto OCR corresponde a una factura de Medifarm / Scienza
 */
function detectar(textoPlano) {
    if (textoPlano.includes(CUIT_MEDIFARM) || textoPlano.includes('30-68178305-5')) return true;
    if (/MEDIFARM/i.test(textoPlano)) return true;
    if (/SCIENZA/i.test(textoPlano)) return true;
    return false;
}

/**
 * Extrae los datos principales de la factura
 */
function extraerDatos(textoOCR) {
    const texto = normalizarTexto(textoOCR);
    const plano = textoEnLinea(texto);

    // --- CUIT ---
    const cuit = CUIT_MEDIFARM;

    // --- NÚMERO DE COMPROBANTE ---
    let puntoVenta = '', numeroComprobante = '';
    const matchNro = plano.match(/FACTURA\s*[:.\-]?\s*([0-9]{4,5})\s*[-–—]\s*([0-9]{8})/i) ||
                     plano.match(/(?<![0-9])([0-9]{4,5})[\s\-_]+([0-9]{8})(?![0-9])/);
    if (matchNro) {
        puntoVenta = matchNro[1];
        numeroComprobante = matchNro[2];
    }

    // --- FECHA DE EMISIÓN ---
    let fecha = '';
    const matchFecha = plano.match(/Fecha\s*:\s*([0-9]{2})[\s\/\-.]+([0-9]{2})[\s\/\-.]+([0-9]{4})/i) ||
                       plano.match(/(?<![0-9])([0-9]{2})[\s\/\-.]+([0-9]{2})[\s\/\-.]+([0-9]{4})(?![0-9])/);
    if (matchFecha) {
        fecha = `${matchFecha[1]}/${matchFecha[2]}/${matchFecha[3]}`;
    }

    // --- CAE / CAEA ---
    let cae = '';
    let esCaea = false;
    const matchCaea = plano.match(/C\.?[AΑa]\.?[EΕe]\.?[AΑa]\.?\s*N?[°º*]?\s*([0-9]{14})/i);
    if (matchCaea) {
        cae = matchCaea[1];
        esCaea = true;
    } else {
        const matchCae = plano.match(/C\.?[AΑa]\.?[EΕe]\.?\s*N?[°º*]?\s*([0-9]{14})/i);
        if (matchCae) {
            cae = matchCae[1];
        } else {
            const posibles = [...plano.matchAll(/(?<![0-9])([0-9]{14})(?![0-9])/g)];
            if (posibles.length > 0) cae = posibles[posibles.length - 1][1];
        }
    }

    // --- IMPORTE TOTAL ---
    let bestTotal = 0;

    // 1. Intentar "SON PESOS"
    let idxSonPesos = -1;
    const matchesSonPesos = [...plano.matchAll(/SON\s*:?\s*PESOS/gi)];
    if (matchesSonPesos.length > 0) {
        idxSonPesos = matchesSonPesos[matchesSonPesos.length - 1].index;
    }
    if (idxSonPesos !== -1) {
        const contextStart = Math.max(0, idxSonPesos - 150);
        const contexto = plano.substring(contextStart);
        const montosCerca = [...contexto.matchAll(/([0-9]{1,3}(?:[.\-\s,][0-9]{3})+[.,][0-9]{2}|[0-9]{4,15}[.,][0-9]{2})(?![0-9])/g)];
        if (montosCerca.length > 0) {
            let maxMontoCerca = 0;
            for (let m of montosCerca) {
                let val = parseFloat(limpiarImporte(m[1]));
                if (val > maxMontoCerca) maxMontoCerca = val;
            }
            if (maxMontoCerca > 0) bestTotal = maxMontoCerca;
        }
    }

    // 2. Intentar "TOTAL" / "IMPORTE TOTAL" mirando a la derecha
    if (!bestTotal) {
        let textoParaTotal = plano
            .replace(/TOTAL[\s\-_]*(?:IMP\.?\s*BRUTO|BRUTO|DESCUENTOS?|UNIDADES)/gi, 'IGNORE')
            .replace(/TOTAL[\s\-_]*ARS/gi, 'TOTAL');
            
        const matchTotalExacto = [...textoParaTotal.matchAll(/(?:TOTAL|IMPORTE TOTAL(?: FACTURA)?|IMPORTE FINAL|NETO A PAGAR|A PAGAR)[\s:.$A-Za-z=\-_]{0,80}?([0-9]{1,3}(?:[.\-\s,][0-9]{3})+[.,][0-9]{2}|[0-9]{4,15}[.,][0-9]{2})(?![0-9])/gi)];
        if (matchTotalExacto.length > 0) {
            let maxEncontrado = 0;
            for (let match of matchTotalExacto) {
                let val = parseFloat(limpiarImporte(match[1]));
                if (val > maxEncontrado) maxEncontrado = val;
            }
            if (maxEncontrado > 0) bestTotal = maxEncontrado;
        }
    }

    let importeOriginal = bestTotal;
    let importe = bestTotal ? bestTotal.toFixed(2) : '';

    // 3. Rescate por suma matemática (subtotal + IVA + percepciones) usando el texto multilinea
    try {
        let sumaMatematica = 0, ultimoSubtotal = 0, encontroSubtotal = false;
        const lineas = texto.split('\n');
        for (let i = 0; i < lineas.length; i++) {
            let linea = lineas[i].toUpperCase();
            if (linea.includes('SUBTOTAL') || linea.includes('NETO GRAVADO')) {
                encontroSubtotal = true; 
                sumaMatematica = 0; 
                ultimoSubtotal = 0;
            }
            if (encontroSubtotal) {
                if (linea.includes('SUBTOTAL') || linea.includes('NETO GRAVADO') || linea.includes('PERCEP') || linea.includes('IVA') || linea.includes('%') || linea.includes('IMPUESTOS')) {
                    const importesLinea = [...linea.matchAll(/([0-9]{1,3}(?:[.\-,][0-9]{3})+[.,][0-9]{2}|[0-9]+[.,][0-9]{2})(?![0-9])/g)];
                    if (importesLinea.length > 0) {
                        let valorNum = parseFloat(limpiarImporte(importesLinea[importesLinea.length - 1][1]));
                        sumaMatematica += Math.round(valorNum * 100) / 100;
                        if (linea.includes('SUBTOTAL') || linea.includes('NETO GRAVADO')) {
                            ultimoSubtotal = Math.round(valorNum * 100) / 100;
                        }
                    }
                }
                if (linea.includes('TOTAL') && !linea.includes('SUBTOTAL') && !linea.includes('UNIDADES') && !linea.includes('BRUTO') && !linea.includes('DESCUENTO')) {
                    break;
                }
            }
        }
        if (sumaMatematica > 0 && ultimoSubtotal > 0 && (sumaMatematica > importeOriginal + 1)) {
            importe = sumaMatematica.toFixed(2);
        }
    } catch (e) {
        // Fallo silencioso del rescate matemático
    }
    
    // 4. Fallback genérico final si todo lo anterior falló
    if (!importe) {
        const REGEX_MONTO = /([0-9]{1,3}(?:[.\-,\s][0-9]{3})+[.,][0-9]{2}|[0-9]{4,15}[.,][0-9]{2})(?![0-9])/g;
        const todosLosMontos = [...plano.matchAll(REGEX_MONTO)];
        let maxMonto = 0;
        for (const m of todosLosMontos) {
            const val = parseFloat(limpiarImporte(m[1]));
            if (val > maxMonto && val < 500000000) {
                maxMonto = val;
            }
        }
        if (maxMonto > 0) importe = maxMonto.toFixed(2);
    }

    // --- TIPO DE COMPROBANTE Y EMISIÓN ---
    const tipoComprobanteTexto = /mipyme/i.test(plano) ? 'mipyme' : 'facturas a';
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
 * Extrae los datos del anexo/detalle de trazabilidad
 */
function extraerDatosAnexo(textoAnexo, importeFactura) {
    let gtin = '', serie = '', fechaPrescripcion = '', fechaDispensa = '', valorErogado = '';

    const matchGtin = textoAnexo.match(REGEX_GTIN);
    if (matchGtin) gtin = matchGtin[1];

    if (gtin) {
        const regexSeriePost = new RegExp(gtin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s|\\-.,]*([A-Za-z0-9]{5,25})');
        const matchSerie = textoAnexo.match(regexSeriePost);
        if (matchSerie) {
            serie = matchSerie[1];
            if (/^6\d{6,}/.test(serie)) serie = 'G' + serie.substring(1);
        }
    }
    if (!serie) {
        const alfanumericos = [...textoAnexo.matchAll(/\b([A-Za-z]+[0-9]+[A-Za-z0-9]*)\b/g)];
        if (alfanumericos.length > 0) serie = alfanumericos[0][1];
    }

    const regexFechas = /([0-9]{2})[\s\/\-.,|]+([0-9]{2})[\s\/\-.,|]+([0-9]{4})/g;
    const idxPresc = textoAnexo.toLowerCase().indexOf('prescrip');
    
    if (idxPresc !== -1) {
        const despues = textoAnexo.substring(idxPresc);
        const fechasDespues = [...despues.matchAll(regexFechas)];
        if (fechasDespues.length >= 2) {
            fechaPrescripcion = `${fechasDespues[0][1]}/${fechasDespues[0][2]}/${fechasDespues[0][3]}`;
            fechaDispensa = `${fechasDespues[1][1]}/${fechasDespues[1][2]}/${fechasDespues[1][3]}`;
        }
    }

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

    const matchImporte = textoAnexo.match(/\$\s*([0-9]{1,3}(?:[.\-\s,][0-9]{3})+[.,][0-9]{2}|[0-9]+[.,][0-9]{2})/);
    if (matchImporte) {
        valorErogado = limpiarImporte(matchImporte[1]);
    } else {
        valorErogado = importeFactura || '';
    }

    return { gtin, serie, fechaPrescripcion, fechaDispensa, valorErogado };
}

module.exports = { CUIT: CUIT_MEDIFARM, nombre: 'Medifarm (Scienza)', detectar, extraerDatos, extraerDatosAnexo };