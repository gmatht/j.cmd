// sh2lib.js — shared loader + memory helpers for the debashl / debashc WASI modules.
//
// Memory contract (see sh2perl/src/wasi_api.rs):
//   every debashc_* string export returns a pointer into WASM linear memory to a
//   [u32 data_len LE][data][0] buffer; debashc_str_len() reads the length,
//   debashc_free() releases it. Results are JSON envelopes
//   {"ok":true,"output":"..."} / {"ok":false,"error":"..."}.
//
// Input is placed in a monotonically growing scratch region of WASM memory
// (memory only grows, so call offsets never collide; wasm calls are synchronous).
'use strict';

const { WASI } = require('node:wasi');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const DEFAULTS = {
  debashlWasm: path.join(__dirname, 'debashl.wasm'),
  debashcWasm: path.join(__dirname, 'debashc.wasm'),
};

const PAGE = 65536;
let scratchTop = 0x10000; // monotonic scratch cursor inside WASM linear memory

async function instantiate(wasmPath, { args = [], env = {}, preopens = {}, returnOnExit = true } = {}) {
  const module = await WebAssembly.compile(await readFile(wasmPath));
  const wasi = new WASI({ version: 'preview1', args, env, preopens, returnOnExit });
  const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
  return { instance, wasi };
}

// Load the library (reactor module): debashl.wasm exports debashc_to_perl,
// debashc_to_estree, debashc_lex, debashc_version, debashc_str_len, debashc_free.
// Requires the _initialize reactor entry before wasi imports (random_get) may be used.
async function loadLibrary(wasmPath = DEFAULTS.debashlWasm) {
  const { instance, wasi } = await instantiate(wasmPath, { args: ['debashl'] });
  wasi.initialize(instance);
  return wrapLibrary(instance);
}

function wrapLibrary(instance) {
  const exports = instance.exports;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function writeScratch(input) {
    const bytes = enc.encode(input);
    const off = scratchTop;
    scratchTop += (bytes.length + 3) & ~3; // keep 4-byte aligned
    const needed = off + bytes.length;
    if (exports.memory.buffer.byteLength < needed) {
      exports.memory.grow(Math.ceil((needed - exports.memory.buffer.byteLength) / PAGE));
    }
    new Uint8Array(exports.memory.buffer, off, bytes.length).set(bytes);
    return { off, len: bytes.length };
  }

  function callStringFn(fnName, input) {
    const { off, len } = writeScratch(input);
    const ptr = exports[fnName](off, len);
    if (!ptr) throw new Error(`${fnName}: wasm returned a null pointer`);
    const outLen = exports.debashc_str_len(ptr);
    const out = dec.decode(new Uint8Array(exports.memory.buffer, ptr, outLen));
    exports.debashc_free(ptr);
    const env = JSON.parse(out);
    if (!env.ok) throw new Error(`${fnName}: ${env.error}`);
    return env.output;
  }

  return {
    instance,
    // shell source → Perl source (string)
    toPerl: (sh) => callStringFn('debashc_to_perl', sh),
    // shell source → ESTree JSON object (PLAN.md §1.2 contract, sh2.* namespace)
    toEstree: (sh) => JSON.parse(callStringFn('debashc_to_estree', sh)),
    // shell source → token dump
    lex: (sh) => callStringFn('debashc_lex', sh),
    version: () => callStringFn('debashc_version', ''),
  };
}

// Load the WASI command (debashc.wasm, exports _start) for in-process CLI runs.
// Use wasi.start(instance) afterwards; stdio passes through, returns the exit code.
async function loadCommand(wasmPath = DEFAULTS.debashcWasm, args = []) {
  return instantiate(wasmPath, { args: ['debashc', ...args] });
}

module.exports = { DEFAULTS, instantiate, loadLibrary, loadCommand };
