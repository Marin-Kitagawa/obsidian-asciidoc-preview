'use strict';

const esbuild = require('esbuild');
const { mkdirSync } = require('fs');
const { join, dirname } = require('path');

const ROOT = __dirname;
const out = join(ROOT, 'dist', 'main.js');
mkdirSync(dirname(out), { recursive: true });

// Obsidian loads a plugin from a single main.js evaluated with a custom
// `require` that has no relative-path resolution and only whitelists the
// `obsidian` module. Bundle everything (renderer + asciidoctor.js fallback +
// highlight.js, plus their CSS as inline text) into one CommonJS file, keeping
// `obsidian` and Node builtins external.
esbuild
  .build({
    entryPoints: [join(ROOT, 'main.js')],
    bundle: true,
    outfile: out,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['obsidian'],
    loader: { '.css': 'text' },
    legalComments: 'none',
    logLevel: 'info',
  })
  .catch(() => process.exit(1));
