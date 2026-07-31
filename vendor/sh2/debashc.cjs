#!/usr/bin/env node
// debashc.js — full debashc from JS, two ways:
//
//  1. Library mode: debashl.wasm (reactor) — toPerl / toEstree / lex / version.
//     const { toPerl, toEstree } = require('/path/to/debashc.js');
//     await toPerl('echo hi');      // Perl source
//     await toEstree('echo hi');    // ESTree AST object
//
//  2. Command mode: debashc.wasm (WASI command, exports _start) — the real CLI.
//     run(args)        in-process via node:wasi; stdio passes through; returns exit code
//     runCapture(args) spawns `wasmtime run --dir . debashc.wasm ...` and captures output
//                      (set WASMTIME=/path/to/wasmtime or put wasmtime on PATH)
//
// CLI:
//   node debashc.js parse 'echo hi'
//   node debashc.js file --perl x.sh
//   node debashc.js file --estree x.sh
'use strict';

const { spawn } = require('node:child_process');
const { DEFAULTS, loadLibrary, loadCommand } = require('./sh2lib');

let libPromise = null;
function lib() { return (libPromise ??= loadLibrary()); }

const toPerl   = async (s) => (await lib()).toPerl(s);
const toEstree = async (s) => (await lib()).toEstree(s);
const lex      = async (s) => (await lib()).lex(s);
const version  = async () => (await lib()).version();

// In-process WASI command run (node:wasi). stdio passes through to the parent;
// files resolve against `preopens` (default: cwd, like `wasmtime --dir .`).
async function run(args, { preopens = { '.': process.cwd() } } = {}) {
  const { instance, wasi } = await loadCommand(DEFAULTS.debashcWasm, args);
  return wasi.start(instance); // exit code (returnOnExit: true)
}

// Same command, run under the wasmtime binary with captured stdout/stderr.
// Requires wasmtime on PATH or the WASMTIME env var pointing at the binary.
function runCapture(args, { wasmtime = process.env.WASMTIME || 'wasmtime', dir = process.cwd() } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(wasmtime, ['run', '--dir', dir, DEFAULTS.debashcWasm, ...args], {
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

module.exports = { toPerl, toEstree, lex, version, run, runCapture };

if (require.main === module) {
  run(process.argv.slice(2))
    .then((code) => { process.exitCode = code ?? 0; })
    .catch((e) => { console.error('debashc:', e.message); process.exit(1); });
}
