// ============================================================
// parsers/utils.js — Funciones compartidas entre todos los parsers
// ============================================================

/**
 * Limpia un string de importe y lo convierte a formato "123456.78"
 * Maneja formatos argentinos: 1.234.567,89 / 1234567,89 / etc.
 */
function limpiarImporte(valor) {
    if (!valor) return '';
    let s = String(valor).replace(/[^0-9.,\-]/g, '');
    let match = s.match(/([.,])([0-9]{1,2})$/);
    if (match) {
        let decimales = match[2].padEnd(2, '0');
        let enteros = s.substring(0, match.index).replace(/[^0-9]/g, '');
        if (enteros === '') enteros = '0';
        return `${enteros}.${decimales}`;
    }
    return s.replace(/[^0-9]/g, '') + '.00';
}

/**
 * Prepara el texto OCR para búsqueda: quita saltos duplicados, espacios extras
 */
function normalizarTexto(texto) {
    return texto
        .replace(/\r/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n+/g, '\n')
        .trim();
}

/**
 * Convierte texto normalizado en una sola línea para regex más simples
 */
function textoEnLinea(textoNormalizado) {
    return textoNormalizado.replace(/\n/g, ' ');
}

// ============================================================
// Regex reutilizables
// ============================================================

// CUIT argentino: 20/23/24/27/30/33/34 + 8 dígitos + 1 verificador
const REGEX_CUIT = /(?<![0-9])((?:20|23|24|27|30|33|34)[-\s]*[0-9]{8}[-\s]*[0-9OQo])(?![0-9])/gi;

// Número de comprobante: 4-5 dígitos + separador + 8 dígitos
const REGEX_COMPROBANTE = /(?<![0-9])([0-9]{4,5})[\s\-_]+([0-9]{8})(?![0-9])/g;

// Fecha dd/mm/yyyy con separadores flexibles (/, -, ., espacio)
const REGEX_FECHA = /([0-9]{2})[\s\/\-.]+([0-9]{2})[\s\/\-.]+([0-9]{4})/g;

// Importe con miles y decimales: 1.234.567,89 o 1234567,89
const REGEX_IMPORTE = /([0-9]{1,3}(?:[.\-\s,][0-9]{3})+[.,][0-9]{2}|[0-9]{4,15}[.,][0-9]{2})(?![0-9])/g;

// CAE o CAEA: exactamente 14 dígitos
const REGEX_CAE_14 = /(?<![0-9])([0-9]{14})(?![0-9])/g;

// GTIN: empieza con 077 o 080, 13 dígitos total
const REGEX_GTIN = /(0?(?:779|080)\d{10})/;

// ============================================================
// Parser genérico de anexos (formato estándar: tabla con columnas
// GTIN / Nro de Serie / Nro. FACTURA / FECHA / CANT. / IMP. UNIT.)
// Funciona para todos los proveedores cuyo anexo sigue este layout.
// ============================================================
function parsearAnexo(textoAnexo, importeFactura) {
    let gtin = '', serie = '', fechaPrescripcion = '', fechaDispensa = '', valorErogado = '';

    // ── GTIN ──────────────────────────────────────────────────────────────────
    // El orden del OCR varía según el proveedor: a veces el header "GTIN" aparece
    // antes del dato, a veces después. La estrategia más robusta es:
    //   1. Formato concatenado antiguo: GTIN(13-14 dígitos) pegado a Serie(6-16 dígitos)
    //   2. Primer número standalone de 13-14 dígitos en el texto.
    //      El CUIL tiene 11 dígitos, el CUIT tiene guiones, el nro de factura tiene
    //      letras → el primer 13-14 digits standalone es siempre el GTIN.
    const mConcat = textoAnexo.match(/(?<![0-9])([0-9]{13,14})([0-9]{6,16})(?![0-9])/);
    if (mConcat) {
        gtin  = mConcat[1];
        serie = mConcat[2];
    } else {
        const mGtin = textoAnexo.match(/(?<![0-9])([0-9]{13,14})(?![0-9])/);
        if (mGtin) gtin = mGtin[1];
    }

    // ── SERIE ─────────────────────────────────────────────────────────────────
    // Una vez localizado el valor GTIN en el texto, el primer número de
    // 10-14 dígitos que lo sigue es el Nro de Serie.
    if (gtin && !serie) {
        const idxGtinVal = textoAnexo.indexOf(gtin);
        if (idxGtinVal !== -1) {
            const after = textoAnexo.substring(idxGtinVal + gtin.length);
            const m = after.match(/(?<![0-9])([0-9]{10,14})(?![0-9])/);
            if (m) serie = m[1];
        }
    }

    // ── FECHAS prescripción y dispensa ────────────────────────────────────────
    // Sección REMITO: "Fecha Prescripción  Fecha Dispensa\n  DD/MM/YYYY  DD/MM/YYYY"
    const matchRemito = textoAnexo.match(
        /Fecha\s+Prescripci[oó]n\s+Fecha\s+Dispensa[\s\S]{0,60}?([0-9]{2}[\/\-][0-9]{2}[\/\-][0-9]{4})\s+([0-9]{2}[\/\-][0-9]{2}[\/\-][0-9]{4})/i
    );
    if (matchRemito) {
        fechaPrescripcion = matchRemito[1].replace(/-/g, '/');
        fechaDispensa     = matchRemito[2].replace(/-/g, '/');
    } else {
        const all = [...textoAnexo.matchAll(/([0-9]{2})[\/\-]([0-9]{2})[\/\-]([0-9]{4})/g)];
        if (all.length > 0) {
            fechaDispensa = fechaPrescripcion = `${all[0][1]}/${all[0][2]}/${all[0][3]}`;
        }
    }

    // ── VALOR EROGADO ─────────────────────────────────────────────────────────
    // "Total general 1 $ 922,815.56" — el "1" es cantidad, se salta con (?:[0-9]+\s+)?
    const matchValor = textoAnexo.match(
        /Total\s+general\s+(?:[0-9]+\s+)?\$?\s*([0-9]{1,3}(?:[.,][0-9]{3})*[.,][0-9]{2})(?![0-9])/i
    );
    if (matchValor) {
        valorErogado = limpiarImporte(matchValor[1]);
    } else {
        const m$ = textoAnexo.match(/\$\s*([0-9]{1,3}(?:[.,][0-9]{3})*[.,][0-9]{2})/);
        valorErogado = m$ ? limpiarImporte(m$[1]) : (importeFactura || '');
    }

    return { gtin, serie, fechaPrescripcion, fechaDispensa, valorErogado };
}

module.exports = {
    limpiarImporte,
    normalizarTexto,
    textoEnLinea,
    parsearAnexo,
    REGEX_CUIT,
    REGEX_COMPROBANTE,
    REGEX_FECHA,
    REGEX_IMPORTE,
    REGEX_CAE_14,
    REGEX_GTIN,
};
