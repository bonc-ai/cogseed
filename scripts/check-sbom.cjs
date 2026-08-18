// Validate sbom.cdx.json structurally.
const path = require('node:path');
const b = require(path.join(__dirname, '..', 'sbom.cdx.json'));
const ok =
  b.bomFormat === 'CycloneDX' &&
  b.specVersion === '1.6' &&
  Array.isArray(b.components) &&
  b.components.length === 649 &&
  b.components.every((c) => typeof c.name === 'string' && c.type && c['bom-ref']) &&
  Array.isArray(b.dependencies) &&
  b.dependencies.length > 0;
console.log('structural checks:', ok ? 'PASS' : 'FAIL');

const noLic = b.components.filter((c) => !c.licenses || c.licenses.length === 0).map((c) => c.name);
console.log('components without license field:', noLic.length);
if (noLic.length) console.log('  sample:', noLic.slice(0, 12).join(', '));
