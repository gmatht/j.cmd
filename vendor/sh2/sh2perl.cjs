#!/usr/bin/env node
// sh2perl.js — shell → Perl, via the debashl WASM library (debashl.wasm).
//
//   const { toPerl } = require('/path/to/sh2perl.js');
//   const perl = await toPerl('echo "hello $USER"');
//
// CLI:
//   node sh2perl.js 'echo hi'            # transpile an inline script
//   node debashc.js file --perl x.sh     # transpile a file (full CLI)
'use strict';

const { loadLibrary } = require('./sh2lib');

let libPromise = null;
function lib() { return (libPromise ??= loadLibrary()); }

async function toPerl(shSource) { return (await lib()).toPerl(shSource); }
async function transpile(shSource) { return toPerl(shSource); }
async function version() { return (await lib()).version(); }

module.exports = { toPerl, transpile, version };

if (require.main === module) {
  const source = process.argv[2];
  if (!source) { console.error('usage: node sh2perl.js "<shell source>"'); process.exit(2); }
  toPerl(source)
    .then(p => process.stdout.write(p.endsWith('\n') ? p : p + '\n'))
    .catch(e => { console.error('sh2perl:', e.message); process.exit(1); });
}
