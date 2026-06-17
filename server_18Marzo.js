process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const multer = require('multer');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Tesseract = require('tesseract.js');
const xlsx = require('xlsx');

// ============================================================
// NUEVO: Sistema de parsers por proveedor
// ============================================================
const parsers = require('./parsers');
const { limpiarImporte } = require('./parsers/utils');

module.exports = function iniciarServidorBackend(rutaSeguraDatos, rutaCodigo, rutaEscritorio) {

    const app = express();
    const port = 3000;

    app.use(express.static(path.join(rutaCodigo, 'public')));
    app.use(express.json());

    const carpetaFacturas = path.join(rutaSeguraDatos, 'facturas_pendientes');
    if (!fs.existsSync(rutaSeguraDatos)) fs.mkdirSync(rutaSeguraDatos, { recursive: true });
    if (!fs.existsSync(carpetaFacturas)) fs.mkdirSync(carpetaFacturas);

    const storage = multer.diskStorage({
        destination: (req, file, cb) => cb(null, carpetaFacturas),
        filename: (req, file, cb) => cb(null, file.originalname)
    });
    const upload = multer({ storage: storage });

    app.post('/api/upload', upload.array('archivos'), (req, res) => {
        sendLog(`📥 Se subieron ${req.files.length} archivos a la cola de trabajo.`);
        res.sendStatus(200);
    });

    app.get('/api/version', (req, res) => {
        const version = require('./package.json').version;
        const changelogPath = path.join(rutaCodigo, 'CHANGELOG.json');
        let changelog = {};
        try { changelog = JSON.parse(fs.readFileSync(changelogPath, 'utf8')); } catch {}
        res.json({ version, changes: changelog[version] || [] });
    });

    app.get('/api/archivos', (req, res) => {
        try {
            const archivos = fs.readdirSync(carpetaFacturas);
            res.json(archivos);
        } catch (e) {
            res.status(500).json([]);
        }
    });

    app.delete('/api/archivos', (req, res) => {
        try {
            const archivos = fs.readdirSync(carpetaFacturas).filter(f => f.toLowerCase().endsWith('.pdf'));
            archivos.forEach(f => fs.unlinkSync(path.join(carpetaFacturas, f)));
            sendLog(`🗑️ Cola vaciada: ${archivos.length} archivo(s) eliminado(s)`);
            res.sendStatus(200);
        } catch (error) {
            res.status(500).send('Error al vaciar la cola');
        }
    });

    app.delete('/api/archivos/:nombreArchivo', (req, res) => {
        const nombreArchivo = req.params.nombreArchivo;
        const rutaArchivo = path.join(carpetaFacturas, nombreArchivo);
        try {
            if (fs.existsSync(rutaArchivo)) {
                fs.unlinkSync(rutaArchivo);
                sendLog(`🗑️ Archivo removido de la cola: ${nombreArchivo}`);
                res.sendStatus(200);
            } else {
                res.status(404).send('Archivo no encontrado');
            }
        } catch (error) {
            sendLog(`❌ Error al intentar borrar: ${error.message}`);
            res.status(500).send('Error al borrar el archivo');
        }
    });

    let clients = [];
    app.get('/api/logs', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        clients.push(res);
        req.on('close', () => { clients = clients.filter(c => c !== res); });
    });

    function sendLog(msg) {
        console.log(msg);
        clients.forEach(c => c.write(`data: ${msg}\n\n`));
    }

    let resolvePausaLogin = null;
    app.post('/api/continuar', (req, res) => {
        if (resolvePausaLogin) {
            resolvePausaLogin();
            resolvePausaLogin = null;
            sendLog('▶️ Continuado por el usuario...');
        }
        res.sendStatus(200);
    });

    function esperarBotonWeb(mensaje) {
        sendLog(`\n=========================================================`);
        sendLog(`⏸️ PAUSA: ${mensaje}`);
        sendLog(`👉 Ve a la página de control web y presiona "Continuar".`);
        sendLog(`=========================================================\n`);
        clients.forEach(c => c.write(`data: ACCION_REQUERIDA\n\n`));
        return new Promise(resolve => { resolvePausaLogin = resolve; });
    }

    let robotCorriendo = false;
    app.post('/api/start', async (req, res) => {
        if (robotCorriendo) return res.status(400).send('El robot ya está corriendo.');
        robotCorriendo = true;
        res.sendStatus(200);
        try {
            await iniciarRobot();
        } catch (e) {
            sendLog(`\n❌ ERROR CRÍTICO DEL ROBOT: ${e.message}`);
        } finally {
            robotCorriendo = false;
            sendLog('\n🛑 El proceso del robot ha finalizado.');
            clients.forEach(c => c.write(`data: ROBOT_FIN\n\n`));
        }
    });

    async function clickearPorTextoPreciso(page, textoDeseado, timeout = 5000) {
        sendLog(`➡️ Buscando texto exacto: "${textoDeseado}"...`);
        try {
            const selectorXPath = `::-p-xpath(//*[normalize-space(text())="${textoDeseado}"])`;
            await page.waitForSelector(selectorXPath, { timeout });
            await page.click(selectorXPath);
            await new Promise(r => setTimeout(r, 1000));
        } catch (error) {
            throw new Error(`No se encontró el elemento "${textoDeseado}"`);
        }
    }

    function convertirPdfAImagenes(pdfPath, outputPrefix = 'pagina') {
        sendLog(`📄 Convirtiendo ${path.basename(pdfPath)} a imágenes...`);

        let comandoPdftoppm = 'pdftoppm';
        const rutaProduccion = path.join(process.resourcesPath, 'poppler', 'Library', 'bin', 'pdftoppm.exe');
        const rutaDesarrollo = path.join(rutaCodigo, 'poppler', 'Library', 'bin', 'pdftoppm.exe');

        if (fs.existsSync(rutaProduccion)) {
            comandoPdftoppm = `"${rutaProduccion}"`;
        } else if (fs.existsSync(rutaDesarrollo)) {
            comandoPdftoppm = `"${rutaDesarrollo}"`;
        }

        execSync(`${comandoPdftoppm} -r 300 -png "${pdfPath}" "${outputPrefix}"`, { stdio: 'pipe', cwd: rutaSeguraDatos });
        return fs.readdirSync(rutaSeguraDatos).filter(f => f.startsWith(outputPrefix + '-') && f.endsWith('.png')).sort((a, b) => parseInt(a.match(/-(\d+)\.png$/)?.[1]||'0') - parseInt(b.match(/-(\d+)\.png$/)?.[1]||'0'));
    }

    /**
     * Extrae el texto embebido de un PDF usando pdftotext (Poppler).
     * Para PDFs nativos (no escaneados) esto da texto perfecto sin errores OCR.
     * Retorna string vacío si falla o si el PDF no tiene capa de texto.
     */
    function extraerTextoCapaDelPDF(pdfPath) {
        try {
            let comandoPdftotext = 'pdftotext';
            const rutaProduccion = path.join(process.resourcesPath, 'poppler', 'Library', 'bin', 'pdftotext.exe');
            const rutaDesarrollo = path.join(rutaCodigo, 'poppler', 'Library', 'bin', 'pdftotext.exe');
            if (fs.existsSync(rutaProduccion)) {
                comandoPdftotext = `"${rutaProduccion}"`;
            } else if (fs.existsSync(rutaDesarrollo)) {
                comandoPdftotext = `"${rutaDesarrollo}"`;
            }
            // -layout preserva el layout de columnas, "-" envía a stdout
            const resultado = execSync(`${comandoPdftotext} -layout "${pdfPath}" -`, { stdio: 'pipe' });
            return resultado.toString('utf8') || '';
        } catch (e) {
            return ''; // PDF escaneado o pdftotext no disponible — ignorar silenciosamente
        }
    }

    function extraerTextoAnexoDesdeCapaPDF(textoPDF) {
        if (!textoPDF) return '';
        const marcadoresAnexo = /DETALLE\s+DE\s+LA\s+FACTURA|TRAZABILIDAD|DETALLE\s+DE\s+CONSUMOS|PRODUCTOS_GTIN_PRODUCTO_1|H,Clinica|F,DISPENSA/i;
        const paginas = textoPDF.split(/\f/g);
        const idxPagina = paginas.findIndex(p => marcadoresAnexo.test(p));
        if (idxPagina !== -1) return paginas.slice(idxPagina).join('\n\f\n').trim();

        const idx = textoPDF.search(marcadoresAnexo);
        return idx !== -1 ? textoPDF.substring(idx).trim() : '';
    }

    async function hacerOCRDeImagen(rutaImagen) {
        sendLog(`🔍 Leyendo datos de la imagen con OCR...`);
        const result = await Tesseract.recognize(path.join(rutaSeguraDatos, rutaImagen), 'spa+eng');
        return result.data.text || '';
    }

    // ============================================================
    // NOTA: Las funciones limpiarImporte, extraerDatos y extraerDatosAnexo
    // ahora viven en la carpeta parsers/. Se importan arriba.
    // ============================================================

    async function leerYProcesarPDF(pdfPath) {
        const imagenes = convertirPdfAImagenes(pdfPath, 'pagina');
        const textoPDF = extraerTextoCapaDelPDF(pdfPath);
        let textoTotal = '', textoAnexo = '', datos = {};
        let parserDetectado = null;
        
        for (let i = imagenes.length - 1; i >= 0; i--) {
            const textoPagina = await hacerOCRDeImagen(imagenes[i]);
            
            let textoMayus = textoPagina.toUpperCase();
            let esAnexo = textoMayus.includes('DETALLE DE LA FACTURA') || textoMayus.includes('TRAZABILIDAD');
            
            if (!esAnexo && textoMayus.includes('GTIN')) {
                const esFacturaTakeda = textoMayus.includes('TAKEDA') &&
                    textoMayus.includes('FACTURA A') &&
                    /C\.?\s*A\.?\s*E\.?/i.test(textoPagina);
                if (!esFacturaTakeda && !textoMayus.includes('ORIGINAL') && !textoMayus.includes('COMPROBANTE ELECTRÓNICO')) {
                    esAnexo = true;
                }
            }

            if (esAnexo) {
                sendLog(`   📌 Hoja de anexo/trazabilidad separada (Página ${i+1}).`);
                textoAnexo = textoPagina + '\n' + textoAnexo;
                continue; 
            }
            
            textoTotal = `\n===== ${imagenes[i]} =====\n` + textoPagina + textoTotal;

            // ============================================================
            // NUEVO: Detectar proveedor y usar el parser correspondiente
            // ============================================================
            parserDetectado = parsers.detectarProveedor(textoTotal);
            datos = parsers.extraerDatos(parserDetectado, textoTotal);

            if (datos.importe && datos.numeroComprobante && datos.fecha && datos.cae && datos.cuit) break; 
        }

        if (parserDetectado) {
            sendLog(`   🔍 Proveedor detectado: ${parserDetectado.nombre}`);
        }
        
        const textoAnexoPDF = extraerTextoAnexoDesdeCapaPDF(textoPDF);
        if (textoAnexoPDF) {
            if (textoAnexo && textoAnexo !== textoAnexoPDF) {
                sendLog(`   🔧 Anexo/trazabilidad ajustado por pdftotext para evitar errores OCR en serie.`);
            }
            textoAnexo = textoAnexoPDF;
        }

        if (!datos.importe) {
            const todosLosNumeros = [...textoTotal.replace(/\r|\n|[ \t]+/g, ' ').matchAll(/([0-9]{1,3}(?:[.\-,][0-9]{3})+[.,][0-9]{2})(?![0-9])/g)];
            if (todosLosNumeros.length > 0) {
                let maxSuelto = 0;
                for (let m of todosLosNumeros) {
                    let val = parseFloat(limpiarImporte(m[1]));
                    if (datos.cuit === '30535994540' && val > 5000000000) continue;
                    if (val > maxSuelto) maxSuelto = val;
                }
                if (maxSuelto > 0) datos.importe = maxSuelto.toFixed(2).replace('.', ',');
            }
        }
        // Si aún faltan campos clave, hacer dos intentos extra:
        //   1. Incorporar texto del anexo (útil para Orien: número de comprobante en tabla)
        //   2. Usar capa de texto del PDF con pdftotext (elimina errores OCR en PDFs nativos)
        // IMPORTANTE: 'cae' NO va en esta lista — el CAE nunca puede venir del anexo.
        // Los números de serie del anexo (14 dígitos) se confunden con el CAE.
        const camposFaltantes = ['puntoVenta', 'numeroComprobante'].filter(k => !datos[k]);
        // Intento 1: combinar con texto del anexo (si faltan campos de numeración)
        if (camposFaltantes.length > 0 && textoAnexo && parserDetectado) {
            const textoConAnexo = textoTotal + '\n===== ANEXO_EXTRA =====\n' + textoAnexo;
            const datosExtra = parsers.extraerDatos(parserDetectado, textoConAnexo);
            for (const campo of camposFaltantes) {
                if (datosExtra[campo]) datos[campo] = datosExtra[campo];
            }
        }

        // Intento 2: texto embebido del PDF (pdftotext — texto exacto, sin errores OCR).
        // Se ejecuta SIEMPRE cuando hay parser detectado: el OCR puede confundir dígitos
        // (ej. 9→0 en el CAE) aunque el campo no esté vacío, y eso hace que AFIP rechace.
        // Para PDFs escaneados, extraerTextoCapaDelPDF devuelve '' → sin cambios.
        if (parserDetectado) {
            const aun = ['cae', 'puntoVenta', 'numeroComprobante'].filter(k => !datos[k]);
            if (textoPDF) {
                // Truncar el texto en el inicio del anexo ("DETALLE DE LA FACTURA:").
                // pdftotext extrae TODAS las páginas: sin este corte, los números de serie
                // del anexo (14 dígitos) se confunden con el CAE en el fallback.
                let textoSoloFactura = textoPDF;
                const idxAnexo = textoPDF.search(/DETALLE\s+DE\s+LA\s+FACTURA/i);
                if (idxAnexo !== -1) textoSoloFactura = textoPDF.substring(0, idxAnexo);
                const datosPDF = parsers.extraerDatos(parserDetectado, textoSoloFactura);
                // Campos faltantes: completar si el parser los encontró
                for (const campo of aun) {
                    if (datosPDF[campo]) datos[campo] = datosPDF[campo];
                }
                // CAE: siempre preferir pdftotext — el OCR puede confundir dígitos (9↔0)
                if (datosPDF.cae) {
                    if (datos.cae && datos.cae !== datosPDF.cae) {
                        sendLog(`   🔧 CAE ajustado por pdftotext: ${datos.cae} → ${datosPDF.cae}`);
                    }
                    datos.cae = datosPDF.cae;
                }
                // Importe: preferir pdftotext solo si encontró un valor >= al del OCR.
                // Si pdftotext cae al fallback (último número grande) puede devolver un
                // subtotal menor (ej. II.BB.Farmanet) cuando el box TOTAL no está en la
                // capa de texto del PDF (campo de formulario no legible por pdftotext).
                if (datosPDF.importe) {
                    const ocrVal = parseFloat(datos.importe || 0);
                    const pdfVal = parseFloat(datosPDF.importe);
                    if (pdfVal >= ocrVal) {
                        if (datos.importe && datos.importe !== datosPDF.importe) {
                            sendLog(`   🔧 Importe ajustado por pdftotext: ${datos.importe} → ${datosPDF.importe}`);
                        }
                        datos.importe = datosPDF.importe;
                    } else {
                        sendLog(`   ℹ️ pdftotext importe (${datosPDF.importe}) < OCR (${datos.importe}), se conserva OCR`);
                    }
                }
                // Tipo de emisión: solo actualizar a 'anticipada' (nunca degradar)
                if (datosPDF.tipoEmisionTexto === 'anticipada' && datos.tipoEmisionTexto !== 'anticipada') {
                    datos.tipoEmisionTexto = 'anticipada';
                }
            }
        }

        datos.textoAnexo = textoAnexo;
        datos.textoOCR   = textoTotal;   // Para debug en caso de campos faltantes
        datos._parser = parserDetectado; // Guardamos el parser para el anexo después
        return datos;
    }

    function limpiarArchivosTemporales() {
        fs.readdirSync(rutaSeguraDatos).forEach(archivo => {
            if (/^pagina-\d+\.png$/i.test(archivo) || archivo === 'ocr_resultado.txt') try { fs.unlinkSync(path.join(rutaSeguraDatos, archivo)); } catch(e){}
        });
    }

    async function completarDropdown(activePage, labelText, textoATipear) {
        const sel = `::-p-xpath(//label[normalize-space(text())="${labelText}"]/parent::*//*[contains(@class, "select2-selection") or contains(@class, "ng-select-container") or @role="combobox" or contains(text(), "Seleccione")])`;
        await activePage.waitForSelector(sel, { timeout: 5000 });
        await activePage.click(sel); await new Promise(r => setTimeout(r, 800));
        if (textoATipear) { await activePage.keyboard.type(textoATipear, { delay: 50 }); await new Promise(r => setTimeout(r, 800)); await activePage.keyboard.press('Enter'); }
        else { await activePage.keyboard.press('ArrowDown'); await new Promise(r => setTimeout(r, 200)); await activePage.keyboard.press('Enter'); }
    }

    async function clickBreadcrumbFacturas(activePage) {
        const clicked = await activePage.evaluate(() => {
            const visibles = Array.from(document.querySelectorAll('a, button, span'))
                .filter(el => el.offsetParent !== null && el.textContent.trim() === 'Facturas');
            const candidato = visibles.find(el => el.closest('.breadcrumb') || el.tagName.toLowerCase() === 'a') || visibles[0];
            if (!candidato) return false;
            candidato.scrollIntoView({ block: 'center', inline: 'center' });
            candidato.click();
            return true;
        });
        if (!clicked) throw new Error('No se encontro el link "Facturas" para volver desde Medicamentos.');
    }

    async function clickGuardarVisible(activePage, contexto = 'formulario') {
        await activePage.waitForFunction(() => {
            return Array.from(document.querySelectorAll('button')).some(btn => {
                const visible = btn.offsetParent !== null;
                const habilitado = !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
                return visible && habilitado && btn.innerText.trim() === 'Guardar';
            });
        }, { timeout: 15000 });

        const clicked = await activePage.evaluate(() => {
            const botones = Array.from(document.querySelectorAll('button'));
            const btnGuardar = botones.reverse().find(btn => {
                const visible = btn.offsetParent !== null;
                const habilitado = !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
                return visible && habilitado && btn.innerText.trim() === 'Guardar';
            });
            if (!btnGuardar) return false;
            btnGuardar.scrollIntoView({ block: 'center', inline: 'center' });
            btnGuardar.click();
            return true;
        });

        if (!clicked) throw new Error(`No se pudo ubicar el boton Guardar de ${contexto}.`);
    }

    async function entrarAMedicamentosDesdeFactura(activePage, timeout = 30000) {
        const yaEnMedicamentos = await activePage.evaluate(() => {
            const txt = document.body.innerText || '';
            return txt.includes('Agregar medicamento') &&
                txt.includes('Nro de serie') &&
                txt.includes('Valor erogado');
        });
        if (yaEnMedicamentos) return;

        await activePage.waitForFunction(() => {
            return Array.from(document.querySelectorAll('button, a'))
                .some(el => el.offsetParent !== null && el.innerText.includes('Vincularle medicamentos'));
        }, { timeout });

        const clicked = await activePage.evaluate(() => {
            const btnVincular = Array.from(document.querySelectorAll('button, a'))
                .find(el => el.offsetParent !== null && el.innerText.includes('Vincularle medicamentos'));
            if (!btnVincular) return false;
            btnVincular.scrollIntoView({ block: 'center', inline: 'center' });
            btnVincular.click();
            return true;
        });
        if (!clicked) throw new Error('No se pudo entrar a Vincularle medicamentos.');
        await new Promise(r => setTimeout(r, 3000));
    }

    async function esperarMedicamentosTrasCorreccionFactura(activePage) {
        while (true) {
            try {
                await entrarAMedicamentosDesdeFactura(activePage, 120000);
                return;
            } catch (e) {
                sendLog(`⚠️ Todavía no puedo seguir a Medicamentos: ${e.message}`);
                await esperarBotonWeb("No encuentro todavía 'Vincularle medicamentos'. Guardá la factura manualmente y esperá a ver ese botón, o entrá a Medicamentos. Después presioná Continuar.");
            }
        }
    }

    function formatearValorErogadoExcel(valor) {
        if (!valor) return '';
        const limpio = limpiarImporte(valor);
        const numero = Number(limpio);
        return Number.isFinite(numero) ? numero.toFixed(2) : String(limpio).replace(',', '.');
    }

    function formatearMes(periodoNumerico) {
        const nombresMeses = { '01':'Enero', '02':'Febrero', '03':'Marzo', '04':'Abril', '05':'Mayo', '06':'Junio', '07':'Julio', '08':'Agosto', '09':'Septiembre', '10':'Octubre', '11':'Noviembre', '12':'Diciembre' };
        return `${nombresMeses[periodoNumerico.substring(4, 6)]} ${periodoNumerico.substring(0, 4)}`;
    }

    async function iniciarRobot() {
        sendLog('🤖 Iniciando el Robot de Procesamiento...');
        
        let rutaChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
        if (!fs.existsSync(rutaChrome)) rutaChrome = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

        const browser = await puppeteer.launch({ 
            headless: false, 
            defaultViewport: null,
            executablePath: fs.existsSync(rutaChrome) ? rutaChrome : undefined
        });
        const page = await browser.newPage();
        
        sendLog(`🌐 Navegando al sistema SSSalud...`);
        await page.goto('https://cuentas.sssalud.gob.ar/login', { waitUntil: 'networkidle2' });

        await esperarBotonWeb("Inicia sesión manualmente en la ventana que se abrió.");

        const todosLosArchivos = fs.readdirSync(carpetaFacturas);
        const archivosFactura = todosLosArchivos.filter(f => f.toUpperCase().includes('FACTURA') && f.toUpperCase().endsWith('.PDF'));
        
        if (archivosFactura.length === 0) {
            sendLog('❌ No se encontraron archivos de FACTURA válidos en la carpeta segura.');
            await browser.close();
            return;
        }
        sendLog(`🚀 Procesando ${archivosFactura.length} facturas...`);

        for (const archivo of archivosFactura) {
            try {
                sendLog('\n---------------------------------------------------------');
                sendLog(`📂 Procesando: ${archivo}`);
                
                const matchBase = archivo.match(/^(.*?)\s*-\s*FACTURA.*\.pdf$/i);
                if (!matchBase) throw new Error(`Formato incorrecto`);
                const baseName = matchBase[1].trim(), partes = baseName.split('-').map(p=>p.trim());
                const periodo = partes[0], cuil = partes[1], nombre = partes.slice(2).join(' - '), mesTexto = formatearMes(periodo);
                
                sendLog(`👤 Afiliado: ${nombre} | CUIL: ${cuil} | Período: ${periodo}`);

                const archivosAfil = todosLosArchivos.filter(f => f.startsWith(baseName));
                const arcRem = archivosAfil.find(f => f.toUpperCase().includes('REMITO'));
                const arcComp = archivosAfil.find(f => f.toUpperCase().includes('COMPROBANTE'));
                const arcOP = archivosAfil.find(f => f.toUpperCase().includes('- OP') || f.toUpperCase().endsWith(' OP.PDF'));
                
                limpiarArchivosTemporales();
                const rutaPdf = path.join(carpetaFacturas, archivo);
                const datosListos = await leerYProcesarPDF(rutaPdf);
                
                const faltan = ['cuit','cae','fecha','importe','puntoVenta','numeroComprobante'].filter(k => !datosListos[k]);
                if (faltan.length > 0) {
                    const ocrFlat = (datosListos.textoOCR || '').replace(/\n/g,' ');
                    sendLog(`📋 [DEBUG] Datos: cuit=${datosListos.cuit} | cae=${datosListos.cae} | fecha=${datosListos.fecha} | importe=${datosListos.importe} | pv=${datosListos.puntoVenta} | nro=${datosListos.numeroComprobante}`);
                    // Mostrar contexto alrededor de "CAEA" si existe
                    const idxCaeaDbg = ocrFlat.search(/C\.?A\.?E\.?A/i);
                    if (idxCaeaDbg !== -1) {
                        sendLog(`📋 [DEBUG CAEA encontrado] ...${ocrFlat.substring(Math.max(0,idxCaeaDbg-30), idxCaeaDbg+200)}...`);
                    } else {
                        sendLog(`📋 [DEBUG] "CAEA" NO aparece en el OCR. Últimos 600 chars: ${ocrFlat.slice(-600)}`);
                    }
                    // Mostrar todos los números de 14 dígitos encontrados
                    const nums14 = [...ocrFlat.matchAll(/(?<![0-9])([0-9]{14})(?![0-9])/g)].map(m=>m[1]);
                    sendLog(`📋 [DEBUG] Números de 14 dígitos en OCR: ${nums14.join(' | ') || '(ninguno)'}`);
                    throw new Error(`Faltan datos en PDF: ${faltan.join(', ')}`);
                }
                const datosAnexo = parsers.extraerDatosAnexo(datosListos._parser, datosListos.textoAnexo, datosListos.importe);
                const esHelios = datosListos._parser && /helios/i.test(datosListos._parser.nombre || '');
                const cantidadMedicamentos = datosAnexo.medicamentos ? datosAnexo.medicamentos.length : (datosAnexo.gtin ? 1 : 0);
                const esquemaHelios = esHelios
                    ? (cantidadMedicamentos >= 2 ? 'ESQUEMA COMBINADO' : 'ESQUEMA COMPLETO')
                    : '';
                if (esquemaHelios) {
                    sendLog(`   🧭 HELIOS: ${cantidadMedicamentos} medicamento(s), buscando ${esquemaHelios}.`);
                }
                sendLog('✅ PDF principal leído correctamente. Iniciando navegación...');

                const activePage = (await browser.pages()).pop();
                try {
                await clickearPorTextoPreciso(activePage, "Empadronamientos"); await new Promise(r => setTimeout(r, 800));
                await clickearPorTextoPreciso(activePage, "Todos"); await new Promise(r => setTimeout(r, 2000));
                try { await clickearPorTextoPreciso(activePage, "Filtros", 3000); await new Promise(r => setTimeout(r, 1200)); } catch(e){}

                const selBuscador = '::-p-xpath(//label[contains(text(), "Cuil beneficiario")]/parent::*//input)';
                await activePage.waitForSelector(selBuscador, {timeout:5000}); await activePage.click(selBuscador, {clickCount:3}); await activePage.keyboard.press('Backspace');
                await activePage.type(selBuscador, cuil, {delay:30}); await activePage.keyboard.press('Enter'); await new Promise(r => setTimeout(r, 3000));

                sendLog('➡️ Buscando solicitud correcta por fecha...');
                await activePage.waitForSelector('::-p-xpath(//*[@title="Ver solicitudes de reintegro"])', {timeout:12000});
                
                const clickSol = await activePage.evaluate((y, m, esquemaReq) => {
                    const targetYYYYMM = y * 100 + m; 
                    const ths = Array.from(document.querySelectorAll('th'));
                    const iIni = ths.findIndex(th => th.innerText.toLowerCase().includes('vigencia inicio'));
                    const iFin = ths.findIndex(th => th.innerText.toLowerCase().includes('vigencia fin'));
                    const mo = { 'enero':1,'febrero':2,'marzo':3,'abril':4,'mayo':5,'junio':6,'julio':7,'agosto':8,'septiembre':9,'octubre':10,'noviembre':11,'diciembre':12 };
                    const parse = (s) => { const ma=s.toLowerCase().match(/(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})/); return ma ? new Date(parseInt(ma[3]), mo[ma[2]]-1, parseInt(ma[1])) : null; };
                    const normalizar = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
                    const esquemaOk = (tr) => !esquemaReq || normalizar(tr.innerText).includes(normalizar(esquemaReq));

                    if (iIni !== -1 && iFin !== -1) {
                        for (let tr of document.querySelectorAll('tr')) {
                            const tds = tr.querySelectorAll('td');
                            if (tds.length > Math.max(iIni, iFin)) {
                                const dI = parse(tds[iIni].innerText), dF = parse(tds[iFin].innerText);
                                if (dI && dF) {
                                    const valI = dI.getFullYear() * 100 + (dI.getMonth() + 1);
                                    const valF = dF.getFullYear() * 100 + (dF.getMonth() + 1);
                                    if (targetYYYYMM >= valI && targetYYYYMM <= valF && esquemaOk(tr)) {
                                        const btn = tr.querySelector('[title="Ver solicitudes de reintegro"]');
                                        if (btn) { btn.scrollIntoView({block:'center'}); btn.click(); return true; }
                                    }
                                }
                            }
                        }
                    }
                    if (esquemaReq) return false;
                    const fBtn = document.querySelector('[title="Ver solicitudes de reintegro"]');
                    if (fBtn) { fBtn.scrollIntoView({block:'center'}); fBtn.click(); return true; }
                    return false;
                }, parseInt(periodo.substring(0,4)), parseInt(periodo.substring(4,6)), esquemaHelios);
                
                if(!clickSol) throw new Error(esquemaHelios ? `No se halló solicitud HELIOS con ${esquemaHelios}.` : 'No se halló el botón solicitudes.');
                await new Promise(r => setTimeout(r, 3000));

                await completarDropdown(activePage, "Períodos disponibles", mesTexto);
                await clickearPorTextoPreciso(activePage, "Guardar");
                
                await activePage.waitForFunction((p) => Array.from(document.querySelectorAll('tr')).some(tr=>tr.innerText.includes(p)), {timeout:15000}, periodo);
                const clkFac = await activePage.evaluate((p) => {
                    const fila = Array.from(document.querySelectorAll('tr')).find(tr => tr.innerText.includes(p));
                    if(fila) {
                        let b = Array.from(fila.querySelectorAll('[title]')).find(b=>b.getAttribute('title').toLowerCase().includes('factura')) || fila.querySelector('td:first-child a, td:first-child button');
                        if(b) { b.scrollIntoView({block:'center'}); b.click(); return true; }
                    } return false;
                }, periodo);
                if(!clkFac) throw new Error('No se ubicó botón FACTURA en fila.');
                await new Promise(r => setTimeout(r, 4000));

                const bAgF = '::-p-xpath(//*[contains(translate(text(), "AGRE", "agre"), "agregar factura")])';
                await activePage.waitForSelector(bAgF, {timeout:10000}); await activePage.click(bAgF); await new Promise(r => setTimeout(r, 3000));
                await completarDropdown(activePage, "Tipo de factura", "AFIP"); await new Promise(r => setTimeout(r, 1000));

                sendLog('✍️ Completando formulario principal...');
                await completarDropdown(activePage, "Tipo de comprobante", datosListos.tipoComprobanteTexto);
                await completarDropdown(activePage, "Tipo de emisión", datosListos.tipoEmisionTexto);
                await completarDropdown(activePage, "Cuil/Cuit receptor", "30654855168"); 

                const selCuit = 'input[placeholder*="cuit del prestador" i]';
                await activePage.waitForSelector(selCuit, {timeout:5000}); await activePage.click(selCuit, {clickCount:3}); await activePage.keyboard.press('Backspace');
                await activePage.type(selCuit, datosListos.cuit, {delay:30});
                await activePage.type('input[placeholder*="punto de venta" i]', datosListos.puntoVenta, {delay:30});
                await activePage.type('::-p-xpath(//label[contains(., "mero comprobante")]/parent::*//input)', datosListos.numeroComprobante, {delay:30});
                const selF = 'input[placeholder*="fecha" i]'; await activePage.click(selF, {clickCount:3}); await activePage.keyboard.press('Backspace'); await activePage.type(selF, datosListos.fecha, {delay:30});
                await activePage.type('input[placeholder*="numero de" i]', datosListos.cae, {delay:30});
                const selI = '::-p-xpath(//label[contains(., "Importe")]/parent::*//input)'; await activePage.click(selI, {clickCount:3}); await activePage.keyboard.press('Backspace'); await activePage.type(selI, datosListos.importe, {delay:30});

                sendLog('☁️ Subiendo PDFs...');
                await (await activePage.waitForSelector('::-p-xpath(//label[contains(., "Archivo de factura")]/parent::*//input[@type="file"])')).uploadFile(path.join(carpetaFacturas, archivo));
                if (arcRem) await (await activePage.waitForSelector('::-p-xpath(//label[contains(., "Archivo de remito")]/parent::*//input[@type="file"])')).uploadFile(path.join(carpetaFacturas, arcRem));
                if (arcComp) await (await activePage.waitForSelector('::-p-xpath(//label[contains(., "Archivo de transferencia")]/parent::*//input[@type="file"])')).uploadFile(path.join(carpetaFacturas, arcComp));
                if (arcOP) await (await activePage.waitForSelector('::-p-xpath(//label[contains(., "Archivo de orden de pago")]/parent::*//input[@type="file"])')).uploadFile(path.join(carpetaFacturas, arcOP));

                const numSol = await activePage.evaluate(() => { const m = document.body.innerText.match(/Solicitudes\s*>\s*#(\d+)/i) || document.body.innerText.match(/#(\d{6,8})/); return m ? m[1] : 'S/N'; });
                const valorErogadoExcel = formatearValorErogadoExcel(datosAnexo.valorErogado);
                
                const ahora = new Date();
                const dia = String(ahora.getDate()).padStart(2, '0');
                const mes = String(ahora.getMonth() + 1).padStart(2, '0');
                const anio = ahora.getFullYear();
                const hora = String(ahora.getHours()).padStart(2, '0');
                const minutos = String(ahora.getMinutes()).padStart(2, '0');
                const fechaCarga = `${dia}/${mes}/${anio} ${hora}:${minutos}`;

                const arcExcel = path.join(rutaEscritorio, 'Registro_Cargas_SSSalud.xlsx');
                let dEx = [];
                if (fs.existsSync(arcExcel)) dEx = xlsx.utils.sheet_to_json(xlsx.readFile(arcExcel).Sheets['Cargas']);
                dEx = dEx.map(row => ({ ...row, 'VALOR EROGADO': row['VALOR EROGADO'] || '' }));
                
                dEx.push({
                    'AFILIADO': nombre, 
                    'CUIL': cuil, 
                    'PERIODO': periodo, 
                    'N SOLICITUD': numSol, 
                    'ESTADO': 'Cargado',
                    'VALOR EROGADO': valorErogadoExcel,
                    'FECHA DE CARGA': fechaCarga 
                });

                const nwS = xlsx.utils.json_to_sheet(dEx); 
                nwS['!cols'] = [ {wch:35}, {wch:15}, {wch:10}, {wch:15}, {wch:10}, {wch:15}, {wch:20} ];
                
                const nwB = xlsx.utils.book_new(); 
                xlsx.utils.book_append_sheet(nwB, nwS, 'Cargas'); 
                xlsx.writeFile(nwB, arcExcel);
                sendLog(`   📊 Excel guardado exitosamente en tu Escritorio.`);

                sendLog('💾 Guardando factura principal en el sistema...');
                await clickGuardarVisible(activePage, 'factura principal');
                
                sendLog('⏳ Esperando confirmación y navegando a Medicamentos...');
                await entrarAMedicamentosDesdeFactura(activePage);
                } catch (errorFactura) {
                    sendLog(`⚠️ Error en la carga de factura: ${errorFactura.message}`);
                    await esperarBotonWeb("Corregí y guardá la factura manualmente. Cuando veas el botón 'Vincularle medicamentos' o estés en Medicamentos, presioná Continuar para seguir con esta misma solicitud.");
                    sendLog('▶️ Continuando con medicamentos de la misma solicitud...');
                    await esperarMedicamentosTrasCorreccionFactura(activePage);
                }

                try {
                const listaMedicamentos = datosAnexo.medicamentos || [datosAnexo];
                if (datosAnexo.medicamentos) sendLog(`💊 Helios multi-med: ${listaMedicamentos.length} medicamentos detectados, se cargarán en secuencia...`);

                for (const med of listaMedicamentos) {
                sendLog('💊 Agregando Medicamento...');
                const btnAgregarMed = '::-p-xpath(//button[contains(translate(text(), "AGRE", "agre"), "agregar medicamento")] | //a[contains(translate(text(), "AGRE", "agre"), "agregar medicamento")])';
                await activePage.waitForSelector(btnAgregarMed, { timeout: 10000 });
                await activePage.click(btnAgregarMed);
                await new Promise(r => setTimeout(r, 2000));

                sendLog(`   📊 Datos extraídos -> Serie: ${med.serie} | GTIN: ${med.gtin} | Presc: ${med.fechaPrescripcion} | Disp: ${med.fechaDispensa} | Valor Erogado: ${med.valorErogado}`);

                // PRIMERO: Modal para Buscar Medicamento por GTIN
                const btnSelectMed = '::-p-xpath(//button[contains(translate(text(), "SELEC", "selec"), "seleccionar medicamento")])';
                await activePage.waitForSelector(btnSelectMed, { timeout: 5000 });
                await activePage.click(btnSelectMed);
                sendLog('🔍 Buscando GTIN en el listado...');
                await new Promise(r => setTimeout(r, 2000));

                try {
                    await clickearPorTextoPreciso(activePage, "Filtros", 5000);
                    await new Promise(r => setTimeout(r, 1000));

                    const selInputGTIN = 'input[placeholder="GTIN" i]';
                    await activePage.waitForSelector(selInputGTIN, { timeout: 5000 });
                    await activePage.click(selInputGTIN, { clickCount: 3 });
                    await activePage.keyboard.press('Backspace');
                    await activePage.type(selInputGTIN, med.gtin, { delay: 35 });
                    await activePage.keyboard.press('Enter');
                    await new Promise(r => setTimeout(r, 2500));

                    sendLog('👆 Clickeando el botón "Seleccionar" de la grilla...');
                    const btnSeleccionarGrilla = '::-p-xpath(//td//button[normalize-space(text())="Seleccionar"])';
                    await activePage.waitForSelector(btnSeleccionarGrilla, { timeout: 5000 });
                    await activePage.click(btnSeleccionarGrilla);
                    await new Promise(r => setTimeout(r, 2000));
                } catch (e) {
                    sendLog(`⚠️ No se pudo auto-seleccionar el medicamento. GTIN: ${med.gtin}`);
                    await esperarBotonWeb(`Seleccioná manualmente el medicamento usando el GTIN: ${med.gtin}. Luego presioná Continuar.`);
                }

                // SEGUNDO: Llenar Formulario de Medicamentos (Fechas, Serie, Valor)
                sendLog('✍️ Completando fechas y datos del medicamento...');
                const selPresc = 'input[placeholder*="prescripc" i]';
                await activePage.waitForSelector(selPresc, { timeout: 5000 });
                await activePage.click(selPresc, { clickCount: 3 }); await activePage.keyboard.press('Backspace');
                if (med.fechaPrescripcion) await activePage.type(selPresc, med.fechaPrescripcion, { delay: 30 });

                const selDisp = 'input[placeholder*="dispensa" i]';
                await activePage.click(selDisp, { clickCount: 3 }); await activePage.keyboard.press('Backspace');
                if (med.fechaDispensa) await activePage.type(selDisp, med.fechaDispensa, { delay: 30 });

                const selSerie = 'input[placeholder*="serie" i]';
                await activePage.click(selSerie, { clickCount: 3 }); await activePage.keyboard.press('Backspace');
                if (med.serie) await activePage.type(selSerie, med.serie, { delay: 30 });

                const selValor = '::-p-xpath(//label[contains(., "Valor erogado")]/parent::*//input)';
                await activePage.click(selValor, { clickCount: 3 }); await activePage.keyboard.press('Backspace');
                if (med.valorErogado) await activePage.type(selValor, med.valorErogado, { delay: 30 });

                sendLog('💾 Guardando Medicamento...');
                await clickGuardarVisible(activePage, 'medicamento');
                sendLog('⏳ Esperando listado de medicamentos...');
                await activePage.waitForFunction(() => {
                    const txt = document.body.innerText;
                    return txt.includes('Agregar medicamento') &&
                        txt.includes('Nro de serie') &&
                        txt.includes('Valor erogado');
                }, { timeout: 20000 });
                await new Promise(r => setTimeout(r, 1000));
                } // fin for medicamentos

                sendLog('↩️ Volviendo a Facturas...');
                await clickBreadcrumbFacturas(activePage);
                await activePage.waitForFunction(() => {
                    const txt = document.body.innerText;
                    return txt.includes('Facturas') &&
                        (txt.includes('Vincularle medicamentos') || txt.includes('Agregar factura') || txt.includes('Importe'));
                }, { timeout: 15000 });
                await new Promise(r => setTimeout(r, 1500));
                } catch (errorMedicamento) {
                    sendLog(`⚠️ Error en la carga de medicamento: ${errorMedicamento.message}`);
                    await esperarBotonWeb("Corregí el medicamento manualmente, volvé a Inicio y presioná Continuar para que el robot siga con el próximo archivo.");
                }
                
                sendLog(`🏁 Secuencia completada. Preparando siguiente archivo...`);
                try { await clickearPorTextoPreciso(activePage, "Inicio", 3000); await new Promise(r => setTimeout(r, 2000)); } catch(e) {}

                const dirProc = path.join(rutaEscritorio, 'Facturas_Procesadas_SSSalud');
                if(!fs.existsSync(dirProc)) fs.mkdirSync(dirProc);
                archivosAfil.forEach(f => { try{ fs.renameSync(path.join(carpetaFacturas, f), path.join(dirProc, f)); }catch(e){} });

            } catch (error) {
                sendLog(`❌ Error con ${archivo}: ${error.message}`);
                
                try {
                    const arcExcel = path.join(rutaEscritorio, 'Registro_Cargas_SSSalud.xlsx');
                    let dEx = [];
                    if (fs.existsSync(arcExcel)) dEx = xlsx.utils.sheet_to_json(xlsx.readFile(arcExcel).Sheets['Cargas']);
                    dEx = dEx.map(row => ({ ...row, 'VALOR EROGADO': row['VALOR EROGADO'] || '' }));
                    
                    const matchBase = archivo.match(/^(.*?)\s*-\s*FACTURA.*\.pdf$/i);
                    let nomE = 'Desconocido', cuilE = 'Desconocido', perE = 'Desconocido';
                    if (matchBase) {
                        const p = matchBase[1].trim().split('-').map(x=>x.trim());
                        perE = p[0] || ''; cuilE = p[1] || ''; nomE = p.slice(2).join(' - ') || '';
                    }
                    
                    dEx.push({
                        'AFILIADO': nomE, 
                        'CUIL': cuilE, 
                        'PERIODO': perE, 
                        'N SOLICITUD': 'S/N', 
                        'ESTADO': `Error: ${error.message}`,
                        'VALOR EROGADO': '',
                        'FECHA DE CARGA': 'Fallo'
                    });
                    
                    const nwS = xlsx.utils.json_to_sheet(dEx); 
                    nwS['!cols'] = [ {wch:35}, {wch:15}, {wch:10}, {wch:15}, {wch:50}, {wch:15}, {wch:20} ];
                    
                    const nwB = xlsx.utils.book_new(); 
                    xlsx.utils.book_append_sheet(nwB, nwS, 'Cargas'); 
                    xlsx.writeFile(nwB, arcExcel);
                    sendLog(`   📊 Fallo registrado en el Excel.`);
                } catch(ex) {
                    sendLog(`   ⚠️ No se pudo registrar el error en Excel.`);
                }

                await esperarBotonWeb("Error detectado. Corregí en la web y luego presiona Continuar para saltar al siguiente.");
            }
        }
        sendLog('🎉 ¡FIN DEL PROCESO!');
        await browser.close();
    }

    app.listen(port, () => {
        console.log(`🚀 Servidor Interno iniciado en el puerto ${port}`);
    });
};

// npx electron-packager . "Robot SSSalud" --platform=win32 --arch=x64 --out=dist --asar --ignore="poppler" --overwrite --app-copyright="Copyright (C) 2026 Mauricio Carbon" --win32metadata.CompanyName="Mauricio Carbon" --win32metadata.FileDescription="Robot Facturador Autónomo SSSalud"
// npx electron main_18Marzo.js
// npx electron-builder --win --dir
