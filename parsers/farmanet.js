// ============================================================
// parsers/farmanet.js — Parser para Farmanet S.A.
// ============================================================
// CUIT: 30682519416 (30-68251941-6)
//
// Layout factura (2 hojas):
//   - Número:  "FACTURA 0111-02007761" → puntoVenta=111, comp=02007761
//   - Fecha:   "Fecha: 01/10/2025"
//   - CAEA:    "CAEA Nro.: 35396021158227 Fecha Vto.: 15/10/2025"
//   - Total:   "534.885.861,84" (formato argentino: punto=miles, coma=decimal)
//              Aparece solo en la hoja 2 (hoja 1 tiene el campo TOTAL vacío)
//   - CAEA → tipoComp='facturas a', tipoEmision='anticipada'
//
// Layout anexo "Detalle de la Factura" (pág. 3 — tabla):
//   - Cod. Trazabilidad: "077921834888146000351920" (24 dígitos) → GTIN + Serie
//   - FECHA:    "01/10/2025" → fechaDispensa
//   - IMP. UNIT / Total general: "186,974.86" (formato US) → valorErogado
//
// IMPORTANTE: Farmanet va ANTES de medifarm en parsers/index.js porque la
// factura incluye "SCIENZA HORNOS" como dirección de entrega, lo que
// dispararía medifarm.detectar() con falso positivo.
// ============================================================

const { limpiarImporte, normalizarTexto, textoEnLinea, REGEX_GTIN } = require('./utils');

const CUIT_FARMANET = '30682519416';

// ── Detección ──────────────────────────────────────────────────────────────────
function detectar(textoPlano) {
    if (textoPlano.includes(CUIT_FARMANET) || textoPlano.includes('30-68251941-6')) return true;
    if (/\bFARMANET\b/i.test(textoPlano)) return true;
    return false;
}

// ── Datos principales de la factura ───────────────────────────────────────────
function extraerDatos(textoOCR) {
    const texto = normalizarTexto(textoOCR);
    const plano = textoEnLinea(texto);

    const cuit = CUIT_FARMANET;

    // ── NÚMERO DE COMPROBANTE ──────────────────────────────────────────────────
    // "FACTURA 0111-02007761" o "FACTURA A 0111-02007761"
    let puntoVenta = '', numeroComprobante = '';
    const matchNro =
        plano.match(/FACTURA\s+(?:A\s+)?0*([0-9]{4,5})\s*[-–—]\s*0*([0-9]{7,8})(?![0-9])/i) ||
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

    // ── CAEA ───────────────────────────────────────────────────────────────────
    // "CAEA Nro.: 35396021158227 Fecha Vto.: 15/10/2025"
    const esCaea = /\bCAEA\b/i.test(plano);
    let cae = '';
    const matchCAE = plano.match(/C\.?A\.?E\.?A?\.?\s*(?:Nro\.?|N[°oº]\.?)?\s*:?\s*([0-9]{14})(?![0-9])/i);
    if (matchCAE) {
        cae = matchCAE[1];
    } else {
        const posibles = [...plano.matchAll(/(?<![0-9])([0-9]{14})(?![0-9])/g)]
            .filter(m => !/^0/.test(m[1]));
        if (posibles.length > 0) cae = posibles[posibles.length - 1][1];
    }

    // ── IMPORTE TOTAL ──────────────────────────────────────────────────────────
    // Formato argentino: "534.885.861,84" (punto=miles, coma=decimal)
    // Solo aparece en la hoja 2: "TOTAL 534.885.861,84"
    const REGEX_MONTO = /([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2})(?![0-9])/g;
    let importe = '';

    // Estrategia 1: buscar todas las ocurrencias de "TOTAL <número>" y quedarse
    // con la última que tenga un valor inmediatamente al lado.
    // Esto evita: (a) la página 1 donde TOTAL está vacío, (b) "Total general"
    // del anexo que no tiene número pegado, (c) el falso match del barcode del
    // encabezado que embebe el CAEA sin etiqueta TOTAL.
    const todosTotal = [...plano.matchAll(/\bTOTAL\s+([0-9]{1,3}(?:[.,][0-9]{3})+[.,][0-9]{2})(?![0-9])/gi)];
    if (todosTotal.length > 0) {
        const val = parseFloat(limpiarImporte(todosTotal[todosTotal.length - 1][1]));
        if (val > 0) importe = val.toFixed(2);
    }

    // Estrategia 2: último monto grande del documento.
    if (!importe) {
        const todosMontos = [...plano.matchAll(REGEX_MONTO)];
        for (let i = todosMontos.length - 1; i >= 0; i--) {
            const val = parseFloat(limpiarImporte(todosMontos[i][1]));
            if (val > 100 && val < 5000000000) { importe = val.toFixed(2); break; }
        }
    }

    return {
        cuit, cae, fecha, importe, puntoVenta, numeroComprobante,
        tipoComprobanteTexto: 'facturas a',
        tipoEmisionTexto:     esCaea ? 'anticipada' : 'electr',
    };
}

// ── Datos del anexo "Detalle de la Factura" ───────────────────────────────────
function extraerDatosAnexo(textoAnexo, importeFactura) {
    let gtin = '', serie = '', fechaPrescripcion = '', fechaDispensa = '', valorErogado = '';

    // ── GTIN y SERIE ──────────────────────────────────────────────────────────
    // Formato A (antiguo): código concatenado de 24+ dígitos → GTIN(14) + Serie(10+)
    //   "077921834888146000351920"
    // Formato B (nuevo): GTIN y Serie en columnas separadas de la tabla
    //   GTIN: "07795306318036"  |  Nro de Serie: "10188885189307"
    const matchTraza = textoAnexo.match(/\b(0(?:779|780|080)[0-9]{17,})\b/);
    if (matchTraza) {
        // Formato A
        const codigo = matchTraza[1];
        const matchGtin = codigo.match(REGEX_GTIN);
        if (matchGtin) {
            gtin  = matchGtin[1];
            serie = codigo.substring(gtin.length);
        } else {
            gtin  = codigo.substring(0, 14);
            serie = codigo.substring(14);
        }
    } else {
        // Formato B: GTIN standalone de 14 dígitos (0779... / 0780... / 0080...)
        const mGtin = textoAnexo.match(/\b(0(?:779|780|080)[0-9]{10})\b/);
        if (mGtin) {
            gtin = mGtin[1];
            // Serie: primer número de 10-14 dígitos que sigue al GTIN
            const afterGtin = textoAnexo.substring(textoAnexo.indexOf(gtin) + gtin.length);
            const mSerie = afterGtin.match(/\b([0-9]{10,14})\b/);
            if (mSerie) serie = mSerie[1];
        }
    }

    // ── FECHAS prescripción y dispensa ────────────────────────────────────────
    // Sección REMITO contiene ambas fechas en columnas separadas:
    //   "Fecha Prescripción  Fecha Dispensa\n  29/07/2025  05/08/2025"
    const matchRemito = textoAnexo.match(
        /Fecha\s+Prescripci[oó]n\s+Fecha\s+Dispensa[\s\S]{0,50}?([0-9]{2}[\/\-][0-9]{2}[\/\-][0-9]{4})\s+([0-9]{2}[\/\-][0-9]{2}[\/\-][0-9]{4})/i
    );
    if (matchRemito) {
        fechaPrescripcion = matchRemito[1].replace(/-/g, '/');
        fechaDispensa     = matchRemito[2].replace(/-/g, '/');
    } else {
        const matchFecha = textoAnexo.match(/([0-9]{2})[\/\-]([0-9]{2})[\/\-]([0-9]{4})/);
        if (matchFecha) {
            fechaDispensa     = `${matchFecha[1]}/${matchFecha[2]}/${matchFecha[3]}`;
            fechaPrescripcion = fechaDispensa;
        }
    }

    // ── VALOR EROGADO ─────────────────────────────────────────────────────────
    // "Total general 1 $ 1,801,810.17" — el "1" es cantidad; se omite con (?:[0-9]+\s+)?
    const matchValor = textoAnexo.match(
        /Total\s+general\s+(?:[0-9]+\s+)?\$?\s*([0-9]{1,3}(?:[.,][0-9]{3})*[.,][0-9]{2})(?![0-9])/i
    );
    if (matchValor) {
        valorErogado = limpiarImporte(matchValor[1]);
    } else {
        valorErogado = importeFactura || '';
    }

    return { gtin, serie, fechaPrescripcion, fechaDispensa, valorErogado };
}

module.exports = {
    CUIT: CUIT_FARMANET,
    nombre: 'Farmanet S.A.',
    detectar,
    extraerDatos,
    extraerDatosAnexo,
};
