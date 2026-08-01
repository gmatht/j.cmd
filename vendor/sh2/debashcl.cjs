#!/usr/bin/env node
// debashcl.cjs — the unified debashc CLI (debashcl.wasm) in a thin wrapper.
//
// debashcl.wasm is the full sh2perl command-line tool as a WASI reactor:
// one artifact replaces the old debashc.wasm (command) and debashl.wasm
// (library). The core is three lines — instantiate → _initialize →
// debashc_cli_run — everything else here is argv marshalling (C-ABI)
// and the stdout capture (the CLI writes results to WASI fd 1/2).
//
// Library:
//   const { toPerl, toEstree, lex, version } = require('./debashcl.cjs');
//   await toPerl('echo hi');      // Perl source
//   await toEstree('echo hi');    // ESTree JSON object
//
// CLI:
//   node debashcl.cjs parse 'echo hi'          # human parse dump
//   node debashcl.cjs file --estree x.sh       # ESTree JSON for a file
//   node debashcl.cjs file --perl x.sh         # Perl for a file
//   node debashcl.cjs --version
'use strict';

const { readFile } = require('node:fs/promises');
const path = require('node:path');

const WASM_PATH = path.join(__dirname, 'debashcl.wasm');
const ENOSYS = 52, EBADF = 8;

let libPromise = null;
function lib() { return (libPromise ??= loadLibrary()); }

async function loadLibrary() {
  const bytes = new Uint8Array(await readFile(WASM_PATH));
  const mem = { memory: null };
  const out = { stdout: '', stderr: '' };
  const dec = new TextDecoder();
  const imports = { wasi_snapshot_preview1: {
    random_get(ptr, len) {
      const b = new Uint8Array(mem.memory.buffer, ptr, len);
      for (let i = 0; i < len; i++) b[i] = (Math.random() * 256) | 0;
      return 0;
    },
    environ_get() { return 0; },
    environ_sizes_get(cp, sp) {
      const v = new DataView(mem.memory.buffer);
      v.setUint32(cp, 0, true); v.setUint32(sp, 0, true);
      return 0;
    },
    clock_time_get(_id, _p, ptr) {
      new DataView(mem.memory.buffer).setBigUint64(ptr, BigInt(Date.now()) * 1000000n, true);
      return 0;
    },
    fd_close() { return 0; },
    fd_fdstat_get(_fd, buf) {
      const v = new DataView(mem.memory.buffer);
      v.setUint8(buf, 2); v.setUint16(buf + 2, 0, true);
      v.setBigUint64(buf + 8, 0n, true); v.setBigUint64(buf + 16, 0n, true);
      return 0;
    },
    fd_filestat_get() { return ENOSYS; },
    fd_prestat_get() { return EBADF; },
    fd_prestat_dir_name() { return EBADF; },
    fd_read() { return ENOSYS; },
    fd_readdir() { return ENOSYS; },
    fd_write(fd, iovs, iovsLen, nwritten) {
      const view = new DataView(mem.memory.buffer);
      const b = new Uint8Array(mem.memory.buffer);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const p = view.getUint32(iovs + i * 8, true);
        const l = view.getUint32(iovs + i * 8 + 4, true);
        const s = dec.decode(b.subarray(p, p + l));
        if (fd === 1) out.stdout += s; else if (fd === 2) out.stderr += s;
        total += l;
      }
      view.setUint32(nwritten, total, true);
      return 0;
    },
    path_create_directory() { return ENOSYS; },
    path_filestat_get() { return ENOSYS; },
    path_open() { return ENOSYS; },
    path_unlink_file() { return ENOSYS; },
    poll_oneoff() { return 0; },
    proc_exit(code) { throw new Error('debashcl proc_exit(' + code + ')'); },
    sched_yield() { return 0; },
  } };

  const { instance } = await WebAssembly.instantiate(bytes, imports);
  mem.memory = instance.exports.memory;
  instance.exports._initialize();

  const enc = new TextEncoder();
  const ex = instance.exports;
  function runCli(argv, input) {
    out.stdout = ''; out.stderr = '';
    const args = ['debashc', ...argv];
    const ptrs = [];
    for (const a of args) {
      const b = enc.encode(a);
      const p = ex.debashc_alloc(b.length);
      new Uint8Array(ex.memory.buffer, p, b.length).set(b);
      ptrs.push(p);
    }
    const table = ex.debashc_alloc(4 * args.length);
    new Uint32Array(ex.memory.buffer, table, args.length).set(ptrs);
    let res;
    try {
      if (input !== undefined) {
        const ib = enc.encode(input);
        const pi = ex.debashc_alloc(ib.length);
        new Uint8Array(ex.memory.buffer, pi, ib.length).set(ib);
        res = ex.debashc_cli_run_with_input(args.length, table, pi, ib.length);
        ex.debashc_free(pi);
      } else {
        res = ex.debashc_cli_run(args.length, table);
      }
    } finally {
      for (const p of ptrs) ex.debashc_free(p);
      ex.debashc_free(table);
    }
    const n = ex.debashc_str_len(res);
    const envelope = JSON.parse(dec.decode(new Uint8Array(ex.memory.buffer, res, n)));
    ex.debashc_free(res);
    if (!envelope.ok) throw new Error(`debashcl: ${envelope.error || 'failed'}`);
    return { stdout: out.stdout, stderr: out.stderr, exit: envelope.exit ?? 0 };
  }

  const PERL_BANNER = /^Converting to Perl:\n=+\n([\s\S]*?)\n=+\n?$/;
  return {
    toEstree: (sh) => JSON.parse(runCli(['file', '--estree', '-'], String(sh)).stdout),
    toPerl: (sh) => {
      const r = runCli(['file', '--perl', '-'], String(sh)).stdout;
      const m = PERL_BANNER.exec(r);
      return m ? m[1] : r;
    },
    lex: (sh) => runCli(['lex', String(sh)]).stdout,
    version: () => 'debashc 0.1.0 (debashcl)',
    // raw CLI runner for file commands (reads the file itself)
    runCli,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) { console.error('usage: node debashcl.cjs parse|lex|file ...'); process.exit(2); }
  const l = await lib();
  try {
    if (args[0] === 'file') {
      // read the script with node's fs, pass the bytes via run_with_input
      const flag = args[1];           // --estree | --perl
      const file = args[2];
      const { readFile: rf } = require('node:fs/promises');
      const content = await rf(file, 'utf8');
      process.stdout.write(l.runCli(['file', flag, '-'], content).stdout);
    } else if (args[0] === '--version' || args[0] === '-V') {
      console.log(l.version());
    } else {
      process.stdout.write(l.runCli(args).stdout);
    }
    process.exit(0);
  } catch (e) {
    console.error('debashcl:', e.message);
    process.exit(1);
  }
}

module.exports = { toEstree: (s) => lib().then((l) => l.toEstree(s)),
                   toPerl: (s) => lib().then((l) => l.toPerl(s)),
                   lex: (s) => lib().then((l) => l.lex(s)),
                   version: () => lib().then((l) => l.version()) };

if (require.main === module) main();
