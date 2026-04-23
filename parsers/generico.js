// ============================================================
// parsers/generico.js — Parser genérico (fallback para proveedores sin parser propio)
// ============================================================
// Este es básicamente tu extraerDatos() original, sin las ramas específicas
// de Montpellier/Varifarma/Biogen/Farmanet (esas ahora están en sus parsers).
// A medida que vayas creando parsers por proveedor, este archivo se va
// achicando porque le sacás las reglas que ya no necesita.
// ============================================================

const { limpiarImporte, normalizarTexto, textoEnLinea, REGEX_GTIN } = require('./utils');

function detectar() {
    // El genérico siempre matchea (es el fallback)
    return true;
}

function extraerDatos(textoOCR) {
    const textoLimpio = normalizarTexto(textoOCR);
    const textoPlano = textoEnLinea(textoLimpio);

    // 1. Factura / Comprobante
    let matchFactura = textoPlano.match(/(?:FACTURA|COMPROBANTE|TICKET)[\s\S]{0,250}?([0-9]{4,5})[\s\-_]+([0-9]{8})/i);
    if (!matchFactura) {
        const facturasBrutas = [...textoPlano.matchAll(/(?<![0-9])([0-9]{4,5})[\s\-_]+([0-9]{8})(?![0-9])/g)];
        if (facturasBrutas.length > 0) matchFactura = facturasBrutas[0];
    }

    // 2. Fecha
    let fechaLimpia = '';
    let textoFechasLimpio = textoPlano
        .replace(/(?:Vencimiento|Vto\.?|Vence|Hasta|Impreso|Pedido|Entrega|C\.?[AΑa]\.?E\.?)[^0-9]{0,50}?([0-9]{2}[\s\/\-.]+[0-9]{2}[\s\/\-.]+[0-9]{4})/gi, 'IGNORE')
        .replace(/FECHA[\s\-_]*(?:DE\s*)?(?:VTO\.?|VENCIMIENTO|PEDIDO|O\.C\.|ENTREGA)[^0-9]{0,50}?([0-9]{2}[\s\/\-.]+[0-9]{2}[\s\/\-.]+[0-9]{4})/gi, 'IGNORE');

    const regexFechaExplicita = /(?:Fecha|Facha|Emisi[oó]n)[^0-9]{0,30}?([0-9]{2})[\s\/\-.]+([0-9]{2})[\s\/\-.]+([0-9]{4})/gi;
    const fechasExplicitas = [...textoFechasLimpio.matchAll(regexFechaExplicita)];

    if (fechasExplicitas.length > 0) {
        fechaLimpia = `${fechasExplicitas[0][1]}/${fechasExplicitas[0][2]}/${fechasExplicitas[0][3]}`;
    } else {
        const regexCualquierFecha = /(?<![0-9])([0-9]{2})[\s\/\-.]+([0-9]{2})[\s\/\-.]+([0-9]{4})(?![0-9])/g;
        const fechasEncontradas = [...textoFechasLimpio.matchAll(regexCualquierFecha)];
        if (fechasEncontradas.length > 0) {
            fechaLimpia = `${fechasEncontradas[0][1]}/${fechasEncontradas[0][2]}/${fechasEncontradas[0][3]}`;
        }
    }

    // 3. CUIT
    let cuitLimpio = '';
    let matchCuitExplicito = textoPlano.match(/C[\s.\-_]*U[\s.\-_]*[I1l|][\s.\-_]*T[^0-9]{0,30}?((?:20|23|24|27|30|33|34)[-\s]*[0-9]{8}[-\s]*[0-9OQo])/i);
    if (matchCuitExplicito) {
        let c = matchCuitExplicito[1].replace(/[-\s]/g, '').replace(/[OQo]/gi, '0');
        if (c.length === 11 && c !== '30654855168') cuitLimpio = c;
    }
    if (!cuitLimpio) {
        const posiblesCuits = [...textoPlano.matchAll(/(?<![0-9])((?:20|23|24|27|30|33|34)[-\s]*[0-9]{8}[-\s]*[0-9OQo])(?![0-9])/gi)];
        for (let match of posiblesCuits) {
            let c = match[1].replace(/[-\s]/g, '').replace(/[OQo]/gi, '0');
            if (c.length === 11 && c !== '30654855168') {
                cuitLimpio = c;
                break;
            }
        }
    }

    // 4. CAE
    const matchCaea = textoPlano.match(/(?:C[\s.\-_]*[AΑa][\s.\-_]*[EΕe][\s.\-_]*[AΑa]|CAEA|C\.A\.E\.A\.)[\s\S]{0,250}?([0-9]{14})/i);
    const matchCae = textoPlano.match(/(?:C[\s.\-_]*[AΑa][\s.\-_]*[EΕe](?![\s.\-_]*[AΑa])|CAE|C\.A\.E\.)[\s\S]{0,250}?([0-9]{14})/i);
    let numeroCae = matchCaea ? matchCaea[1] : (matchCae ? matchCae[1] : '');
    let esCaea = !!matchCaea || textoPlano.replace(/[\s.\-_]/g, '').toUpperCase().includes('CAEA');
    if (!numeroCae) {
        const posiblesCae = [...textoPlano.matchAll(/(?<![0-9])([0-9]{14})(?![0-9])/g)]
            .filter(m => !/^0(?:779|080)/.test(m[1]));
        if (posiblesCae.length > 0) numeroCae = posiblesCae[posiblesCae.length - 1][1];
    }

    // 5. IMPORTE (lógica genérica sin ramas específicas por proveedor)
    let bestTotal = 0;

    // Intentar "SON PESOS"
    let idxSonPesos = -1;
    const matchesSonPesos = [...textoPlano.matchAll(/SON\s*:?\s*PESOS/gi)];
    if (matchesSonPesos.length > 0) {
        idxSonPesos = matchesSonPesos[matchesSonPesos.length - 1].index;
    }
    if (idxSonPesos !== -1) {
        const contextStart = Math.max(0, idxSonPesos - 150);
        const contexto = textoPlano.substring(contextStart);
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

    // Intentar "TOTAL" / "IMPORTE TOTAL" / etc.
    if (!bestTotal) {
        let textoParaTotal = textoPlano
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
    let importeLimpio = bestTotal ? bestTotal.toFixed(2).replace('.', ',') : '';

    // Rescate por suma matemática (subtotal + IVA + percepciones)
    try {
        let sumaMatematica = 0, ultimoSubtotal = 0, encontroSubtotal = false;
        const lineas = textoLimpio.split('\n');
        for (let i = 0; i < lineas.length; i++) {
            let linea = lineas[i].toUpperCase();
            if (linea.includes('SUBTOTAL') || linea.includes('NETO GRAVADO')) {
                encontroSubtotal = true; sumaMatematica = 0; ultimoSubtotal = 0;
            }
            if (encontroSubtotal) {
                if (linea.includes('SUBTOTAL') || linea.includes('NETO GRAVADO') || linea.includes('PERCEP') || linea.includes('IVA') || linea.includes('%') || linea.includes('IMPUESTOS')) {
                    const importesLinea = [...linea.matchAll(/([0-9]{1,3}(?:[.\-,][0-9]{3})+[.,][0-9]{2}|[0-9]+[.,][0-9]{2})(?![0-9])/g)];
                    if (importesLinea.length > 0) {
                        let valorNum = parseFloat(limpiarImporte(importesLinea[importesLinea.length - 1][1]));
                        sumaMatematica += Math.round(valorNum * 100) / 100;
                        if (linea.includes('SUBTOTAL') || linea.includes('NETO GRAVADO')) ultimoSubtotal = Math.round(valorNum * 100) / 100;
                    }
                }
                if (linea.includes('TOTAL') && !linea.includes('SUBTOTAL') && !linea.includes('UNIDADES') && !linea.includes('BRUTO') && !linea.includes('DESCUENTO')) break;
            }
        }
        if (sumaMatematica > 0 && ultimoSubtotal > 0 && (sumaMatematica > importeOriginal + 1)) {
            importeLimpio = sumaMatematica.toFixed(2).replace('.', ',');
        }
    } catch (e) {}

    return {
        cuit: cuitLimpio,
        cae: numeroCae,
        fecha: fechaLimpia,
        importe: importeLimpio ? limpiarImporte(importeLimpio) : '',
        puntoVenta: matchFactura ? matchFactura[1] : '',
        numeroComprobante: matchFactura ? matchFactura[2] : '',
        tipoComprobanteTexto: /mipyme/i.test(textoPlano) ? 'mipyme' : 'facturas a',
        tipoEmisionTexto: esCaea ? 'anticipada' : 'electr',
    };
}

function extraerDatosAnexo(textoAnexo, importeFactura) {
    let gtin = '', serie = '', fechaPrescripcion = '', fechaDispensa = '', valorErogado = '';
    const matchGtin = textoAnexo.match(REGEX_GTIN);
    if (matchGtin) gtin = matchGtin[1];

    if (gtin) {
        const regexSerie = new RegExp(gtin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\|\\-.,]*([A-Za-z0-9_]{5,20})');
        const matchSerie = textoAnexo.match(regexSerie);
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
        const fechasDespues = [...textoAnexo.substring(idxPresc).matchAll(regexFechas)];
        if (fechasDespues.length >= 2) {
            fechaPrescripcion = `${fechasDespues[0][1]}/${fechasDespues[0][2]}/${fechasDespues[0][3]}`;
            fechaDispensa = `${fechasDespues[1][1]}/${fechasDespues[1][2]}/${fechasDespues[1][3]}`;
        }
    }
    if (!fechaPrescripcion || !fechaDispensa) {
        const fechasTotales = [...textoAnexo.matchAll(regexFechas)];
        if (fechasTotales.length >= 2) {
            const f1 = fechasTotales[fechasTotales.length - 2];
            const f2 = fechasTotales[fechasTotales.length - 1];
            fechaPrescripcion = `${f1[1]}/${f1[2]}/${f1[3]}`;
            fechaDispensa = `${f2[1]}/${f2[2]}/${f2[3]}`;
        } else if (fechasTotales.length === 1) {
            fechaPrescripcion = `${fechasTotales[0][1]}/${fechasTotales[0][2]}/${fechasTotales[0][3]}`;
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

module.exports = {
    CUIT: null, // No tiene CUIT fijo, es el fallback
    nombre: 'Genérico',
    detectar,
    extraerDatos,
    extraerDatosAnexo,
};
