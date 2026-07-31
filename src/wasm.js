// ─── WASM/WASI command runtime for tinysh ──────────────────────
//
// Runs any wasm32-wasi binary as a shell command. The old hand-rolled
// WASI syscall stub is gone — @wasmer/wasi (the wasmer-wasi Rust crate
// compiled to wasm) implements the full WASI spec: args, env, clocks,
// random, fd/path operations, preopens and proc_exit.
//
// Filesystem wiring (VirtualFS ⇄ WasmFs ⇄ WASI):
//
//   VirtualFS ──seed──▶ WasmFs ──copy──▶ wasi.fs ──run──▶ wasi.fs
//      ▲                                                     │
//      └────────── flush ◀────── WasmFs ◀──── harvest ────────┘
//
// The WASI program sees an in-memory filesystem (wasi.fs, the Rust
// MemFS) preopened at "/". We bridge it to the shell's VirtualFS using
// @wasmer/wasmfs (WasmFs, a JS memfs):
//   seed     — mirror the local, writable mounts (/home /tmp /commands)
//              from VirtualFS into WasmFs, then copy into wasi.fs
//   harvest  — after the run, read back everything the program wrote
//   flush    — write the harvested tree back into the VirtualFS
//
// So `grep foo file`, `python script.py`, `curl url` — any wasm32-wasi
// binary dropped into /bin/ runs as a native command and its file
// reads/writes hit the shell's own filesystem.
// -----------------------------------------------------------------

import { init, WASI } from "@wasmer/wasi";
import { WasmFs } from "@wasmer/wasmfs";

// @wasmer/wasi embeds its WASI runtime wasm as a base64 data URI and
// decodes it with Buffer.from(). Browsers have no Buffer, so provide a
// minimal shim here (Node's real Buffer is left untouched).
if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = {
    from(str, encoding) {
      if (encoding === "base64") {
        const bin = atob(String(str));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
      }
      return new TextEncoder().encode(String(str));
    },
  };
}

// Mounts never mirrored into the WASI sandbox: network filesystems
// (would need an async crawl) and device files.
const SKIP_MOUNTS = new Set(["http", "github", "gitlab", "dev", "download"]);

// Local, writable directories seeded into the WASI filesystem.
const SEED_DIRS = ["/home", "/tmp", "/commands"];

export class WasmExit extends Error {
  constructor(code) {
    super(`WASM exited with code ${code}`);
    this.code = code;
  }
}

export class WasmRunner {
  constructor(vfs) {
    this.vfs = vfs;
    this.cache = new Map();
    this._initPromise = null;
    this._stdout = "";
    this._stderr = "";
    this._exitCode = 0;
  }

  getStdout() {
    return this._stdout;
  }

  getStderr() {
    return this._stderr;
  }

  getExitCode() {
    return this._exitCode;
  }

  async _ensureInit() {
    if (!this._initPromise) this._initPromise = init();
    await this._initPromise;
  }

  // ─── Run a wasm32-wasi binary ─────────────────────────────

  async run(path, args, stdin = "") {
    await this._ensureInit();

    let module = this.cache.get(path);
    if (!module) {
      const blob = await this.vfs.readBlob(path);
      module = await WebAssembly.compile(await blob.arrayBuffer());
      this.cache.set(path, module);
    }

    // Holder so custom-import closures can reach the instance memory
    // once it exists (the closures only run after instantiation).
    const memRef = { memory: null };

    const wasi = new WASI({
      args,
      env: this._buildEnv(),
      preopens: { ".": "/" },
    });
    // Pipe support: feed the previous command's output as this program's stdin
    if (stdin) wasi.setStdinString(stdin);

    // Wire @wasmer/wasmfs to our VirtualFS: seed a WasmFs mirror from
    // the shell's files, then copy it into the WASI filesystem.
    const wasmfs = new WasmFs();
    await this._seedWasmFs(wasmfs);
    this._copyWasmFsToWasi(wasmfs, wasi.fs);

    // Instantiate (merging custom imports such as micropython_wasm) and
    // run _start. wasmer's WASI handles proc_exit by returning the code.
    const custom = this._buildCustomImports(module, memRef);
    const instance = wasi.instantiate(module, custom);
    if (instance.exports.memory) {
      memRef.memory = instance.exports.memory;
    }

    if (instance.exports._start) {
      this._exitCode = wasi.start(instance);
    } else if (instance.exports.main) {
      instance.exports.main();
      this._exitCode = 0;
    } else {
      this._exitCode = 0;
    }

    this._stdout = wasi.getStdoutString();
    this._stderr = wasi.getStderrString();

    // Harvest changes back through the WasmFs mirror into VirtualFS.
    this._copyWasiToWasmFs(wasi.fs, wasmfs);
    await this._flushWasmFs(wasmfs);

    return instance;
  }

  // ─── VirtualFS → WasmFs (seed) ─────────────────────────────

  async _seedWasmFs(wasmfs) {
    for (const dir of SEED_DIRS) {
      await this._vfsToWasmFs(dir, wasmfs);
    }
  }

  async _vfsToWasmFs(dir, wasmfs) {
    let entries;
    try {
      entries = await this.vfs.list(dir);
    } catch {
      return; // mount or directory missing — nothing to seed
    }
    for (const entry of entries) {
      const isDir = entry.endsWith("/");
      const name = entry.replace(/\/+$/, "");
      const path = (dir === "/" ? "/" : dir + "/") + name;
      if (isDir) {
        wasmfs.fs.mkdirSync(path, { recursive: true });
        await this._vfsToWasmFs(path, wasmfs);
      } else {
        if (name.endsWith(".wasm")) continue; // don't ship binaries into the sandbox
        try {
          const blob = await this.vfs.readBlob(path);
          wasmfs.fs.mkdirSync(this._dirname(path), { recursive: true });
          wasmfs.fs.writeFileSync(path, new Uint8Array(await blob.arrayBuffer()));
        } catch {
          // unreadable file — skip
        }
      }
    }
  }

  // ─── WasmFs → wasi.fs (copy into the filesystem the program sees) ─

  _copyWasmFsToWasi(wasmfs, wasiFs) {
    const walk = (dir) => {
      let entries;
      try {
        entries = wasmfs.fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const path = (dir === "/" ? "/" : dir + "/") + e.name;
        if (e.isDirectory()) {
          this._ensureWasiDir(wasiFs, path);
          walk(path);
        } else if (e.isFile()) {
          let data;
          try {
            data = wasmfs.fs.readFileSync(path);
          } catch {
            continue;
          }
          this._writeWasiFile(wasiFs, path, data);
        }
      }
    };
    walk("/");
  }

  _ensureWasiDir(wasiFs, path) {
    // Create each missing parent; "already exists" errors are expected.
    const parts = path.split("/").filter(Boolean);
    let cur = "";
    for (const p of parts) {
      cur += "/" + p;
      try {
        wasiFs.createDir(cur);
      } catch {
        // already exists — fine
      }
    }
  }

  _writeWasiFile(wasiFs, path, data) {
    this._ensureWasiDir(wasiFs, this._dirname(path));
    const file = wasiFs.open(path, { read: true, write: true, create: true });
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    if (bytes.length > 0) file.write(bytes);
    file.flush();
  }

  // ─── wasi.fs → WasmFs (harvest) ───────────────────────────

  _copyWasiToWasmFs(wasiFs, wasmfs) {
    const walk = (dir) => {
      let entries;
      try {
        entries = wasiFs.readDir(dir);
      } catch {
        return;
      }
      for (const e of entries) {
        const path = e.path;
        const ft = e.metadata && e.metadata.filetype;
        if (ft && ft.dir) {
          wasmfs.fs.mkdirSync(path, { recursive: true });
          walk(path);
        } else if (ft && ft.file) {
          try {
            const file = wasiFs.open(path, { read: true });
            const data = file.read();
            wasmfs.fs.mkdirSync(this._dirname(path), { recursive: true });
            wasmfs.fs.writeFileSync(path, new Uint8Array(data));
          } catch {
            // unreadable — skip
          }
        }
      }
    };
    walk("/");
  }

  // ─── WasmFs → VirtualFS (flush changes back to the shell) ─

  async _flushWasmFs(wasmfs) {
    const walk = async (dir) => {
      let entries;
      try {
        entries = wasmfs.fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const path = (dir === "/" ? "/" : dir + "/") + e.name;
        if (e.isDirectory()) {
          await walk(path);
        } else if (e.isFile()) {
          const mount = this._mountFor(path);
          if (!mount || SKIP_MOUNTS.has(mount.name)) continue;
          try {
            const buf = wasmfs.fs.readFileSync(path);
            await this.vfs.writeBlob(path, new Blob([buf]));
          } catch {
            // read-only backend — skip
          }
        }
      }
    };
    await walk("/");
  }

  _mountFor(resolvedPath) {
    for (const m of this.vfs.mounts) {
      if (resolvedPath.startsWith(m.prefix)) return m;
    }
    return null;
  }

  // ─── Env / custom imports ─────────────────────────────────

  _buildEnv() {
    return {
      HOME: "/home",
      PATH: "/bin:/usr/bin:/commands",
      PWD: this.vfs.cwd || "/home",
    };
  }

  _buildCustomImports(module, memRef) {
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    const custom = {
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

    // Only hand over the modules the binary actually imports — wasmer's
    // import merging fails on modules that aren't declared by the guest.
    const needed = new Set(
      WebAssembly.Module.imports(module)
        .filter((i) => i.module !== "wasi_snapshot_preview1")
        .map((i) => i.module)
    );
    const filtered = {};
    for (const [mod, funcs] of Object.entries(custom)) {
      if (needed.has(mod)) filtered[mod] = funcs;
    }
    return filtered;
  }

  _dirname(path) {
    const p = path.replace(/\/+$/, "") || "/";
    const i = p.lastIndexOf("/");
    return i <= 0 ? "/" : p.slice(0, i);
  }
}
