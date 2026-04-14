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

module.exports = {
    limpiarImporte,
    normalizarTexto,
    textoEnLinea,
    REGEX_CUIT,
    REGEX_COMPROBANTE,
    REGEX_FECHA,
    REGEX_IMPORTE,
    REGEX_CAE_14,
    REGEX_GTIN,
};
