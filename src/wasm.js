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

    const memory = new WebAssembly.Memory({ initial: 256, maximum: 512 });
    const wasiImports = this._buildWasi(args, memory);
    const customImports = this._buildCustomImports(memory);

    const instance = await WebAssembly.instantiate(module, {
      "wasi_snapshot_preview1": wasiImports,
      ...customImports,
      "env": { memory }
    });

    if (instance.exports._start) {
      instance.exports._start();
    } else if (instance.exports.main) {
      instance.exports.main();
    }

    return instance;
  }

  _buildCustomImports(memory) {
    // Support micropython_wasm custom imports
    // host_call(name, payload) → JSON response
    const runner = this;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    return {
      "micropython_wasm": {
        host_result_cap: () => 256 * 1024,
        host_call: (namePtr, nameLen, payloadPtr, payloadLen, resultPtr, resultCap) => {
          const mem = new Uint8Array(memory.buffer);
          const name = decoder.decode(mem.slice(namePtr, namePtr + nameLen));
          const payload = decoder.decode(mem.slice(payloadPtr, payloadPtr + payloadLen));

          // Default: return empty success for unknown calls
          // In future, this can be extended with host function registration
          const response = JSON.stringify({ ok: true, value: null });
          const encoded = encoder.encode(response);

          if (encoded.length > resultCap) {
            return encoded.length;
          }
          mem.set(encoded, resultPtr);
          return encoded.length;
        }
      }
    };
  }

  _buildWasi(args, memory) {
    const runner = this;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    runner._stdoutBuffer = "";

    return {
      fd_write: (fd, iovs, iovsLen, nwritten) => {
        if (fd === 1 || fd === 2) {
          const mem = new Uint8Array(memory.buffer);
          let total = 0;
          for (let i = 0; i < iovsLen; i++) {
            const view = new DataView(memory.buffer);
            const bufPtr = view.getUint32(iovs + i * 8, true);
            const bufLen = view.getUint32(iovs + i * 8 + 4, true);
            const chunk = decoder.decode(mem.slice(bufPtr, bufPtr + bufLen));
            runner._stdoutBuffer += chunk;
            total += bufLen;
          }
          new Uint32Array(memory.buffer, nwritten, 1)[0] = total;
          return 0;
        }
        return 8;
      },

      fd_read: (fd, iovs, iovsLen, nread) => {
        new Uint32Array(memory.buffer, nread, 1)[0] = 0;
        return 0;
      },

      fd_close: (fd) => 0,
      fd_seek: (fd, offset, whence, newoffset) => 0,
      fd_prestat_get: (fd, buf) => 8,
      fd_prestat_dir_name: (fd, path, pathLen) => 8,

      environ_get: (environ, environBuf) => 0,
      environ_sizes_get: (count, size) => {
        new Uint32Array(memory.buffer, count, 1)[0] = 0;
        new Uint32Array(memory.buffer, size, 1)[0] = 0;
        return 0;
      },

      args_get: (argv, argvBuf) => {
        const mem = new Uint8Array(memory.buffer);
        let offset = argvBuf;
        for (let i = 0; i < args.length; i++) {
          new Uint32Array(memory.buffer, argv + i * 4, 1)[0] = offset;
          const encoded = encoder.encode(args[i] + "\0");
          mem.set(encoded, offset);
          offset += encoded.length;
        }
        new Uint32Array(memory.buffer, argv + args.length * 4, 1)[0] = 0;
        return 0;
      },

      args_sizes_get: (argcBuf, sizeBuf) => {
        new Uint32Array(memory.buffer, argcBuf, 1)[0] = args.length;
        let total = 0;
        for (const a of args) total += encoder.encode(a + "\0").length;
        new Uint32Array(memory.buffer, sizeBuf, 1)[0] = total;
        return 0;
      },

      clock_time_get: (id, precision, time) => {
        new BigUint64Array(memory.buffer, time, 1)[0] = BigInt(Date.now()) * BigInt(1000000);
        return 0;
      },

      random_get: (buf, len) => {
        const random = new Uint8Array(len);
        crypto.getRandomValues(random);
        new Uint8Array(memory.buffer).set(random, buf);
        return 0;
      },

      proc_exit: (code) => { throw new WasmExit(code); },

      fd_fdstat_get: (fd, buf) => {
        new Uint8Array(memory.buffer)[buf] = 2;
        return 0;
      },
      fd_fdstat_set_flags: (fd, flags) => 0,
      fd_readdir: (fd, buf, bufLen, cookie, nread) => { new Uint32Array(memory.buffer, nread, 1)[0] = 0; return 0; },
      fd_sync: (fd) => 0,
      sched_yield: () => 0,
      path_open: () => 8,
      path_readlink: () => -1,
      path_filestat_get: () => -1,
      path_create_directory: () => -1,
      path_unlink_file: () => -1,
      path_remove_directory: () => -1,
      path_rename: () => -1,
      filestat_get: () => -1,
      poll_oneoff: () => 0,
    };
  }
}

export class WasmExit extends Error {
  constructor(code) {
    super(`WASM exited with code ${code}`);
    this.code = code;
  }
}
