// ─── WASM runtime loader for tinysh ─────────────────────────────

export class WasmRunner {
  constructor(vfs) {
    this.vfs = vfs;
    this.cache = new Map();
    this._stdoutBuffer = "";
  }

  getStdout() {
    return this._stdoutBuffer;
  }

  async run(path, args) {
    let module = this.cache.get(path);
    if (!module) {
      const blob = await this.vfs.readBlob(path);
      const array = await blob.arrayBuffer();
      module = await WebAssembly.compile(array);
      this.cache.set(path, module);
    }

    // Memory reference — a holder so closures can update their
    // memory pointer after instantiation (for modules that export
    // their own memory instead of importing it).
    const memRef = { memory: null };

    const imports = WebAssembly.Module.imports(module);
    const needsEnvMem = imports.some(i => i.module === "env" && i.name === "memory");

    if (needsEnvMem) {
      memRef.memory = new WebAssembly.Memory({ initial: 256, maximum: 512 });
    }

    const wasi = this._buildWasi(args, memRef);
    const custom = this._buildCustomImports(memRef);

    const importObj = {
      "wasi_snapshot_preview1": wasi,
      ...custom,
    };
    if (needsEnvMem && memRef.memory) {
      importObj["env"] = { memory: memRef.memory };
    }

    const instance = await WebAssembly.instantiate(module, importObj);

    // If the module exports its own memory, use that
    if (instance.exports.memory) {
      memRef.memory = instance.exports.memory;
    }

    if (instance.exports._start) {
      instance.exports._start();
    } else if (instance.exports.main) {
      instance.exports.main();
    }

    return instance;
  }

  _buildCustomImports(memRef) {
    const runner = this;
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    return {
      "micropython_wasm": {
        host_result_cap: () => 256 * 1024,
        host_call: (np, nl, pp, pl, rp, rc) => {
          const mem = new Uint8Array(memRef.memory.buffer);
          const name = dec.decode(mem.slice(np, np + nl));
          const payload = dec.decode(mem.slice(pp, pp + pl));
          const resp = JSON.stringify({ ok: true, value: null });
          const encd = enc.encode(resp);
          if (encd.length > rc) return encd.length;
          mem.set(encd, rp);
          return encd.length;
        }
      }
    };
  }

  _buildWasi(args, memRef) {
    const runner = this;
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    runner._stdoutBuffer = "";

    function mem() { return new Uint8Array(memRef.memory.buffer); }
    function view() { return new DataView(memRef.memory.buffer); }

    return {
      // ─── Stdio ────────────────────────────────────────
      fd_write: (fd, iovs, iovsLen, nwritten) => {
        if (fd !== 1 && fd !== 2) return 8;
        const m = mem();
        let total = 0;
        for (let i = 0; i < iovsLen; i++) {
          const v = view();
          const p = v.getUint32(iovs + i * 8, true);
          const l = v.getUint32(iovs + i * 8 + 4, true);
          if (l > 0 && l < 100000) {
            runner._stdoutBuffer += dec.decode(m.slice(p, p + l));
            total += l;
          }
        }
        new Uint32Array(memRef.memory.buffer, nwritten, 1)[0] = total;
        return 0;
      },

      fd_read: (fd, iovs, iovsLen, nread) => {
        new Uint32Array(memRef.memory.buffer, nread, 1)[0] = 0;
        return 0;
      },

      // ─── Fd operations ───────────────────────────────
      fd_close: () => 0,
      fd_seek: (fd, offset, whence, newoffset) => {
        if (newoffset !== 0 && newoffset !== undefined) {
          new BigUint64Array(memRef.memory.buffer, newoffset, 1)[0] = BigInt(0);
        }
        return 0;
      },
      fd_prestat_get: () => 8,   // EBADF — no pre-opened dirs
      fd_prestat_dir_name: () => 8,
      fd_fdstat_get: (fd, buf) => {
        const m = mem();
        for (let i = 0; i < 24; i++) m[buf + i] = 0;
        m[buf] = 2;  // character device
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

      // ─── Path operations ─────────────────────────────
      path_open: () => 8,
      path_readlink: () => -1,
      path_filestat_get: () => -1,
      path_create_directory: () => -1,
      path_unlink_file: () => -1,
      path_remove_directory: () => -1,
      path_rename: () => -1,
      filestat_get: () => -1,

      // ─── Environment ────────────────────────────────
      environ_get: () => 0,
      environ_sizes_get: (count, size) => {
        new Uint32Array(memRef.memory.buffer, count, 1)[0] = 0;
        new Uint32Array(memRef.memory.buffer, size, 1)[0] = 0;
        return 0;
      },

      // ─── Args ────────────────────────────────────────
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

      // ─── Clock ───────────────────────────────────────
      clock_time_get: (id, precision, time) => {
        new BigUint64Array(memRef.memory.buffer, time, 1)[0] =
          BigInt(Date.now()) * BigInt(1000000);
        return 0;
      },

      // ─── Random ──────────────────────────────────────
      random_get: (buf, len) => {
        const random = new Uint8Array(len);
        crypto.getRandomValues(random);
        mem().set(random, buf);
        return 0;
      },

      // ─── Process ─────────────────────────────────────
      proc_exit: (code) => { throw new WasmExit(code); },
    };
  }
}

export class WasmExit extends Error {
  constructor(code) {
    super(`WASM exited with code ${code}`);
    this.code = code;
  }
}
