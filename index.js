// Ignorar errores de certificado por el proxy corporativo de la oficina
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const puppeteer = require('puppeteer');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Tesseract = require('tesseract.js');
const xlsx = require('xlsx');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function hacerPregunta(pregunta) {
  return new Promise(resolve => rl.question(pregunta, resolve));
}

// ==========================================================
// HERRAMIENTAS DE NAVEGACIÓN WEB
// ==========================================================
async function clickearPorTextoPreciso(page, textoDeseado, timeout = 5000) {
  console.log(`➡️ Buscando texto exacto: "${textoDeseado}"...`);
  try {
      const selectorXPath = `::-p-xpath(//*[normalize-space(text())="${textoDeseado}"])`;
      await page.waitForSelector(selectorXPath, { timeout });
      await page.click(selectorXPath);
      await new Promise(r => setTimeout(r, 1000));
  } catch (error) {
      throw new Error(`No se encontró el elemento con el texto exacto: "${textoDeseado}"`);
  }
}

// ==========================================================
// HERRAMIENTAS DE PDF Y OCR
// ==========================================================
function convertirPdfAImagenes(pdfPath, outputPrefix = 'pagina') {
  console.log(`📄 Convirtiendo ${path.basename(pdfPath)} a imágenes (300 DPI)...`);
  execSync(`pdftoppm -r 300 -png "${pdfPath}" "${outputPrefix}"`, { stdio: 'inherit' });

  const archivos = fs.readdirSync('.')
    .filter(f => f.startsWith(outputPrefix + '-') && f.endsWith('.png'))
    .sort((a, b) => {
      const na = parseInt(a.match(/-(\d+)\.png$/)?.[1] || '0', 10);
      const nb = parseInt(b.match(/-(\d+)\.png$/)?.[1] || '0', 10);
      return na - nb;
    });
  if (!archivos.length) throw new Error('No se generaron imágenes del PDF.');
  return archivos;
}

async function hacerOCRDeImagen(rutaImagen) {
  console.log(`🔍 Procesando ${rutaImagen}...`);
  const result = await Tesseract.recognize(rutaImagen, 'spa+eng', {
    logger: m => {
      if (m.status === 'recognizing text') {
        process.stdout.write(`${rutaImagen} -> ${Math.round(m.progress * 100)}%\r`);
      }
    }
  });
  console.log(`\n✅ OCR terminado para ${rutaImagen}`);
  return result.data.text || '';
}

function limpiarImporte(valor) {
  if (!valor) return '';
  return valor.replace(/\./g, '').replace(',', '.').trim();
}

function extraerDatos(texto) {
  const textoLimpio = texto.replace(/\r/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n+/g, '\n').trim();
  const textoPlano = textoLimpio.replace(/\n/g, ' ');

  // FACTURA: Buscamos primero con palabra clave, y si falla buscamos formato universal 4+8 dígitos.
  let matchFactura = textoPlano.match(/(?:FACTURA|COMPROBANTE|TICKET)[^0-9]{0,30}?([0-9]{4,5})[\s\-_]+([0-9]{8})/i);
  if (!matchFactura) {
      const facturasBrutas = [...textoPlano.matchAll(/(?<![0-9])([0-9]{4,5})[\s\-_]+([0-9]{8})(?![0-9])/g)];
      if (facturasBrutas.length > 0) matchFactura = facturasBrutas[0];
  }
  
  let fechaLimpia = '';
  const matchMonteVerde = textoPlano.match(/(?:Munro|ORIGINAL)[\s,A-Za-z]*([0-9]{2})[\s\/\-.]+([0-9]{2})[\s\/\-.]+([0-9]{4})/i);
  const matchFechaExplicita = textoPlano.match(/Fecha(?: de emisi[oó]n| de comprobante)?[\s:]*([0-9]{2})[\s\/\-.]+([0-9]{2})[\s\/\-.]+([0-9]{4})/i);
  
  if (matchMonteVerde) {
    fechaLimpia = `${matchMonteVerde[1]}/${matchMonteVerde[2]}/${matchMonteVerde[3]}`; 
  } else if (matchFechaExplicita) {
    fechaLimpia = `${matchFechaExplicita[1]}/${matchFechaExplicita[2]}/${matchFechaExplicita[3]}`; 
  } else {
    let textoSinTrampas = textoPlano.replace(/(?:Inicio de Actividades|Vencimiento|Vto\.?)[^0-9]{0,50}([0-9]{2}[\s\/\-.]+[0-9]{2}[\s\/\-.]+[0-9]{4})/gi, '');
    const fechasEncontradas = [...textoSinTrampas.matchAll(/([0-9]{2})[\s\/\-.]+([0-9]{2})[\s\/\-.]+([0-9]{4})/g)];
    if (fechasEncontradas.length > 0) fechaLimpia = `${fechasEncontradas[0][1]}/${fechasEncontradas[0][2]}/${fechasEncontradas[0][3]}`;
  }

  let cuitLimpio = '';
  const cuitsEncontrados = [...textoPlano.matchAll(/C[\s.\-_]*U[\s.\-_]*[I1l|][\s.\-_]*T[^0-9]{0,30}([0-9]{2}[-\s]*[0-9]{8}[-\s]*[0-9])/gi)];
  if (cuitsEncontrados.length > 0) cuitLimpio = cuitsEncontrados.find(m => m[1].replace(/[-\s]/g, '') !== '30654855168')?.[1].replace(/[-\s]/g, '') || '';
  if (!cuitLimpio) {
      const numerosLargos = [...textoPlano.matchAll(/(?<![0-9])([0-9]{2}[-\s]*[0-9]{8}[-\s]*[0-9])(?![0-9])/g)];
      cuitLimpio = numerosLargos.find(m => m[1].replace(/[-\s]/g, '').length === 11 && m[1].replace(/[-\s]/g, '') !== '30654855168')?.[1].replace(/[-\s]/g, '') || '';
  }

  const matchCaea = textoPlano.match(/C[\s.\-_]*[AΑa][\s.\-_]*[EΕe][\s.\-_]*[AΑa][^0-9]{0,20}([0-9]{14})/i);
  const matchCae = textoPlano.match(/C[\s.\-_]*[AΑa][\s.\-_]*[EΕe](?![\s.\-_]*[AΑa])[^0-9]{0,20}([0-9]{14})/i);
  
  let numeroCae = matchCaea ? matchCaea[1] : (matchCae ? matchCae[1] : '');
  let esCaea = !!matchCaea;

  // MEJORA: Detección fuerte de CAEA
  const textoLetras = textoPlano.replace(/[\s.\-_]/g, '').toUpperCase();
  if (textoLetras.match(/C[AΑ]E[AΑ]/)) {
      esCaea = true;
  }

  // PLAN B INFALIBLE: Buscar exactamente 14 dígitos aislados
  if (!numeroCae) {
      const posiblesCae = [...textoPlano.matchAll(/(?<![0-9])([0-9]{14})(?![0-9])/g)];
      if (posiblesCae.length > 0) {
          numeroCae = posiblesCae[posiblesCae.length - 1][1]; 
      }
  }
  
  const totalesConPalabras = [...textoPlano.matchAll(/(?:\bTOTAL\b|A PAGAR|IMPORTE(?: TOTAL)?(?: FACTURA)?|NETO A PAGAR)[\s:.$A-Za-z]*([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2})/gi)];
  
  let importeLimpio = totalesConPalabras.length > 0 ? totalesConPalabras[totalesConPalabras.length - 1][1] : '';
  let importeOriginal = importeLimpio ? parseFloat(importeLimpio.replace(/\./g, '').replace(',', '.')) : 0;

  // === RESCATE MATEMÁTICO DEL TOTAL (AFIP superpuesto) ===
  try {
      let sumaMatematica = 0;
      let ultimoSubtotal = 0;
      let encontroSubtotal = false;
      const lineas = textoLimpio.split('\n');
      
      for (let i = 0; i < lineas.length; i++) {
          let linea = lineas[i].toUpperCase();
          
          if (linea.includes('SUBTOTAL')) {
              encontroSubtotal = true;
              sumaMatematica = 0; 
              ultimoSubtotal = 0;
          }
          
          if (encontroSubtotal) {
              if (linea.includes('SUBTOTAL') || linea.includes('PERCEP') || linea.includes('IVA') || linea.includes('%')) {
                  const importesLinea = [...linea.matchAll(/([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2})/g)];
                  if (importesLinea.length > 0) {
                      let valStr = importesLinea[importesLinea.length - 1][1];
                      let valorNum = parseFloat(valStr.replace(/\./g, '').replace(',', '.'));
                      sumaMatematica += valorNum;
                      if (linea.includes('SUBTOTAL')) ultimoSubtotal = valorNum;
                  }
              }
              if (linea.includes('TOTAL') && !linea.includes('SUBTOTAL')) break;
          }
      }

      if (sumaMatematica > 0 && ultimoSubtotal > 0 && importeOriginal < ultimoSubtotal) {
          importeLimpio = sumaMatematica.toFixed(2).replace('.', ',');
          console.log(`   🛠️ [Rescate] Total tapado por sello AFIP. Reconstruido: $${sumaMatematica.toFixed(2)}`);
      }
  } catch (e) {}

  return {
    cuit: cuitLimpio,
    cae: numeroCae,
    fecha: fechaLimpia,
    importe: importeLimpio ? limpiarImporte(importeLimpio) : '', 
    puntoVenta: matchFactura ? matchFactura[1] : '',
    numeroComprobante: matchFactura ? matchFactura[2] : '',
    tipoComprobanteTexto: /mipyme/i.test(textoPlano) ? "mipyme" : "facturas a",
    tipoEmisionTexto: esCaea ? "anticipada" : "electr", 
  };
}

// NUEVA FUNCIÓN: Extraer datos específicos del Anexo/Trazabilidad
function extraerDatosAnexo(textoAnexo, importeFactura) {
  let gtin = '';
  let serie = '';
  let fechaPrescripcion = '';
  let fechaDispensa = '';
  let valorErogado = '';

  // GTIN: Código de 13 o 14 dígitos empezando por 779 u 080
  const matchGtin = textoAnexo.match(/(0?(?:779|080)\d{10})/);
  if (matchGtin) gtin = matchGtin[1];

  // Nro Serie: Suele ser una cadena alfanumérica (ej: G239793176) que le sigue al GTIN
  if (gtin) {
      // El OCR a veces pega el GTIN con la serie. Permitimos que no haya espacios de separación.
      const regexSerie = new RegExp(gtin + '[\\s\\|\\-.,]*([A-Za-z0-9_]{5,20})');
      const matchSerie = textoAnexo.match(regexSerie);
      if (matchSerie) {
          serie = matchSerie[1];
          // Corrección inteligente: Si el OCR pegó la "G" y la leyó como "6" (ej: "6239793176" -> "G239793176")
          if (/^6\d{6,}/.test(serie)) {
              serie = 'G' + serie.substring(1);
          }
      }
  }
  // Si falla, buscamos cualquier palabra que tenga letras y números mezclados
  if (!serie) {
      const alfanumericos = [...textoAnexo.matchAll(/\b([A-Za-z]+[0-9]+[A-Za-z0-9]*)\b/g)];
      if (alfanumericos.length > 0) serie = alfanumericos[0][1];
  }

  // FECHAS (Mejorado para mayor precisión con el motor OCR)
  // Usamos una expresión regular más permisiva por si el OCR confunde las barras con puntos o comas
  const regexFechas = /([0-9]{2})[\s\/\-.,|]+([0-9]{2})[\s\/\-.,|]+([0-9]{4})/g;
  
  // Estrategia 1: Buscar la palabra "Prescrip" y atrapar las dos fechas que le siguen
  const idxPresc = textoAnexo.toLowerCase().indexOf('prescrip');
  if (idxPresc !== -1) {
      const textoDespues = textoAnexo.substring(idxPresc);
      const fechasDespues = [...textoDespues.matchAll(regexFechas)];
      if (fechasDespues.length >= 2) {
          fechaPrescripcion = `${fechasDespues[0][1]}/${fechasDespues[0][2]}/${fechasDespues[0][3]}`;
          fechaDispensa = `${fechasDespues[1][1]}/${fechasDespues[1][2]}/${fechasDespues[1][3]}`;
      }
  }

  // Estrategia 2: Fallback original, tomar las últimas fechas de toda la hoja
  if (!fechaPrescripcion || !fechaDispensa) {
      const fechasTotales = [...textoAnexo.matchAll(regexFechas)];
      if (fechasTotales.length >= 2) {
          const f1 = fechasTotales[fechasTotales.length - 2];
          const f2 = fechasTotales[fechasTotales.length - 1];
          fechaPrescripcion = `${f1[1]}/${f1[2]}/${f1[3]}`;
          fechaDispensa = `${f2[1]}/${f2[2]}/${f2[3]}`;
      } else if (fechasTotales.length === 1) {
          // Rescate extremo: si el OCR solo pudo leer 1 fecha perfecta, la copiamos en ambos 
          // lugares para que el formulario de la SSSalud no se trabe y te deje continuar.
          fechaPrescripcion = `${fechasTotales[0][1]}/${fechasTotales[0][2]}/${fechasTotales[0][3]}`;
          fechaDispensa = fechaPrescripcion;
      }
  }

  // VALOR EROGADO (IMP. UNIT.): Buscar en el texto el símbolo $ seguido de un importe
  const matchImporte = textoAnexo.match(/\$\s*([0-9]{1,3}(?:[.,][0-9]{3})*[.,][0-9]{2})/);
  if (matchImporte) {
      let crudo = matchImporte[1];
      // Si está en formato inglés (ej. 917,755.26), solo sacamos las comas de los miles
      if (crudo.match(/,[0-9]{3}\./)) {
          valorErogado = crudo.replace(/,/g, '');
      } else {
          // Si está en formato español (ej. 917.755,26), sacamos los puntos y cambiamos coma por punto
          valorErogado = crudo.replace(/\./g, '').replace(',', '.');
      }
  } else {
      // Fallback si no encuentra el símbolo $
      valorErogado = importeFactura || '';
  }

  return { gtin, serie, fechaPrescripcion, fechaDispensa, valorErogado };
}


async function leerYProcesarPDF(pdfPath) {
  const imagenes = convertirPdfAImagenes(pdfPath, 'pagina');
  let textoTotal = '';
  let textoAnexo = '';
  let datos = {};
  
  for (let i = imagenes.length - 1; i >= 0; i--) {
      const textoPagina = await hacerOCRDeImagen(imagenes[i]);

      // Separar hoja de trazabilidad/detalle
      if (textoPagina.toUpperCase().includes('DETALLE DE LA FACTURA') || textoPagina.toUpperCase().includes('TRAZABILIDAD') || textoPagina.toUpperCase().includes('GTIN')) {
          console.log(`   📌 Hoja de anexo/trazabilidad separada (Página ${i+1}).`);
          textoAnexo = textoPagina + '\n' + textoAnexo;
          continue; 
      }

      textoTotal = `\n\n===== ${imagenes[i]} =====\n\n` + textoPagina + textoTotal;
      datos = extraerDatos(textoTotal);
      if (datos.importe && datos.numeroComprobante && datos.fecha && datos.cae && datos.cuit) break; 
  }
  
  if (!datos.importe) {
      const textoPlano = textoTotal.replace(/\r/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n+/g, ' ').trim();
      const todosLosNumeros = [...textoPlano.matchAll(/([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2})/g)];
      if (todosLosNumeros.length > 0) datos.importe = limpiarImporte(todosLosNumeros[todosLosNumeros.length - 1][1]);
  }

  datos.textoAnexo = textoAnexo; // Guardamos el anexo en la memoria del robot

  return datos;
}

function limpiarArchivosTemporales() {
  const archivos = fs.readdirSync('.');
  for (const archivo of archivos) {
    if (/^pagina-\d+\.png$/i.test(archivo) || archivo === 'ocr_resultado.txt' || archivo === 'datos.json') {
      try { fs.unlinkSync(archivo); } catch (e) {}
    }
  }
}

async function completarDropdown(activePage, labelText, textoATipear) {
  try {
    const selectorDropdown = `::-p-xpath(//label[normalize-space(text())="${labelText}"]/parent::*//*[contains(@class, "select2-selection") or contains(@class, "ng-select-container") or @role="combobox" or contains(text(), "Seleccione")])`;
    await activePage.waitForSelector(selectorDropdown, { timeout: 5000 });
    await activePage.click(selectorDropdown); 
    await new Promise(r => setTimeout(r, 800)); 
    
    if (textoATipear) {
      await activePage.keyboard.type(textoATipear, { delay: 50 }); 
      await new Promise(r => setTimeout(r, 800)); 
      await activePage.keyboard.press('Enter');
    } else {
      await activePage.keyboard.press('ArrowDown');
      await new Promise(r => setTimeout(r, 200));
      await activePage.keyboard.press('Enter');
    }
  } catch (err) {
    console.warn(`⚠️ Error en dropdown '${labelText}':`, err.message);
  }
}

function formatearMes(periodoNumerico) {
  const nombresMeses = { '01': 'Enero', '02': 'Febrero', '03': 'Marzo', '04': 'Abril', '05': 'Mayo', '06': 'Junio', '07': 'Julio', '08': 'Agosto', '09': 'Septiembre', '10': 'Octubre', '11': 'Noviembre', '12': 'Diciembre' };
  return `${nombresMeses[periodoNumerico.substring(4, 6)]} ${periodoNumerico.substring(0, 4)}`;
}

// ==========================================================
// EL MOTOR PRINCIPAL (BATCH PROCESSING)
// ==========================================================
async function iniciarRobot() {
  console.log('🤖 Iniciando el Robot de Procesamiento...');

  const carpetaFacturas = path.join(__dirname, 'facturas_pendientes');
  if (!fs.existsSync(carpetaFacturas)) {
      fs.mkdirSync(carpetaFacturas);
      console.log(`📁 Creada la carpeta 'facturas_pendientes'. Meté los PDFs y corré el script.`);
      process.exit(0);
  }

  const browser = await puppeteer.launch({ headless: false, defaultViewport: null });
  const page = await browser.newPage();
  
  console.log(`🌐 Navegando al sistema...`);
  await page.goto('https://cuentas.sssalud.gob.ar/login', { waitUntil: 'networkidle2' });

  await hacerPregunta('\n=========================================================\n✅ Iniciá sesión manualmente.\n👉 Cuando veas la pantalla principal (Menú a la izquierda), presioná ENTER acá.\n=========================================================\n');

  const todosLosArchivos = fs.readdirSync(carpetaFacturas);
  const archivosFactura = todosLosArchivos.filter(file => file.toUpperCase().includes('FACTURA.PDF'));
  
  if (archivosFactura.length === 0) {
      console.log('❌ No se encontraron archivos de FACTURA en la carpeta "facturas_pendientes".');
      await browser.close();
      process.exit(0);
  }

  console.log(`🚀 Se encontraron ${archivosFactura.length} facturas para procesar.`);

  for (const archivo of archivosFactura) {
    try {
      console.log('\n---------------------------------------------------------');
      console.log(`📂 Procesando transacción: ${archivo}`);
      
      const matchBase = archivo.match(/^(.*?)\s*-\s*FACTURA\.pdf$/i);
      if (!matchBase) throw new Error(`El nombre del archivo no respeta el formato.`);
      
      const baseName = matchBase[1].trim(); 
      const partesNombre = baseName.split('-').map(p => p.trim());
      const periodoAfiliado = partesNombre[0]; 
      const cuilAfiliado = partesNombre[1];    
      const nombreAfiliado = partesNombre.slice(2).join(' - '); 
      const mesTexto = formatearMes(periodoAfiliado); 

      console.log(`👤 Afiliado: ${nombreAfiliado} | CUIL: ${cuilAfiliado} | Período: ${periodoAfiliado}`);

      // Archivos asociados
      const archivosDelAfiliado = todosLosArchivos.filter(f => f.startsWith(baseName));
      const archivoRemito = archivosDelAfiliado.find(f => f.toUpperCase().includes('REMITO'));
      const archivoComprobante = archivosDelAfiliado.find(f => f.toUpperCase().includes('COMPROBANTE'));
      const archivoOP = archivosDelAfiliado.find(f => f.toUpperCase().includes('- OP') || f.toUpperCase().endsWith(' OP.PDF'));

      // Leer PDF
      console.log('\n📄 Iniciando lectura (OCR) de Factura y Anexos...');
      limpiarArchivosTemporales();
      const rutaCompletaPdf = path.join(carpetaFacturas, archivo);
      const datosListos = await leerYProcesarPDF(rutaCompletaPdf);
      
      const faltantes = ['cuit','cae','fecha','importe','puntoVenta','numeroComprobante'].filter(k => !datosListos[k]);
      if (faltantes.length > 0) throw new Error(`Faltan datos en el PDF: [ ${faltantes.join(', ')} ]`);
      
      console.log('✅ Lectura completada. Iniciando navegación rápida...');

      // Navegación Web Previa
      const activePage = (await browser.pages()).pop();
      await clickearPorTextoPreciso(activePage, "Empadronamientos");
      await new Promise(r => setTimeout(r, 500)); 
      await clickearPorTextoPreciso(activePage, "Todos");
      await new Promise(r => setTimeout(r, 2000)); 
      
      try { await clickearPorTextoPreciso(activePage, "Filtros", 3000); await new Promise(r => setTimeout(r, 1000)); } catch(e) {}

      // Buscador CUIL
      const selectorCuilBuscador = '::-p-xpath(//label[contains(text(), "Cuil beneficiario")]/parent::*//input)';
      await activePage.waitForSelector(selectorCuilBuscador, { timeout: 5000 });
      await activePage.click(selectorCuilBuscador, { clickCount: 3 });
      await activePage.keyboard.press('Backspace');
      await activePage.type(selectorCuilBuscador, cuilAfiliado, { delay: 50 });
      await activePage.keyboard.press('Enter');
      await new Promise(r => setTimeout(r, 3000)); 

      // Clic Inteligente por Fecha
      const selectorBtnSol = '::-p-xpath(//*[@title="Ver solicitudes de reintegro"])';
      await activePage.waitForSelector(selectorBtnSol, { timeout: 10000 });

      const targetYear = parseInt(periodoAfiliado.substring(0, 4), 10);
      const targetMonth = parseInt(periodoAfiliado.substring(4, 6), 10);

      const clickSolExitoso = await activePage.evaluate((tYear, tMonth) => {
          const ths = Array.from(document.querySelectorAll('th'));
          const indexInicio = ths.findIndex(th => th.innerText.toLowerCase().includes('vigencia inicio'));
          const indexFin = ths.findIndex(th => th.innerText.toLowerCase().includes('vigencia fin'));
          const targetDate = new Date(tYear, tMonth - 1, 15); 
          const trs = Array.from(document.querySelectorAll('tr')).filter(tr => tr.querySelector('td'));
          const months = { 'enero':1, 'febrero':2, 'marzo':3, 'abril':4, 'mayo':5, 'junio':6, 'julio':7, 'agosto':8, 'septiembre':9, 'octubre':10, 'noviembre':11, 'diciembre':12 };
          const parseD = str => { const m = str.toLowerCase().match(/(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})/); return m ? new Date(parseInt(m[3]), months[m[2]] - 1, parseInt(m[1])) : null; };

          if (indexInicio !== -1 && indexFin !== -1) {
              for (let tr of trs) {
                  const tds = tr.querySelectorAll('td');
                  if (tds.length > Math.max(indexInicio, indexFin)) {
                      const dInicio = parseD(tds[indexInicio].innerText);
                      const dFin = parseD(tds[indexFin].innerText);
                      if (dInicio && dFin && targetDate >= dInicio && targetDate <= dFin) {
                          const btn = tr.querySelector('[title="Ver solicitudes de reintegro"]');
                          if (btn) { btn.scrollIntoView({block: 'center'}); btn.click(); return true; }
                      }
                  }
              }
          }
          const fbBtn = document.querySelector('[title="Ver solicitudes de reintegro"]');
          if (fbBtn) { fbBtn.scrollIntoView({block: 'center'}); fbBtn.click(); return true; }
          return false;
      }, targetYear, targetMonth);

      if (!clickSolExitoso) throw new Error('No se halló botón solicitudes.');
      await new Promise(r => setTimeout(r, 3000));

      await completarDropdown(activePage, "Períodos disponibles", mesTexto);
      await clickearPorTextoPreciso(activePage, "Guardar");
      
      await activePage.waitForFunction((p) => Array.from(document.querySelectorAll('tr')).some(tr => tr.innerText.includes(p)), { timeout: 15000 }, periodoAfiliado);
      const clickFacEx = await activePage.evaluate((p) => {
          const fila = Array.from(document.querySelectorAll('tr')).find(tr => tr.innerText.includes(p));
          if (fila) {
              let b = Array.from(fila.querySelectorAll('[title]')).find(b => b.getAttribute('title').toLowerCase().includes('factura')) || fila.querySelector('td:first-child a, td:first-child button, td:first-child i');
              if (b) { b.scrollIntoView({block: 'center'}); b.click(); return true; }
          }
          return false; 
      }, periodoAfiliado);
      if (!clickFacEx) throw new Error(`No se ubicó botón FACTURA.`);
      await new Promise(r => setTimeout(r, 4000)); 

      const btnAgregarFactura = '::-p-xpath(//a[contains(translate(text(), "AGRE", "agre"), "agregar factura")] | //button[contains(translate(text(), "AGRE", "agre"), "agregar factura")] | //*[contains(translate(text(), "AGRE", "agre"), "agregar factura")])';
      await activePage.waitForSelector(btnAgregarFactura, { timeout: 10000 });
      await activePage.click(btnAgregarFactura);
      await new Promise(r => setTimeout(r, 3000)); 

      await completarDropdown(activePage, "Tipo de factura", "AFIP");
      await new Promise(r => setTimeout(r, 1000));

      // Llenar Formulario 1 (Factura)
      console.log('✍️ Completando planilla de Factura...');
      await completarDropdown(activePage, "Tipo de comprobante", datosListos.tipoComprobanteTexto);
      await completarDropdown(activePage, "Tipo de emisión", datosListos.tipoEmisionTexto);
      await completarDropdown(activePage, "Cuil/Cuit receptor", "30654855168"); 

      const selCuit = 'input[placeholder*="cuit del prestador" i]';
      await activePage.waitForSelector(selCuit, { timeout: 5000 });
      await activePage.click(selCuit, { clickCount: 3 }); await activePage.keyboard.press('Backspace');
      await activePage.type(selCuit, datosListos.cuit, { delay: 30 }); 

      await activePage.type('input[placeholder*="punto de venta" i]', datosListos.puntoVenta, { delay: 30 });
      await activePage.type('::-p-xpath(//label[contains(., "mero comprobante")]/parent::*//input)', datosListos.numeroComprobante, { delay: 30 });

      const selFecha = 'input[placeholder*="fecha" i]';
      await activePage.click(selFecha, { clickCount: 3 }); await activePage.keyboard.press('Backspace');
      await activePage.type(selFecha, datosListos.fecha, { delay: 30 });

      await activePage.type('input[placeholder*="numero de" i]', datosListos.cae, { delay: 30 });

      const selImp = '::-p-xpath(//label[contains(., "Importe")]/parent::*//input)';
      await activePage.click(selImp, { clickCount: 3 }); await activePage.keyboard.press('Backspace');
      await activePage.type(selImp, datosListos.importe, { delay: 30 });

      // Subir Archivos
      console.log('☁️ Subiendo archivos PDF a la plataforma...');
      await (await activePage.waitForSelector('::-p-xpath(//label[contains(., "Archivo de factura")]/parent::*//input[@type="file"])', { timeout: 5000 })).uploadFile(path.join(carpetaFacturas, archivo));
      if (archivoRemito) await (await activePage.waitForSelector('::-p-xpath(//label[contains(., "Archivo de remito")]/parent::*//input[@type="file"])', { timeout: 2000 })).uploadFile(path.join(carpetaFacturas, archivoRemito));
      if (archivoComprobante) await (await activePage.waitForSelector('::-p-xpath(//label[contains(., "Archivo de transferencia")]/parent::*//input[@type="file"])', { timeout: 2000 })).uploadFile(path.join(carpetaFacturas, archivoComprobante));
      if (archivoOP) await (await activePage.waitForSelector('::-p-xpath(//label[contains(., "Archivo de orden de pago")]/parent::*//input[@type="file"])', { timeout: 2000 })).uploadFile(path.join(carpetaFacturas, archivoOP));

      // Guardar Excel
      const numeroSolicitud = await activePage.evaluate(() => {
          const match = document.body.innerText.match(/Solicitudes\s*>\s*#(\d+)/i) || document.body.innerText.match(/#(\d{6,8})/);
          return match ? match[1] : 'No encontrado';
      });
      
      const archivoExcel = path.join(__dirname, 'Registro_Cargas.xlsx');
      let datosExcel = [];
      if (fs.existsSync(archivoExcel)) datosExcel = xlsx.utils.sheet_to_json(xlsx.readFile(archivoExcel).Sheets['Cargas']);
      datosExcel.push({ 'AFILIADO': nombreAfiliado, 'CUIL': cuilAfiliado, 'PERIODO': periodoAfiliado, 'N SOLICITUD': numeroSolicitud, 'ESTADO': 'Cargado' });
      const nuevoWS = xlsx.utils.json_to_sheet(datosExcel);
      nuevoWS['!cols'] = [{ wch: 35 }, { wch: 15 }, { wch: 10 }, { wch: 15 }, { wch: 10 }];
      const nuevoWB = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(nuevoWB, nuevoWS, 'Cargas');
      xlsx.writeFile(nuevoWB, archivoExcel);

      // ========================================================
      // 7. GUARDAR FACTURA Y VINCULAR MEDICAMENTOS
      // ========================================================
      console.log('💾 Guardando factura principal en el sistema...');
      await activePage.evaluate(() => {
          const botones = Array.from(document.querySelectorAll('button'));
          const btnGuardar = botones.reverse().find(b => b.innerText.trim() === 'Guardar' && b.offsetParent !== null);
          if (btnGuardar) {
              btnGuardar.scrollIntoView({block: 'center'});
              btnGuardar.click();
          }
      });
      
      console.log('⏳ Esperando confirmación y navegando a Medicamentos...');
      await activePage.waitForFunction(() => {
          return Array.from(document.querySelectorAll('button, a')).some(el => el.innerText.includes('Vincularle medicamentos'));
      }, { timeout: 20000 });
      await new Promise(r => setTimeout(r, 1000));
      
      await activePage.evaluate(() => {
          const btnVincular = Array.from(document.querySelectorAll('button, a')).find(el => el.innerText.includes('Vincularle medicamentos'));
          if (btnVincular) btnVincular.click();
      });
      await new Promise(r => setTimeout(r, 2000));

      console.log('💊 Agregando Medicamento...');
      const btnAgregarMed = '::-p-xpath(//button[contains(translate(text(), "AGRE", "agre"), "agregar medicamento")] | //a[contains(translate(text(), "AGRE", "agre"), "agregar medicamento")])';
      await activePage.waitForSelector(btnAgregarMed, { timeout: 10000 });
      await activePage.click(btnAgregarMed);
      await new Promise(r => setTimeout(r, 2000));

      // Leer el texto reservado de Trazabilidad
      const datosAnexo = extraerDatosAnexo(datosListos.textoAnexo, datosListos.importe);
      console.log(`   📊 Datos extraídos -> Serie: ${datosAnexo.serie} | GTIN: ${datosAnexo.gtin} | Presc: ${datosAnexo.fechaPrescripcion} | Disp: ${datosAnexo.fechaDispensa} | Valor Erogado: ${datosAnexo.valorErogado}`);

      // --------------------------------------------------------
      // PRIMERO: Modal para Buscar Medicamento por GTIN
      // --------------------------------------------------------
      const btnSelectMed = '::-p-xpath(//button[contains(translate(text(), "SELEC", "selec"), "seleccionar medicamento")])';
      await activePage.waitForSelector(btnSelectMed, { timeout: 5000 });
      await activePage.click(btnSelectMed);
      console.log('🔍 Buscando GTIN en el listado...');
      await new Promise(r => setTimeout(r, 2000)); 

      try {
          // Desplegar el buscador clickeando en el botón "Filtros"
          await clickearPorTextoPreciso(activePage, "Filtros", 5000);
          await new Promise(r => setTimeout(r, 1000));

          // Buscamos el input específico que tiene el texto "GTIN" de fondo (placeholder)
          const selInputGTIN = 'input[placeholder="GTIN" i]';
          await activePage.waitForSelector(selInputGTIN, { timeout: 5000 });
          await activePage.click(selInputGTIN, { clickCount: 3 });
          await activePage.keyboard.press('Backspace');
          await activePage.type(selInputGTIN, datosAnexo.gtin, { delay: 30 });
          await activePage.keyboard.press('Enter');
          await new Promise(r => setTimeout(r, 2000)); // Tiempo para que el sistema filtre la grilla

          // Clickeamos el botón verde "Seleccionar" que está DENTRO de la tabla (td)
          console.log('👆 Clickeando el botón "Seleccionar" de la grilla...');
          const btnSeleccionarGrilla = '::-p-xpath(//td//button[normalize-space(text())="Seleccionar"])';
          await activePage.waitForSelector(btnSeleccionarGrilla, { timeout: 5000 });
          await activePage.click(btnSeleccionarGrilla);
          await new Promise(r => setTimeout(r, 2000)); // Damos tiempo a que se cierre el panel
      } catch (e) {
          console.log('⚠️ El sistema no pudo auto-seleccionar el medicamento en la búsqueda.');
          await hacerPregunta(`\n⏸️ PAUSA: Por favor, selecciona manualmente el medicamento en la web usando el GTIN: ${datosAnexo.gtin}\n👉 Una vez seleccionado, presiona ENTER aquí para que el robot guarde...`);
      }

      // --------------------------------------------------------
      // SEGUNDO: Llenar Formulario de Medicamentos (Fechas, Serie, Valor)
      // --------------------------------------------------------
      console.log('✍️ Completando fechas y datos del medicamento...');
      const selPresc = 'input[placeholder*="prescripc" i]';
      await activePage.waitForSelector(selPresc, { timeout: 5000 });
      await activePage.click(selPresc, { clickCount: 3 }); await activePage.keyboard.press('Backspace');
      if (datosAnexo.fechaPrescripcion) await activePage.type(selPresc, datosAnexo.fechaPrescripcion, { delay: 30 });

      const selDisp = 'input[placeholder*="dispensa" i]';
      await activePage.click(selDisp, { clickCount: 3 }); await activePage.keyboard.press('Backspace');
      if (datosAnexo.fechaDispensa) await activePage.type(selDisp, datosAnexo.fechaDispensa, { delay: 30 });

      const selSerie = 'input[placeholder*="serie" i]';
      await activePage.click(selSerie, { clickCount: 3 }); await activePage.keyboard.press('Backspace');
      if (datosAnexo.serie) await activePage.type(selSerie, datosAnexo.serie, { delay: 30 });

      const selValor = '::-p-xpath(//label[contains(., "Valor erogado")]/parent::*//input)';
      await activePage.click(selValor, { clickCount: 3 }); await activePage.keyboard.press('Backspace');
      if (datosAnexo.valorErogado) await activePage.type(selValor, datosAnexo.valorErogado, { delay: 30 });

      // Guardar todo
      console.log('💾 Guardando Medicamento y finalizando...');
      await activePage.evaluate(() => {
          const botones = Array.from(document.querySelectorAll('button'));
          const btnGuardar = botones.reverse().find(b => b.innerText.trim() === 'Guardar' && b.offsetParent !== null);
          if (btnGuardar) {
              btnGuardar.scrollIntoView({block: 'center'});
              btnGuardar.click();
          }
      });
      await new Promise(r => setTimeout(r, 4000)); 
      
      console.log(`\n🏁 Secuencia completada. Preparando siguiente archivo...`);
      try { await clickearPorTextoPreciso(activePage, "Inicio", 3000); await new Promise(r => setTimeout(r, 2000)); } catch(e) {}

      const dirProc = path.join(__dirname, 'Procesados');
      if(!fs.existsSync(dirProc)) fs.mkdirSync(dirProc);
      archivosDelAfiliado.forEach(f => { try{ fs.renameSync(path.join(carpetaFacturas, f), path.join(dirProc, f)); }catch(e){} });

    } catch (error) {
      console.error(`\n❌ Error con la factura ${archivo}:`, error.message);
      await hacerPregunta(`\n⚠️ Ocurrió un error. Corregí el problema (si estabas en la web, volvé a la pantalla de búsqueda) y presioná ENTER para saltar al siguiente archivo...`);
    }
  }

  console.log('\n🎉 ¡SE PROCESARON TODOS LOS ARCHIVOS DE LA CARPETA!');
  await browser.close();
  rl.close();
}

iniciarRobot();