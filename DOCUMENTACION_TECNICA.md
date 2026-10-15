# Documentación Técnica — Robot Facturador SSSalud

> Última actualización: 2026-09-02 · Versión del robot al momento de escribir: **1.1.5**
>
> Este documento describe la arquitectura, el flujo de datos y las convenciones internas del proyecto. Está pensado como referencia para quien mantenga o extienda el código (incluyendo vos mismo dentro de unos meses).

---

## 1. Qué hace el robot

Aplicación de escritorio (Electron) que automatiza la carga de facturas médicas de proveedores/droguerías en el portal gubernamental **SSSalud** (`cuentas.sssalud.gob.ar`).

Flujo end-to-end:

1. El usuario sube PDFs de facturas (+ remito, comprobante de transferencia, orden de pago) desde la interfaz web local.
2. El robot convierte cada PDF a imágenes y les hace **OCR** (Tesseract.js), y en paralelo extrae la capa de texto nativa del PDF con **Poppler** (`pdftotext`/`pdftoppm`) cuando existe.
3. Detecta automáticamente **qué proveedor** emitió la factura y usa el parser específico de ese proveedor para extraer los datos (CUIT, CAE, fecha, importe, número de comprobante, GTIN, series de medicamentos, etc.).
4. Controla una ventana de **Chrome vía Puppeteer**, ya logueada manualmente por el usuario, y completa los formularios de SSSalud: alta de factura → vinculación de medicamentos.
5. Registra cada carga (éxito o error) en un Excel en el Escritorio del usuario (`Registro_Cargas_SSSalud.xlsx`) y mueve los PDFs procesados a `Facturas_Procesadas_SSSalud/`.

**Por qué existe:** evita la carga manual y repetitiva de facturas médicas en el portal de la SSSalud.

---

## 2. Stack tecnológico

| Capa | Tecnología |
|---|---|
| Runtime / empaquetado | Node.js + Electron 29 |
| Servidor interno | Express 4 (puerto `3000`) |
| Automatización web | Puppeteer 22 (controla Chrome instalado en la PC, no el Chromium embebido) |
| OCR | Tesseract.js 5 (idiomas `spa+eng`, modelos `.traineddata` incluidos en el repo) |
| Extracción de texto nativo de PDF | Poppler (`pdftotext.exe`, `pdftoppm.exe`, binarios embebidos en `poppler/`) |
| Subida de archivos | Multer |
| Excel | `xlsx` (SheetJS) |
| Auto-actualización | `electron-updater` contra GitHub Releases |
| UI | HTML/CSS/JS vanilla, estilo "glassmorphism cyberpunk" (sin frameworks) |
| CI/CD | GitHub Actions (build de Windows en la nube) |

No hay backend remoto ni base de datos: todo corre localmente en la PC del usuario. El único servicio externo es el propio portal de SSSalud (vía Puppeteer) y GitHub (para releases).

---

## 3. Estructura de archivos

```
rpa-surge/
├── main_18Marzo.js         # Proceso main de Electron: crea la ventana, arranca el auto-updater
├── preload.js               # Bridge IPC (contextBridge) entre main y la UI para el auto-updater
├── server_18Marzo.js        # "Cerebro" del robot: servidor Express + lógica de automatización (Puppeteer/OCR/Excel)
├── parsers/                 # Extracción de datos por proveedor (patrón Strategy). Ver sección 5.
│   ├── index.js              # Dispatcher: detecta proveedor y delega
│   ├── utils.js               # Regex y helpers compartidos + parser de anexo genérico
│   └── <proveedor>.js         # Un archivo por proveedor
├── public/
│   ├── index.html             # UI completa (HTML+CSS+JS inline, sin build step)
│   └── bg.mp4                 # Video de fondo de la UI
├── poppler/                 # Binarios de Poppler embebidos (pdftotext, pdftoppm)
├── eng.traineddata / spa.traineddata  # Modelos de Tesseract OCR (inglés y español)
├── CHANGELOG.json           # Novedades por versión — se edita a mano antes de publicar
├── package.json             # Config de electron-builder (build Windows/NSIS) + deps
├── publicar.bat             # Script de publicación: bump de versión + commit + push
├── patch-builder.js          # Parche a electron-builder para evitar fallas de firma sin admin (postinstall)
├── skip-sign.js               # Función no-op usada como firmador ("sign") en electron-builder
├── Iniciar_Robot.bat          # Script legacy para levantar el server standalone (no es el flujo actual)
└── .github/workflows/release.yml  # CI: build del .exe y publish a GitHub Releases
```

Carpetas generadas y no versionadas relevantes: `dist/` (salida de electron-builder / electron-packager), `node_modules/`.

### 3.1 Datos en runtime (no en el repo)

El robot separa el código (`rutaCodigo` = `__dirname`) de los datos de usuario:

- **`app.getPath('userData')`** → `%APPDATA%/Robot-SSSalud/` — acá vive `facturas_pendientes/` (cola de PDFs subidos) y los archivos temporales de conversión (`pagina-N.png`).
- **`app.getPath('desktop')`** → Escritorio del usuario — acá se generan `Registro_Cargas_SSSalud.xlsx` y la carpeta `Facturas_Procesadas_SSSalud/` con los PDFs ya cargados.

Estas tres rutas se le pasan a `iniciarServidorBackend(rutaSeguraDatos, rutaCodigo, rutaEscritorio)` desde `main_18Marzo.js`.

---

## 4. Arquitectura del proceso Electron

- **`main_18Marzo.js`** (proceso main):
  - Configura `userData` en `%APPDATA%/Robot-SSSalud`.
  - Llama a `iniciarServidor(...)` (exportado por `server_18Marzo.js`) para levantar el Express interno.
  - Crea el `BrowserWindow` (1200x800, sin menú) que carga `http://localhost:3000`.
  - Configura **`electron-updater`**: descarga automática (`autoDownload = true`), instalación al cerrar (`autoInstallOnAppQuit = true`), y **no verifica firma de código** (`verifyUpdateCodeSignature` resuelve `undefined` — necesario porque los builds no están firmados).
  - 5 segundos después de cargar la ventana, si `app.isPackaged`, chequea updates contra `github.com/Maury22/RPA-SURGE/releases`.
  - Eventos de updater (`update-available`, `download-progress`, `update-downloaded`, `error`) se reenvían al renderer vía `mainWindow.webContents.send('update-status', ...)`.

- **`preload.js`**: expone `window.electron.onUpdateStatus(cb)` y `window.electron.installUpdate()` al renderer vía `contextBridge`, para que la UI muestre el progreso de descarga y dispare `quitAndInstall()` con el botón "Reiniciar ahora".

- **`server_18Marzo.js`**: no es un archivo suelto de servidor — es un módulo (`module.exports = function iniciarServidorBackend(...)`) que Electron invoca al arrancar. Corre **dentro del mismo proceso Node de Electron** (no es un proceso hijo separado).

> Nota: `webPreferences.nodeIntegration: true` está activo en la ventana principal. Es una app 100% local/interna (no carga contenido remoto no confiable más allá del propio portal SSSalud vía Puppeteer, que corre en su *propia* instancia de Chrome, separada de la ventana de Electron), pero vale tenerlo presente si en algún momento se agrega contenido externo a la UI.

---

## 5. Sistema de parsers (patrón Strategy)

### 5.1 Por qué existe

La función de extracción de datos original creció demasiado (un único parser gigante intentando cubrir todos los formatos de factura). Se refactorizó a **un módulo por proveedor**, cada uno con su propia heurística de regex adaptada al layout específico de esa factura.

### 5.2 Interfaz que debe cumplir cada parser

Cada archivo en `parsers/<proveedor>.js` exporta:

```js
module.exports = {
    CUIT: '...',            // CUIT del proveedor (string, opcional pero recomendado)
    nombre: '...',           // Nombre legible, usado en logs
    detectar(textoPlano),                          // → boolean
    extraerDatos(textoOCR),                         // → { cuit, cae, fecha, importe, puntoVenta,
                                                      //     numeroComprobante, tipoComprobanteTexto,
                                                      //     tipoEmisionTexto }
    extraerDatosAnexo(textoAnexo, importeFactura),   // → { gtin, serie, fechaPrescripcion,
                                                      //     fechaDispensa, valorErogado }
                                                      //   (opcional — si no está, se usa el fallback
                                                      //   genérico `parsearAnexo` de utils.js)
};
```

### 5.3 El dispatcher (`parsers/index.js`)

```js
const { detectarProveedor, extraerDatos, extraerDatosAnexo } = require('./parsers');
const proveedor = detectarProveedor(textoOCR);
const datos = extraerDatos(proveedor, textoOCR);
const datosAnexo = extraerDatosAnexo(proveedor, textoAnexoOCR, datos.importe);
```

`detectarProveedor` recorre el array `PARSERS` **en orden** y devuelve el primero cuyo `detectar()` matchea; si ninguno matchea, cae al parser `generico`.

### 5.4 Orden de los parsers — por qué importa

```js
const PARSERS = [
    montpellier, sanofi, bayer, merck, pfizer, globalfarm, farmanet, abbvie, helios, medifarm,
    roche, biogen, monteverde, orien, rofina, rosfar, hospitalAleman, amgen, astrazeneca,
    takeda, varifarma, tuteur,
];
```

`merck`, `pfizer`, `globalfarm`, `farmanet` y `abbvie` van **antes** que `medifarm` porque sus facturas mencionan "MEDIFARM" o "SCIENZA" como dirección de entrega en el texto OCR — si `medifarm.detectar()` se evaluara antes, daría un falso positivo. El CUIT del emisor es lo que identifica correctamente al proveedor real.

**Regla al agregar un proveedor nuevo:** si su factura puede mencionar el nombre de otro proveedor (dirección, razón social relacionada, etc.), ubicarlo *antes* de ese proveedor en el array, y preferir detectar por CUIT en vez de por texto libre cuando sea posible.

### 5.5 Proveedores activos (22 + genérico)

| Parser | Nombre | CUIT |
|---|---|---|
| `montpellier` | Química Montpellier S.A. | 30-53599454-0 |
| `sanofi` | Sanofi | 30-50144541-6 |
| `bayer` | Bayer | 30-50381106-1 |
| `merck` | Merck S.A. | 30-50383256-5 |
| `pfizer` | Pfizer S.R.L. | 30-50351851-8 |
| `globalfarm` | Globalfarm S.A. | 30-70098905-0 |
| `farmanet` | Farmanet S.A. | 30-68251941-6 |
| `abbvie` | AbbVie S.A. | 30-71239962-3 |
| `helios` | Helios Salud S.A. | 30-68210722-3 |
| `medifarm` | Medifarm (Scienza) | 30-68178305-5 |
| `roche` | Roche | 30-52744428-0 |
| `biogen` | Biogen | 30-70972491-2 |
| `monteverde` | Monte Verde | 30-70074314-0 |
| `orien` | Orien S.A. / Orien Argentina S.A. | 30-68626231-2 / 30-71153461-6 |
| `rofina` | Rofina S.A.I.C.F. | 30-53847485-8 |
| `rosfar` | Droguería ROSFAR | 30-69825514-1 |
| `hospital_aleman` | Hospital Alemán | 30-54584303-6 |
| `amgen` | Amgen Biotecnología de Argentina SRL | 30-71558864-8 |
| `astrazeneca` | AstraZeneca S.A. | 30-50077232-4 |
| `takeda` | Takeda Argentina S.A. | 30-70828215-0 |
| `varifarma` | Laboratorio Varifarma S.A. | 30-68266770-9 |
| `tuteur` | Tuteur S.A.C.I.F.I.A. | 30-58986464-2 |
| `generico` | Fallback cuando ningún parser específico matchea | — |

**Casos con anexo no estándar** (requieren `extraerDatosAnexo` propio en vez del `parsearAnexo` genérico de `utils.js`):
- **`orien`**: tabla "Detalle de consumos", completamente distinta a la tabla GTIN/Serie/Remito estándar. Puede traer **hasta 2 medicamentos** (`PRODUCTOS_GTIN/SERIE_PRODUCTO_1` y `_2`): si hay 2, devuelve `datosAnexo.medicamentos: []` y divide `MODULO_PRECIO_1` a la mitad para cada uno (misma lógica que Helios, sin el filtro de esquema).
- **`helios`**: puede traer **múltiples medicamentos** por factura (`datosAnexo.medicamentos: []`); el robot detecta si se trata de "ESQUEMA COMBINADO" (≥2 medicamentos) o "ESQUEMA COMPLETO" (1) y busca la solicitud correspondiente en el portal.

### 5.6 Utilidades compartidas (`parsers/utils.js`)

- **`limpiarImporte(valor)`** — normaliza importes en formato argentino (`1.234.567,89`) a formato decimal punto (`1234567.89`).
- **`normalizarTexto(texto)`** / **`textoEnLinea(texto)`** — preparan el texto OCR para matching (colapsan espacios/saltos de línea).
- **`normalizarSerieMedicamento(serie)`** — recorta caracteres basura al inicio/fin de la serie.
- **Regex reutilizables**: `REGEX_CUIT`, `REGEX_COMPROBANTE`, `REGEX_FECHA`, `REGEX_IMPORTE`, `REGEX_CAE_14`, `REGEX_GTIN`.
- **`parsearAnexo(textoAnexo, importeFactura)`** — parser genérico de la hoja de anexo/trazabilidad (tabla GTIN / Nro. de Serie / Fecha Prescripción / Fecha Dispensa / Valor Erogado). Es el fallback que usan todos los proveedores salvo `orien` y `helios`.

### 5.7 Cómo agregar un proveedor nuevo

1. Crear `parsers/nombre_proveedor.js` implementando `detectar()`, `extraerDatos()` y (si el anexo tiene formato estándar) omitir `extraerDatosAnexo` para heredar el genérico.
2. Importarlo y agregarlo al array `PARSERS` en `parsers/index.js`, respetando el orden si hay riesgo de falso positivo con otro proveedor (ver 5.4).
3. No tocar `generico.js` salvo para lógica verdaderamente genérica que aplique a *todos* los proveedores no identificados.

---

## 6. Pipeline de lectura de un PDF (`leerYProcesarPDF`)

Ubicado en `server_18Marzo.js`. Es la parte más delicada del sistema porque combina OCR y texto nativo del PDF para maximizar precisión:

1. **`convertirPdfAImagenes`**: usa `pdftoppm` (300 DPI) para rasterizar cada página del PDF a PNG.
2. **`extraerTextoCapaDelPDF`**: en paralelo, usa `pdftotext -layout` para extraer el texto nativo embebido (si el PDF no es escaneado, esto da texto exacto sin errores de OCR).
3. Recorre las páginas **de atrás para adelante**, haciendo OCR (Tesseract, `spa+eng`) página por página.
4. Por cada página, decide si es la **hoja de factura** o el **anexo/trazabilidad** (heurística sobre palabras clave como `DETALLE DE LA FACTURA`, `TRAZABILIDAD`, presencia de `GTIN` sin ser la factura original, caso especial Takeda).
5. Con cada página de factura acumulada, corre `parsers.detectarProveedor` + `parsers.extraerDatos`, cortando el loop apenas están completos los 5 campos clave (`importe`, `numeroComprobante`, `fecha`, `cae`, `cuit`).
6. **Fallbacks progresivos** si faltan campos:
   - Búsqueda de "el número suelto más grande" del documento como importe.
   - Reintento incorporando el texto del anexo (útil p. ej. para Orien, que trae el número de comprobante en la tabla).
   - Reintento usando la capa de texto nativa del PDF (`pdftotext`) en vez del OCR — esto es clave para corregir errores típicos de OCR como confundir `9` con `0` en el CAE. **El CAE nunca se toma del anexo** (los números de serie de 14 dígitos del anexo se confundirían con el CAE).
   - Para el importe: `pdftotext` sólo reemplaza al OCR si su valor es **mayor o igual**, para evitar tomar un subtotal parcial cuando el total no es legible en la capa de texto.
7. Devuelve `{ ...datos, textoAnexo, textoOCR, _parser }` — `_parser` se guarda para usarlo después en `extraerDatosAnexo`.

### 6.1 Validación previa a la carga web

Antes de tocar el navegador, se valida que estén los 5 campos clave (`cuit`, `cae`, `fecha`, `importe`, `puntoVenta`, `numeroComprobante`); si falta alguno, se aborta ese archivo con log de debug detallado (contexto alrededor de "CAEA", números de 14 dígitos encontrados, etc.) y se registra el error en el Excel.

---

## 7. Automatización web (Puppeteer) contra SSSalud

`iniciarRobot()` en `server_18Marzo.js` orquesta todo el flujo contra `cuentas.sssalud.gob.ar`:

1. Lanza Chrome **instalado en la PC** (no el Chromium bundleado de Puppeteer) en modo visible (`headless: false`), porque el usuario debe loguearse manualmente.
2. Navega al login y llama a **`esperarBotonWeb(mensaje)`**: pausa la ejecución (vía una Promise que se resuelve desde `POST /api/continuar`) hasta que el usuario confirma en la UI que ya inició sesión. Este mismo mecanismo de pausa/continuar se reutiliza en cualquier punto donde el robot no puede resolver algo solo (medicamento no encontrado por GTIN, error de formulario, etc.) — el robot nunca se "cuelga" silenciosamente, siempre pide intervención humana vía log + botón.
3. Para cada PDF en la cola cuyo nombre contenga `FACTURA` y termine en `.pdf`:
   - Parsea el nombre de archivo con la convención **`PERIODO-CUIL-NOMBRE APELLIDO - FACTURA...pdf`** (ej. `202508-27123456781-PEREZ JUAN - FACTURA.pdf`) para obtener período, CUIL del afiliado y nombre.
   - Busca archivos hermanos del mismo afiliado: `REMITO`, `COMPROBANTE` (transferencia), `- OP`/` OP.PDF` (orden de pago).
   - Corre `leerYProcesarPDF` (sección 6).
   - Navega el portal: Empadronamientos → Todos → busca por CUIL del beneficiario → localiza la solicitud de reintegro cuya vigencia cubre el período (comparando fechas "vigencia inicio/fin" contra el período de la factura; para Helios, además filtra por esquema COMBINADO/COMPLETO) → abre la factura del período → completa el formulario (tipo de comprobante, tipo de emisión, CUIT prestador, punto de venta, número, fecha, CAE, importe) → sube los PDFs (factura, remito, comprobante, OP) → guarda.
   - Registra el número de solicitud (`#NNNNNN`) extraído del DOM.
   - Entra a "Vincularle medicamentos" y agrega uno o más medicamentos (loop sobre `datosAnexo.medicamentos` si existe — caso Helios — o un único ítem si no): busca el medicamento por GTIN en el modal, completa fecha de prescripción/dispensa, serie y valor erogado, guarda.
   - Vuelve a "Facturas" (breadcrumb) y sigue con el próximo archivo.
   - Escribe una fila en `Registro_Cargas_SSSalud.xlsx` (afiliado, CUIL, período, nro. de solicitud, estado, valor erogado, fecha de carga) — tanto en éxito como en error.
   - Mueve los PDFs del afiliado a `Facturas_Procesadas_SSSalud/` en el Escritorio.
4. **Manejo de errores por archivo**: cualquier excepción durante la carga de la factura o del medicamento no aborta todo el proceso — se loguea, se registra en el Excel como `Error: <mensaje>`, y se pausa con `esperarBotonWeb` para que el usuario corrija manualmente y decida si continuar con el mismo archivo o saltar al siguiente. Si el error ocurrió *después* de "Agregar factura" (`facturaManualRecuperable = true`), el robot intenta retomar el flujo desde "Vincularle medicamentos" en vez de abortar todo el afiliado.
5. **Modo automático (solo Orien y Helios)**: se activa según el parser detectado (`modoAutomatico`). Ante un error **no se pausa**:
   - Error en un medicamento → se cierra el formulario (`salirDeFormularioMedicamento`), se anota y se sigue con el próximo medicamento (ej. esquema combinado: si falla el 1º, se carga igual el 2º).
   - Cualquier otro error → se registra en el Excel como `Error (<etapa>): <mensaje>` (etapas: Lectura del PDF, Búsqueda de solicitud, Carga de factura, Navegación a Medicamentos, Medicamentos), se vuelve al inicio del portal (`recuperarNavegacionTrasError`) y se sigue con el próximo afiliado. Los PDFs quedan en la cola.
   - La fila del Excel se escribe **al final** del afiliado con el estado real: `Cargado`, `Cargado con errores: <detalle por medicamento>` o `Error (...)`.

### 7.1 Convención de nombre de archivo (crítica)

```
<PERIODO YYYYMM>-<CUIL>-<NOMBRE APELLIDO> - FACTURA[...].pdf
```

Archivos hermanos del mismo afiliado (mismo prefijo antes de `- FACTURA`):
- `... - REMITO...pdf`
- `... - COMPROBANTE...pdf` (comprobante de transferencia)
- `... - OP.pdf` / `... OP.PDF` (orden de pago)

Si el nombre no matchea el patrón `^(.*?)\s*-\s*FACTURA.*\.pdf$`, el archivo se descarta con error "Formato incorrecto".

---

## 8. Servidor Express — endpoints (`server_18Marzo.js`)

Todos bajo `http://localhost:3000`, sirviendo también estáticos de `public/`.

| Método | Ruta | Función |
|---|---|---|
| `POST` | `/api/upload` | Sube archivos (multipart, campo `archivos`) a la cola `facturas_pendientes/` vía Multer |
| `GET` | `/api/version` | Devuelve `{ version, changes }` leyendo `package.json` y `CHANGELOG.json[version]` |
| `GET` | `/api/archivos` | Lista archivos en la cola pendiente |
| `DELETE` | `/api/archivos` | Vacía la cola (borra todos los `.pdf`) |
| `DELETE` | `/api/archivos/:nombreArchivo` | Borra un archivo puntual de la cola |
| `GET` | `/api/logs` | **Server-Sent Events** — stream de logs en vivo del robot hacia la UI |
| `POST` | `/api/continuar` | Resuelve la pausa activa (`esperarBotonWeb`) para que el robot siga |
| `POST` | `/api/start` | Arranca `iniciarRobot()`; devuelve 400 si ya está corriendo (flag `robotCorriendo`) |

**Streaming de logs**: `sendLog(msg)` hace `console.log` + escribe `data: <msg>\n\n` a todos los clientes SSE conectados (array `clients`). Dos mensajes especiales sin texto de log real actúan como señales para la UI: `ACCION_REQUERIDA` (mostrar botón "Continuar") y `ROBOT_FIN` (el proceso terminó).

---

## 9. Interfaz de usuario (`public/index.html`)

- Un único archivo HTML+CSS+JS (sin build step, sin framework), estilo "glassmorphism cyberpunk" con video de fondo (`bg.mp4`).
- Se conecta a `/api/logs` (SSE) para mostrar el log en vivo y reaccionar a `ACCION_REQUERIDA` / `ROBOT_FIN`.
- Sube archivos, gestiona la cola (listar/borrar), dispara `/api/start`, y muestra el modal de changelog (`/api/version`) en la primera apertura tras cada actualización.
- Escucha `window.electron.onUpdateStatus` (vía `preload.js`) para la barra de progreso de descarga del update y el botón "Reiniciar ahora" (`window.electron.installUpdate()`).

---

## 10. Build, empaquetado y auto-actualización

### 10.1 Build local / manual

```bash
npm start                    # electron .  — corre la app en modo desarrollo
npm run build                # electron-builder --win — genera el instalador NSIS en dist/
```

`postinstall` corre automáticamente `patch-builder.js` (ver 10.3).

### 10.2 Publicación de una nueva versión — `publicar.bat`

Flujo pensado para no depender de build local (la PC de trabajo no tiene permisos de administrador ni Developer Mode de Windows):

1. Pide la nueva versión por consola.
2. Actualiza `version` en `package.json`.
3. `git add . && git commit -m "chore: bump version to X" && git push`.
4. El push a `main` con cambios en `package.json` dispara el workflow de GitHub Actions, que builda en la nube y publica el release.

> **Importante:** `CHANGELOG.json` se edita **a mano** antes de correr `publicar.bat`, agregando la entrada para la nueva versión (array de strings). No hay automatización para esto todavía.

### 10.3 Por qué existen `patch-builder.js` y `skip-sign.js`

No hay certificado de firma de código para Windows. `electron-builder` intenta leer un certificado igual y falla en máquinas sin permisos de admin. Solución:

- **`skip-sign.js`**: función `sign` no-op registrada en `package.json → build.win.sign`, evita que electron-builder intente firmar.
- **`patch-builder.js`** (corre en `postinstall`, y también se re-aplica explícitamente en el workflow de CI): parchea dos archivos internos de `app-builder-lib` (`winPackager.js`, `windowsCodeSign.js`) para que no intenten leer info de certificado ni fallen si `configuration` es `null`. Es idempotente — detecta si ya está parcheado y no rompe si cambia la versión del paquete (loguea advertencia en ese caso).

Consecuencia práctica: **el `.exe` publicado no está firmado digitalmente** — es esperable que Windows/SmartScreen muestre advertencia al instalar por primera vez.

### 10.4 CI — `.github/workflows/release.yml`

- Trigger: push a `main` que modifique `package.json`, o disparo manual (`workflow_dispatch`).
- Corre en `windows-latest`.
- Instala dependencias, vuelve a aplicar el parche de firma (por si `npm ci`/versión de electron-builder cambió el archivo original), y ejecuta `electron-builder --win --publish always` con `GH_TOKEN` (secret) para publicar directo a GitHub Releases del repo `Maury22/RPA-SURGE`.

### 10.5 Auto-actualización en runtime

Ver sección 4 — `electron-updater` chequea `github.com/Maury22/RPA-SURGE/releases` 5s después de abrir la app (sólo si `app.isPackaged`), descarga automáticamente, y se instala al reiniciar o cerrar la app. La UI muestra progreso y el changelog de la versión recién instalada al primer arranque post-update (vía `/api/version`).

---

## 11. Convenciones y notas para mantenimiento

- **Idioma**: código, comentarios y logs en español (rioplatense). Mantener esa convención al modificar o agregar código.
- **Nunca commitear** el CAE tomado del anexo — es una invariante de negocio validada explícitamente en el código (los números de serie de 14 dígitos del anexo se confunden con el CAE de 14 dígitos).
- **Cuando el OCR y `pdftotext` difieren**, el código loguea explícitamente el ajuste (`🔧 CAE ajustado por pdftotext: X → Y`) — no silenciar estos logs, son la principal herramienta de debug en producción.
- **`NODE_TLS_REJECT_UNAUTHORIZED = '0'`** está seteado globalmente al inicio de `server_18Marzo.js` — necesario por la red/proxy de la oficina donde corre el robot. Tenerlo en cuenta si se agregan llamadas HTTPS nuevas (no valida certificados).
- **`Iniciar_Robot.bat`** referencia `node server.js`, que no es el entrypoint actual (`main_18Marzo.js` vía `electron .`) — parece un script legado de una versión anterior sin empaquetar. Verificar si sigue en uso antes de confiar en él o eliminarlo.
- **Compatibilidad con empaquetado**: cualquier dependencia nueva debe funcionar dentro de un `asar` de Electron empaquetado sin admin ni Developer Mode en la máquina de build/destino (ver 10.3).

---

## 12. Glosario de dominio (SSSalud)

| Término | Significado |
|---|---|
| **CAE / CAEA** | Código de Autorización Electrónico (AFIP) / Anticipado — 14 dígitos, identifica la autorización fiscal de la factura |
| **CUIT** | Identificador fiscal del proveedor emisor de la factura |
| **CUIL** | Identificador del afiliado/beneficiario que recibió el medicamento |
| **GTIN** | Código de identificación global del medicamento (trazabilidad ANMAT) |
| **Punto de venta / Nro. comprobante** | Numeración de la factura, formato `XXXX-YYYYYYYY` |
| **Anexo / Trazabilidad** | Hoja adicional de la factura con el detalle de medicamentos entregados (GTIN, serie, fechas de prescripción/dispensa, valor erogado) |
| **Esquema COMBINADO / COMPLETO** (Helios) | Tipo de solicitud según si incluye 2+ medicamentos o 1 solo |

---

## 13. Qué es cada herramienta usada

Explicación breve de cada tecnología del stack (sección 2), pensada para alguien que no las conoce de antes.

### Electron
Framework que permite empaquetar una aplicación web (HTML/CSS/JS) como programa de escritorio instalable (`.exe` en este caso), con acceso a APIs del sistema operativo (sistema de archivos, ventanas nativas, etc.) que una página web normal no tiene. Es lo que le da al robot su ícono, su ventana propia y la posibilidad de correr sin un navegador externo. Por dentro, une dos mundos: un **proceso "main"** en Node.js (control total del sistema — acá vive `main_18Marzo.js`) y una o más ventanas ("renderer") que muestran HTML normal (acá vive `public/index.html`).

### Node.js
El motor que ejecuta JavaScript fuera del navegador. Es la base sobre la que corre todo: Electron, el servidor Express, los parsers, la lectura/escritura de archivos y Excel. Sin Node no hay nada de esto — es el "runtime" del proyecto.

### Express
Librería para levantar un servidor web en Node de forma simple. Acá se usa para crear el servidor interno (`http://localhost:3000`) que sirve la interfaz (`public/index.html`) y expone los endpoints (`/api/upload`, `/api/start`, etc.) que la UI usa para hablar con la lógica del robot. Es un servidor **local**, no expuesto a internet: solo la propia app se conecta a él.

### Puppeteer
Librería que controla un navegador Chrome/Chromium de forma programática: puede abrir páginas, hacer clic, tipear, leer el contenido de la pantalla, subir archivos, etc., como si fuera una persona usando el mouse y el teclado. Es el corazón de la automatización: es lo que efectivamente "carga las facturas" navegando el portal de SSSalud, llenando formularios y subiendo PDFs, sin que el usuario tenga que hacerlo a mano. En este proyecto usa el Chrome ya instalado en la PC (no un Chromium aparte) y corre en modo visible para que el usuario pueda loguearse manualmente al principio.

### OCR / Tesseract.js
**OCR** (Optical Character Recognition / Reconocimiento Óptico de Caracteres) es la técnica de "leer" texto a partir de una imagen — convierte los píxeles de una factura escaneada en texto real que se puede buscar con regex. **Tesseract.js** es la librería que hace ese trabajo acá: recibe la imagen de cada página de la factura (ya convertida de PDF a PNG) y devuelve el texto que logra reconocer, usando modelos de idioma entrenados (`eng.traineddata` y `spa.traineddata`, incluidos en el repo) para inglés y español. El OCR nunca es 100% exacto — puede confundir caracteres parecidos (`9` con `0`, `O` con `0`, etc.), por eso el sistema lo combina con Poppler cuando puede (ver abajo).

### Poppler (`pdftotext` / `pdftoppm`)
Conjunto de herramientas de línea de comandos para trabajar con archivos PDF, usadas acá de dos formas:
- **`pdftoppm`**: convierte cada página de un PDF en una imagen (PNG), que es lo que después se le pasa al OCR.
- **`pdftotext`**: si el PDF tiene una **capa de texto nativa** (es decir, no es solo una foto/escaneo sino que fue generado digitalmente, como la mayoría de las facturas electrónicas AFIP), extrae ese texto directamente — exacto, sin pasar por OCR y por lo tanto sin sus errores de reconocimiento. El robot usa esto como corrección/respaldo de lo que lee el OCR, priorizándolo especialmente para el CAE.

Los binarios de Poppler (`.exe`) están embebidos en la carpeta `poppler/` del proyecto, así no dependen de que estén instalados en la PC del usuario.

### xlsx (SheetJS)
Librería para leer y escribir archivos Excel (`.xlsx`) desde Node, sin necesidad de tener Excel instalado. Se usa para generar y actualizar `Registro_Cargas_SSSalud.xlsx` en el Escritorio del usuario, agregando una fila por cada factura procesada (exitosa o con error).

### Multer
Middleware de Express especializado en recibir archivos subidos desde un formulario web (`multipart/form-data`). Se usa en el endpoint `POST /api/upload` para guardar los PDFs que el usuario arrastra/selecciona en la interfaz, directamente en la carpeta `facturas_pendientes/`.

### electron-updater
Librería que le da a la app la capacidad de **auto-actualizarse**: al abrir, chequea si hay una versión más nueva publicada en GitHub Releases, la descarga en segundo plano y la instala (al reiniciar o cerrar la app), sin que el usuario tenga que bajar manualmente un instalador nuevo. Es lo que hace que, al publicar una versión nueva (sección 10.2), todos los compañeros que usan el robot la reciban solos.

### electron-builder
Herramienta que empaqueta la app de Electron en un instalador distribuible para Windows (formato **NSIS**, un `.exe` de instalación). Es lo que corre tanto en builds manuales (`npm run build`) como en GitHub Actions para generar el instalador que luego sube a GitHub Releases.

### GitHub Actions
Sistema de automatización (CI/CD) de GitHub que ejecuta workflows en máquinas virtuales en la nube al ocurrir ciertos eventos (acá, un push a `main` que modifique `package.json`). Se usa para **compilar el `.exe` en una máquina Windows en la nube** y publicarlo automáticamente como GitHub Release — así no hace falta compilar en la PC de la oficina, que no tiene permisos de administrador.

### Server-Sent Events (SSE)
Mecanismo web simple para que un servidor le mande actualizaciones en vivo a una página, sin que esta tenga que estar preguntando todo el tiempo ("polling"). Se usa en `GET /api/logs`: el navegador abre una conexión que el servidor mantiene abierta, y cada vez que el robot loguea algo (`sendLog`), esa línea se empuja instantáneamente a la interfaz — es lo que hace que el usuario vea el progreso del robot en tiempo real mientras corre.
