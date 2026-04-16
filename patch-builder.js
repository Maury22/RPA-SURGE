// Patches app-builder-lib to skip cert reading when no signing cert is configured.
// Run automatically via postinstall. Safe to re-run.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'node_modules/app-builder-lib/out/winPackager.js');
const original = `const cscInfoForCacheDigest = !(0, flags_1.isBuildCacheEnabled)() || isCI || config.electronDist != null ? null : await (await this.signtoolManager.value).cscInfo.value;`;
const patched  = `const cscInfoForCacheDigest = null; // patched: skip cert read (no code signing cert available)`;

const content = fs.readFileSync(file, 'utf8');
if (content.includes(original)) {
    fs.writeFileSync(file, content.replace(original, patched));
    console.log('[patch-builder] winPackager.js parcheado OK');
} else if (content.includes(patched)) {
    console.log('[patch-builder] winPackager.js ya estaba parcheado');
} else {
    console.warn('[patch-builder] ADVERTENCIA: No se encontro el patron a parchear. Puede que la version de electron-builder haya cambiado.');
}
