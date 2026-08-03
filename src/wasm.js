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
//   seed     — mirror the local, writable mounts (/home /tmp /bin)
//              from VirtualFS into WasmFs, then copy into wasi.fs
//   harvest  — after the run, read back everything the program wrote
//   flush    — write the harvested tree back into the VirtualFS
//
// So `grep foo file`, `python script.py`, `curl url` — any wasm32-wasi
// binary dropped into /bin/ runs as a native command and its file
// reads/writes hit the shell's own filesystem.
// -----------------------------------------------------------------

import { init, WASI, MemFS } from "@wasmer/wasi";
import { WasmFs } from "@wasmer/wasmfs";
import { env } from "./env.js";
import { createCRuntime } from "./c-runtime.js";

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

// Local, writable directories seeded into the WASI filesystem. /usr/bin
// (WASM binaries) is deliberately excluded — binaries aren't shipped into
// the sandbox, and an empty preopen would fail to stat.
const SEED_DIRS = ["/home", "/tmp", "/bin"];

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
    this._stdoutBytes = new Uint8Array(0);
    this._stderr = "";
    this._stdCustomOut = "";
    this._stdin = "";
    this._exitCode = 0;
  }

  getStdout() {
    return this._stdout;
  }

  // Raw stdout bytes (binary-safe). The text form (getStdout) is
  // derived from this same capture, so both are consistent. Pipes use
  // bytes so binary programs (gzip, ...) round-trip intact.
  getStdoutBytes() {
    return this._stdoutBytes;
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
    const custom = this._buildCustomImports(module, memRef);

    // The c-compiler's output (and other bare modules) import only custom
    // modules like 'std', with no WASI imports — @wasmer/wasi can't
    // determine a WASI version for them. Instantiate directly instead.
    const hasWasi = WebAssembly.Module.imports(module)
      .some((i) => i.module === "wasi_snapshot_preview1");
    if (!hasWasi) {
      const instance = await WebAssembly.instantiate(module, custom);
      if (instance.exports.memory) memRef.memory = instance.exports.memory;
      try {
        // qbe2wasm compiles export the QBE symbol verbatim ($main); the
        // old c-to-wasm compiler exports main.
        const entry = instance.exports.$main || instance.exports.main;
        if (entry) { entry(); this._exitCode = 0; }
        else { this._exitCode = 0; }
      } catch (e) {
        if (e && e.name === "CExit") this._exitCode = e.code;
        else throw e;
      }
      this._stdout = this._stdCustomOut || "";
      this._stdoutBytes = new TextEncoder().encode(this._stdout);
      this._stderr = "";
      this._stdCustomOut = "";
      return instance;
    }

    // Wire @wasmer/wasmfs to our VirtualFS: seed a WasmFs mirror from
    // the shell's files, then copy it into the WASI filesystem.
    const wasmfs = new WasmFs();
    await this._seedWasmFs(wasmfs);
    // Snapshot the mirror's file list so _flushWasmFs can detect files
    // the program deleted (zstd -d removes the source, gzip-style tools
    // remove inputs) and propagate those removals back to VirtualFS.
    const beforeFiles = this._wasmFsFiles(wasmfs);

    // Build the WASI filesystem (a MemFS) and populate it BEFORE the
    // WASI instance exists — the WASI constructor preopens dirs and
    // needs them to already exist (map_dirs stats each preopen path).
    const wasiFs = new MemFS();
    this._copyWasmFsToWasi(wasmfs, wasiFs);

    // The WASI program's cwd is the shell's cwd, so relative file
    // args — `grep pat file`, `./a.wasm ./audiodemo.js`, `make` reading
    // ./Makefile — resolve the way a real shell's programs would.
    //
    // Preopen rules (wasmer-wasi): each preopen maps a guest path to a
    // dir in the sandbox, the "." preopen (last entry wins) becomes the
    // guest cwd, and a "/" preopen shadows the sandbox root. So we
    // preopen the seeded dirs by name and put "." → cwd last. When the
    // shell is somewhere unseeded (e.g. /mount/github), fall back to
    // "." → "/" (the original behaviour).
    const seededDirs = ["/home", "/tmp", "/bin"];
    const sandboxCwd = this.vfs.cwd || "/home";
    const preopenCwd = seededDirs.includes(sandboxCwd) ? sandboxCwd : "/";
    const preopens = {};
    for (const dir of seededDirs) preopens[dir] = dir;
    preopens["."] = preopenCwd; // last entry → the guest's cwd

    const wasi = new WASI({
      args,
      env: this._buildEnv(),
      fs: wasiFs,
      preopens,
    });
    // Pipe support: feed the previous command's output as this program's stdin
    // (bytes stay bytes — a binary stream can't survive a string round-trip).
    if (stdin instanceof Uint8Array) wasi.setStdinBuffer(stdin);
    else if (stdin) wasi.setStdinString(stdin);
    this._stdin = stdin || "";

    // Instantiate (merging custom imports such as micropython_wasm) and
    // run _start. wasmer's WASI handles proc_exit by returning the code.
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

    this._stdoutBytes = wasi.getStdoutBuffer();
    this._stdout = new TextDecoder().decode(this._stdoutBytes);
    this._stderr = wasi.getStderrString();
    // Merge output written via the custom 'std' module (c-compiler runtime)
    if (this._stdCustomOut) {
      const custom = new TextEncoder().encode(this._stdCustomOut);
      const merged = new Uint8Array(custom.length + this._stdoutBytes.length);
      merged.set(custom, 0);
      merged.set(this._stdoutBytes, custom.length);
      this._stdoutBytes = merged;
      this._stdout = this._stdCustomOut + this._stdout;
      this._stdCustomOut = "";
    }

    // Harvest changes back through the WasmFs mirror into VirtualFS.
    this._copyWasiToWasmFs(wasi.fs, wasmfs);
    await this._flushWasmFs(wasmfs);
    // Files that existed before the run but are gone from the mirror
    // were removed by the program — reflect those deletions in the VFS.
    this._flushRemoved(beforeFiles, wasmfs);

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

  _skipHarvestPrefixes() {
    // Read-only input dirs the program never modifies (zig's std lib etc.):
    // they are seeded into the sandbox but skipped when harvesting back, so
    // a big lib doesn't cost an O(n) wasm-boundary re-read on every run.
    const raw = env.WASM_SKIP_HARVEST || "";
    return raw.split(":").filter(Boolean).map((p) => (p.endsWith("/") ? p.slice(0, -1) : p));
  }

  _copyWasiToWasmFs(wasiFs, wasmfs) {
    // The mirror may hold files the program deleted from its fs — clear
    // it first so wasmfs exactly reflects what the program left behind
    // (deletions then propagate to VirtualFS in _flushRemoved).
    const skip = this._skipHarvestPrefixes();
    const isSkipped = (path) => skip.some((p) => path === p || path.startsWith(p + "/"));
    const removeAll = (dir) => {
      if (isSkipped(dir)) return;
      let entries;
      try {
        entries = wasmfs.fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const path = (dir === "/" ? "/" : dir + "/") + e.name;
        if (e.isDirectory()) {
          removeAll(path);
          try { wasmfs.fs.rmdirSync(path); } catch {}
        } else {
          try { wasmfs.fs.unlinkSync(path); } catch {}
        }
      }
    };
    removeAll("/");

    const walk = (dir) => {
      let entries;
      try {
        entries = wasiFs.readDir(dir);
      } catch {
        return;
      }
      for (const e of entries) {
        const path = e.path;
        if (isSkipped(path)) continue;
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

  // All regular-file paths currently in the mirror (for delete detection).
  _wasmFsFiles(wasmfs) {
    const out = new Set();
    const walk = (dir) => {
      let entries;
      try {
        entries = wasmfs.fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const path = (dir === "/" ? "/" : dir + "/") + e.name;
        if (e.isDirectory()) walk(path);
        else if (e.isFile()) out.add(path);
      }
    };
    walk("/");
    return out;
  }

  // Remove from VirtualFS any file the program deleted (present in the
  // before-snapshot, missing from the mirror afterwards).
  async _flushRemoved(beforeFiles, wasmfs) {
    const afterFiles = this._wasmFsFiles(wasmfs);
    for (const path of beforeFiles) {
      if (afterFiles.has(path)) continue;
      const mount = this._mountFor(path);
      if (!mount || SKIP_MOUNTS.has(mount.name)) continue;
      try {
        await this.vfs.remove(path);
      } catch {
        // never existed / read-only backend — skip
      }
    }
  }

  async _flushWasmFs(wasmfs) {
    const skip = this._skipHarvestPrefixes();
    const isSkipped = (path) => skip.some((p) => path === p || path.startsWith(p + "/"));
    const walk = async (dir) => {
      let entries;
      try {
        entries = wasmfs.fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const path = (dir === "/" ? "/" : dir + "/") + e.name;
        if (isSkipped(path)) continue;
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
    // WASI programs see the shell's environment. PWD always reflects
    // the current directory (even if $PWD was overridden later).
    // Values are stringified: generated JS (bash2js) may write
    // numbers into env, and WASI requires string values.
    const merged = { ...env, PWD: this.vfs.cwd || env.HOME };
    const out = {};
    for (const k of Object.keys(merged)) out[k] = String(merged[k]);
    return out;
  }

  _buildCustomImports(module, memRef) {
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const runner = this;

    const custom = {
      // Runtime for cproc → qbe2wasm-compiled C programs: extern calls
      // become env.* imports. printf/puts output to the terminal, the
      // heap is a bump allocator above the stack zone.
      "env": createCRuntime({
        getMem: () => new Uint8Array(memRef.memory.buffer),
        memory: () => memRef.memory,
        out: (t) => { runner._stdCustomOut += t; },
        err: (t) => { runner._stderr += t; },
      }),
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
      },

      // Runtime for the c-to-wasm-compiler-project: the WASM it generates
      // imports a custom 'std' module (sleep, readln, print, ...). This
      // bridge implements those against the browser shell.
      "std": {
        sleep: (ms) => {
          // Busy-wait in small steps so the UI thread stays responsive-ish
          const end = Date.now() + ms;
          while (Date.now() < end) {}
          return 0;
        },
        readln: (po, bufLen) => {
          const mem = new Uint8Array(memRef.memory.buffer);
          // stdin was set on the runner during run() — may be raw bytes
          const raw = runner._stdin || "";
          const line = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
          runner._stdin = "";
          const bytes = enc.encode(line);
          const max = Math.min(bytes.length, Math.max(0, bufLen - 1));
          for (let i = 0; i < max; i++) mem[po + i] = bytes[i];
          mem[po + max] = 0;
          return bytes.length;
        },
        _ln: () => { runner._stdCustomOut += "\n"; return 0; },
        _print: (po, len) => {
          const mem = new Uint8Array(memRef.memory.buffer);
          runner._stdCustomOut += dec.decode(mem.slice(po, po + len));
          return 0;
        },
        _println: (po, len) => {
          runner._print(po, len);
          runner._stdCustomOut += "\n";
          return 0;
        },
        print_int: (i) => { runner._stdCustomOut += String(i); return 0; },
        print_real: (r) => { runner._stdCustomOut += String(r); return 0; },
        println_int: (i) => { runner._stdCustomOut += String(i) + "\n"; return 0; },
        println_real: (r) => { runner._stdCustomOut += String(r) + "\n"; return 0; },
        print_int_pad: (i, fullLen) => {
          let left = false;
          if (fullLen < 0) { fullLen = -fullLen; left = true; }
          const txt = String(i);
          runner._stdCustomOut += left ? txt.padStart(fullLen) : txt.padEnd(fullLen);
          return 0;
        },
        print_real_pad: (r, fullLen) => {
          let left = false;
          if (fullLen < 0) { fullLen = -fullLen; left = true; }
          const txt = String(r);
          runner._stdCustomOut += left ? txt.padStart(fullLen) : txt.padEnd(fullLen);
          return 0;
        },
      },
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
