// ─── wasi-worker.js ─────────────────────────────────────────────
// Runs a WASI module in a Web Worker with BLOCKING stdin via
// SharedArrayBuffer + Atomics.wait. Enables true interactive REPLs
// for any WASI program (python, etc.) without blocking the UI.
//
// Protocol (postMessage):
//   { type: "run", wasmBytes, args }   → main → worker
//   { type: "stdin", data }            → main → worker (keystrokes)
//   { type: "stdout", data }           → worker → main
//   { type: "exit", code }             → worker → main
// -----------------------------------------------------------------

// Shared state: a single SAB split into control + data regions
// [0]  = stdin state (0 = idle, 1 = data ready, 2 = EOF)
// [1]  = stdin data length
// [2..] = stdin data bytes
const CONTROL_OFFSET = 0;
const LENGTH_OFFSET = 1;
const DATA_OFFSET = 64;         // leave room for control words
const BUF_SIZE = 65536;         // stdin buffer size
const TOTAL_SIZE = DATA_OFFSET + BUF_SIZE;

let sab = null;
let memory = null;
let memRef = { memory: null };

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === "run") {
    sab = msg.sab;
    // Prepend args[0] = program name if missing
    const args = msg.args;

    try {
      const module = await WebAssembly.compile(msg.wasmBytes);
      const imports = WebAssembly.Module.imports(module);
      const needsEnvMem = imports.some(i => i.module === "env" && i.name === "memory");

      if (needsEnvMem) {
        memRef.memory = new WebAssembly.Memory({ initial: 256, maximum: 512 });
      }

      const instance = await WebAssembly.instantiate(module, {
        "wasi_snapshot_preview1": buildWasi(args),
        ...buildCustom(),
      });

      if (instance.exports.memory) {
        memRef.memory = instance.exports.memory;
      }

      if (instance.exports._start) {
        instance.exports._start();
      } else if (instance.exports.main) {
        instance.exports.main();
      }

      self.postMessage({ type: "exit", code: 0 });
    } catch (e) {
      self.postMessage({ type: "exit", code: 1, error: e.message });
    }
  }

  if (msg.type === "stdin") {
    // Main thread wrote keystrokes into the SAB already;
    // just mark data ready and notify.
    Atomics.store(new Int32Array(sab), CONTROL_OFFSET, 1);
    Atomics.notify(new Int32Array(sab), CONTROL_OFFSET, 1);
  }
};

function buildWasi(args) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let stdoutBuf = "";

  function mem() { return new Uint8Array(memRef.memory.buffer); }
  function view() { return new DataView(memRef.memory.buffer); }

  return {
    // ─── Blocking stdin via Atomics ──────────────────────
    fd_read: (fd, iovs, iovsLen, nread) => {
      if (fd !== 0) {
        new Uint32Array(memRef.memory.buffer, nread, 1)[0] = 0;
        return 0;
      }

      const control = new Int32Array(sab);
      const dataView = new Uint8Array(sab);

      // Wait until main thread marks data ready or EOF
      while (Atomics.load(control, CONTROL_OFFSET) === 0) {
        Atomics.wait(control, CONTROL_OFFSET, 0);
      }

      const state = Atomics.load(control, CONTROL_OFFSET);
      const len = Atomics.load(control, LENGTH_OFFSET);

      if (state === 2) {  // EOF
        // Reset for next read
        Atomics.store(control, CONTROL_OFFSET, 0);
        new Uint32Array(memRef.memory.buffer, nread, 1)[0] = 0;
        return 0;
      }

      // Copy available bytes into the guest buffer (first iovec)
      const v = view();
      const bufPtr = v.getUint32(iovs, true);
      const bufLen = v.getUint32(iovs + 4, true);
      const toCopy = Math.min(len, bufLen);

      const src = dataView.subarray(DATA_OFFSET, DATA_OFFSET + toCopy);
      mem().set(src, bufPtr);

      // Reset control for next read
      Atomics.store(control, CONTROL_OFFSET, 0);
      Atomics.store(control, LENGTH_OFFSET, 0);

      new Uint32Array(memRef.memory.buffer, nread, 1)[0] = toCopy;
      return 0;
    },

    fd_write: (fd, iovs, iovsLen, nwritten) => {
      if (fd !== 1 && fd !== 2) return 8;
      const m = mem();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const v = view();
        const p = v.getUint32(iovs + i * 8, true);
        const l = v.getUint32(iovs + i * 8 + 4, true);
        if (l > 0 && l < 100000) {
          stdoutBuf += dec.decode(m.slice(p, p + l));
          total += l;
        }
      }
      new Uint32Array(memRef.memory.buffer, nwritten, 1)[0] = total;
      // Send chunks to main thread as they accumulate
      if (stdoutBuf.length > 0) {
        self.postMessage({ type: "stdout", data: stdoutBuf });
        stdoutBuf = "";
      }
      return 0;
    },

    fd_close: () => 0,
    fd_seek: (fd, offset, whence, newoffset) => {
      if (newoffset) new BigUint64Array(memRef.memory.buffer, newoffset, 1)[0] = BigInt(0);
      return 0;
    },
    fd_prestat_get: () => 8,
    fd_prestat_dir_name: () => 8,
    fd_fdstat_get: (fd, buf) => {
      const m = mem();
      for (let i = 0; i < 24; i++) m[buf + i] = 0;
      m[buf] = 2;
      return 0;
    },
    fd_fdstat_set_flags: () => 0,
    fd_readdir: (fd, buf, bufLen, cookie, nread) => {
      new Uint32Array(memRef.memory.buffer, nread, 1)[0] = 0;
      return 0;
    },
    fd_sync: () => 0,
    sched_yield: () => 0,
    poll_oneoff: () => 0,
    path_open: () => 8,
    path_readlink: () => -1,
    path_filestat_get: () => -1,
    path_create_directory: () => -1,
    path_unlink_file: () => -1,
    path_remove_directory: () => -1,
    path_rename: () => -1,
    filestat_get: () => -1,

    environ_get: () => 0,
    environ_sizes_get: (count, size) => {
      new Uint32Array(memRef.memory.buffer, count, 1)[0] = 0;
      new Uint32Array(memRef.memory.buffer, size, 1)[0] = 0;
      return 0;
    },

    args_get: (argv, argvBuf) => {
      const m = mem();
      let offset = argvBuf;
      for (let i = 0; i < args.length; i++) {
        new Uint32Array(memRef.memory.buffer, argv + i * 4, 1)[0] = offset;
        const e = enc.encode(args[i] + "\0");
        m.set(e, offset);
        offset += e.length;
      }
      new Uint32Array(memRef.memory.buffer, argv + args.length * 4, 1)[0] = 0;
      return 0;
    },
    args_sizes_get: (argcBuf, sizeBuf) => {
      new Uint32Array(memRef.memory.buffer, argcBuf, 1)[0] = args.length;
      let total = 0;
      for (const a of args) total += enc.encode(a + "\0").length;
      new Uint32Array(memRef.memory.buffer, sizeBuf, 1)[0] = total;
      return 0;
    },

    clock_time_get: (id, precision, time) => {
      new BigUint64Array(memRef.memory.buffer, time, 1)[0] =
        BigInt(Date.now()) * BigInt(1000000);
      return 0;
    },

    random_get: (buf, len) => {
      const random = new Uint8Array(len);
      crypto.getRandomValues(random);
      mem().set(random, buf);
      return 0;
    },

    proc_exit: (code) => {
      self.postMessage({ type: "exit", code });
      // Don't throw — just halt via infinite wait (worker will be terminated)
      Atomics.wait(new Int32Array(sab), CONTROL_OFFSET, 0, 1000000);
    },
  };
}

function buildCustom() {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  return {
    "micropython_wasm": {
      host_result_cap: () => 256 * 1024,
      host_call: (np, nl, pp, pl, rp, rc) => {
        const m = new Uint8Array(memRef.memory.buffer);
        const name = dec.decode(m.slice(np, np + nl));
        const payload = dec.decode(m.slice(pp, pp + pl));
        const resp = JSON.stringify({ ok: true, value: null });
        const encd = enc.encode(resp);
        if (encd.length > rc) return encd.length;
        m.set(encd, rp);
        return encd.length;
      }
    }
  };
}
