'use strict';

const { readFileSync, writeFileSync, mkdirSync } = require('fs');
const { join, dirname } = require('path');

const ROOT = __dirname;
const renderSrc = readFileSync(join(ROOT, 'lib', 'render.js'), 'utf8');
const mainSrc = readFileSync(join(ROOT, 'main.js'), 'utf8');

if (!/module\.exports\s*=\s*\{[\s\S]*\};?\s*$/.test(renderSrc)) {
  throw new Error('lib/render.js no longer ends in a module.exports statement; update build.js');
}

// Inline render.js into main.js. render.js ends with `module.exports = {...}`;
// the injected factory passes that object back as the renderer so main.js's own
// `module`, `require` and `exports` bindings are untouched.
const rendererFactory =
  '(function initRenderer(module) {\n' +
  renderSrc.replace(/^'use strict';\s*\n/, '') +
  '\nreturn module.exports;\n})({ exports: {} });';

const bundled = mainSrc.replace(/^const renderer = require\('\.\/lib\/render\.js'\);$/m, 'const renderer = ' + rendererFactory);

const out = join(ROOT, 'dist', 'main.js');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, bundled, { encoding: 'utf8' });
console.log('wrote ' + out + ' (' + Buffer.byteLength(bundled, 'utf8') + ' bytes)');