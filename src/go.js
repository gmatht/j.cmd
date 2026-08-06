import { ensurePako } from "./pako.js";

// ─── Go (GOOS=js GOARCH=wasm) toolchain runner for jtsh ────────
//
// The REAL Go compiler and linker (cmd/compile, cmd/link) cross-compiled
// to GOOS=js GOARCH=wasm — go.wasm + link.wasm in wasm-bin/. They run in
// the browser via Go's wasm_exec.js glue (vendored at www/vendor/),
// exactly like any Go program built for js/wasm:
//
//   • globalThis.fs      — Go's os package calls node-fs-style methods
//                          on this object. We back it with the shell's
//                          VirtualFS, so `go run main.go` compiles
//                          against files that live in the shell.
//   • globalThis.process — cwd()/chdir() plus a non-node argv0, so
//                          net/http takes the browser path and maps to
//                          the fetch API (Go disables fetch only when
//                          it detects node).
//   • GOROOT             — the compiled js_wasm stdlib (.a archives)
//                          shipped as ONE gzipped bundle
//                          (wasm-bin/goroot.dat). The shim serves
//                          /goroot/... reads straight out of it.
//
// The `go` command drives the pipeline the way `go build` does, minus
// cmd/go itself (js/wasm has no os/exec, and cmd/go would need to spawn
// compile+link as subprocesses):
//
//   go run main.go   → copy source to /tmp/go-build/, run compile.wasm
//                      (with a generated importcfg) → main.o, run
//                      link.wasm → main.wasm, then run main.wasm.
//   go build main.go → same, but leave main.wasm in the shell instead.
//   go version       → prints the toolchain's Go version.
// -----------------------------------------------------------------

const GOROOT = "/goroot";
const SCRATCH = "/tmp/go-build";
const BUNDLE_URL = "wasm-bin/goroot.dat";

const isNodeEnv = () =>
  typeof process !== "undefined" && process.versions && process.versions.node;

// errno-carrying error — Go's syscall/js maps the .code onto a Go errno.
function fsErr(code, msg) {
  const e = new Error(msg || code);
  e.code = code;
  return e;
}

function makeStats(type, size) {
  const isDir = type === "dir";
  const mtime = Date.now();
  return {
    dev: 1, ino: 1, nlink: 1, uid: 0, gid: 0, rdev: 0,
    size, blksize: 4096, blocks: Math.ceil(size / 4096),
    mode: isDir ? 0o40755 : 0o100644,
    atimeMs: mtime, mtimeMs: mtime, ctimeMs: mtime,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isSymbolicLink: () => false,
  };
}

// Node's flag values (O_RDONLY=0, O_WRONLY=1, O_RDWR=2, O_CREAT=64, ...)
const O = { O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_TRUNC: 512, O_APPEND: 1024, O_EXCL: 128 };

export class GoRunner {
  constructor(vfs, opts = {}) {
    this.vfs = vfs;
    this.baseUrl = opts.baseUrl ?? ""; // "" in browser (www/), "www/" in node CLI
    this._wasmExecPromise = null;
    this._bundlePromise = null;
    this._bundle = null; // { data: Uint8Array, index: Map<relPath, {off,len}> }
    this._fdNext = 3;
    this._fds = new Map();
    this._dirs = new Set();
    this._cwd = "/";
    this._stdout = "";
    this._stderr = "";
    this._stdin = "";
    // One stable fs object per runner — Go captures globalThis.fs once
    // at module init, so we reset capture state between runs instead.
    this.fs = this._makeFsShim();
    this.process = {
      argv0: "jtsh",  // not node → net/http uses fetch in the browser
      cwd: () => this._cwd,
      chdir: (p) => { this._cwd = p; },
      getuid: () => 0,
      getgid: () => 0,
      geteuid: () => 0,
      getegid: () => 0,
      pid: 1,
      ppid: 1,
      umask: () => 0,
    };
  }

  // ─── Loading glue / bundle / binaries ──────────────────────

  _fetch(url) {
    if (isNodeEnv()) {
      return import("node:fs").then(({ readFileSync }) => readFileSync(this.baseUrl + url));
    }
    return fetch(url).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
      return r.arrayBuffer();
    });
  }

  async _loadText(url) {
    const buf = await this._fetch(url);
    if (typeof buf === "string" || buf instanceof Uint8Array) {
      return new TextDecoder().decode(buf);
    }
    return new TextDecoder().decode(new Uint8Array(buf));
  }

  ensureWasmExec() {
    if (!this._wasmExecPromise) {
      this._wasmExecPromise = (async () => {
        if (globalThis.Go) return;
        const src = await this._loadText("vendor/wasm_exec.js");
        if (isNodeEnv()) {
          const vm = await import("node:vm");
          vm.runInThisContext(src, { filename: "wasm_exec.js" });
        } else {
          (0, eval)(src);
        }
        if (!globalThis.Go) throw new Error("wasm_exec.js did not define globalThis.Go");
      })();
    }
    return this._wasmExecPromise;
  }

  // Fetch + inflate the gzipped GOROOT bundle.
  ensureBundle() {
    if (!this._bundlePromise) {
      this._bundlePromise = (async () => {
        const raw = await this._fetch(BUNDLE_URL);
        let bytes = new Uint8Array(raw instanceof Uint8Array ? raw : raw);
        if (isNodeEnv()) {
          const zlib = await import("node:zlib");
          bytes = new Uint8Array(zlib.gunzipSync(bytes));
        } else if (globalThis.pako) {
          bytes = pako.inflate(bytes);
        } else {
          await ensurePako();  // lazy-load vendor/pako.min.js in the browser
          if (!globalThis.pako) throw new Error("Go: no inflate available (pako.min.js not loaded)");
          bytes = globalThis.pako.inflate(bytes);
        }
        // [GOR1][headerLen LE][header JSON][data]
        const magic = new TextDecoder().decode(bytes.slice(0, 4));
        if (magic !== "GOR1") throw new Error("Go: goroot.dat has bad magic");
        const headerLen = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
        const header = JSON.parse(new TextDecoder().decode(bytes.slice(8, 8 + headerLen)));
        const data = bytes.slice(8 + headerLen);
        const index = new Map();
        for (const [rel, off, len] of header) index.set(rel, { off, len });
        this._bundle = { data, index };
        return this._bundle;
      })();
    }
    return this._bundlePromise;
  }

  // Download go.wasm / link.wasm into /tmp/go-tool/ (RamFS, NOT in $PATH —
  // the `go` command is a builtin, and a /usr/bin/go.wasm would shadow it
  // since PATH lookup runs before builtins).
  async ensureToolchain() {
    for (const name of ["go.wasm", "link.wasm"]) {
      const dest = "/tmp/go-tool/" + name;
      const st = await this.vfs.stat(dest).catch(() => null);
      if (st && st.size > 0) continue;
      const buf = await this._fetch("wasm-bin/" + name);
      const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      await this.vfs.writeBlob(dest, new Blob([bytes]));
    }
  }

  async _readBlobBytes(path) {
    const blob = await this.vfs.readBlob(path);
    return new Uint8Array(await blob.arrayBuffer());
  }

  // ─── The fs shim Go's os package calls (node-fs callback API) ─

  _makeFsShim() {
    const runner = this;
    const vfs = this.vfs;

    const bundleBytes = (rel) => {
      const ent = runner._bundle?.index.get(rel);
      if (!ent) return null;
      return runner._bundle.data.slice(ent.off, ent.off + ent.len);
    };

    const isGoroot = (p) => p === GOROOT || p.startsWith(GOROOT + "/");
    const gorootRel = (p) => (p === GOROOT ? "" : p.slice(GOROOT.length + 1));

    async function readVfs(p) {
      const blob = await vfs.readBlob(p);
      return new Uint8Array(await blob.arrayBuffer());
    }

    // Path → { type, size } or null. Checks the goroot bundle, shim-created
    // dirs, then the VirtualFS.
    async function statAny(p) {
      if (isGoroot(p)) {
        const rel = gorootRel(p);
        if (rel === "") return { type: "dir", size: 0 };
        if (runner._bundle?.index.has(rel)) return { type: "file", size: runner._bundle.index.get(rel).len };
        for (const k of runner._bundle.index.keys()) {
          if (k.startsWith(rel + "/")) return { type: "dir", size: 0 };
        }
        return null;
      }
      if (runner._dirs.has(p)) return { type: "dir", size: 0 };
      try {
        return await vfs.stat(p);
      } catch {
        try {
          await vfs.list(p);
          return { type: "dir", size: 0 };
        } catch {
          return null;
        }
      }
    }

    async function openPath(p, flags) {
      if (isGoroot(p)) {
        const writable = (flags & (O.O_WRONLY | O.O_RDWR)) !== 0;
        if (writable) throw fsErr("EROFS", `EROFS: ${p} (goroot is read-only)`);
        const rel = gorootRel(p);
        const bytes = bundleBytes(rel);
        if (bytes === null) throw fsErr("ENOENT", `ENOENT: ${p}`);
        return { path: p, data: bytes.slice(), pos: 0, writable: false, mode: "r" };
      }
      const writable = (flags & (O.O_WRONLY | O.O_RDWR)) !== 0;
      const create = (flags & O.O_CREAT) !== 0;
      const trunc = (flags & O.O_TRUNC) !== 0;
      let bytes = new Uint8Array(0);
      if (!trunc) {
        try {
          bytes = await readVfs(p);
        } catch {
          if (!create) throw fsErr("ENOENT", `ENOENT: ${p}`);
        }
      }
      return { path: p, data: bytes, pos: 0, writable, mode: writable ? "rw" : "r" };
    }

    async function flushFd(fd) {
      const f = runner._fds.get(fd);
      if (!f || !f.writable || !f.path || f.path.startsWith(GOROOT + "/")) return;
      await vfs.writeBlob(f.path, new Blob([f.data]));
    }

    const dec = new TextDecoder();
    const enc = new TextEncoder();

    const fsObj = {
      constants: O,

      // Sync variants — the Go runtime writes stdout/stderr through
      // runtime.wasmWrite → fs.writeSync(fd, buf).
      writeSync(fd, buf) {
        const n = buf.byteLength;
        if (fd === 1) runner._stdout += dec.decode(buf);
        else if (fd === 2) runner._stderr += dec.decode(buf);
        else {
          const f = runner._fds.get(fd);
          if (!f) throw fsErr("EBADF", "EBADF");
          f.data.set(buf, f.pos);
          f.pos += n;
        }
        return n;
      },
      readSync(fd, buf) {
        if (fd === 0) {
          const n = Math.min(buf.length, runner._stdin.length);
          for (let i = 0; i < n; i++) buf[i] = runner._stdin.charCodeAt(i);
          runner._stdin = runner._stdin.slice(n);
          return n;
        }
        const f = runner._fds.get(fd);
        if (!f) throw fsErr("EBADF", "EBADF");
        const n = Math.max(0, Math.min(buf.length, f.data.length - f.pos));
        buf.set(f.data.subarray(f.pos, f.pos + n));
        f.pos += n;
        return n;
      },

      // Callback API (os package) — node-fs signatures.
      open(p, flags, perm, cb) {
        openPath(p, flags).then(
          (f) => {
            const fd = runner._fdNext++;
            runner._fds.set(fd, f);
            cb(null, fd);
          },
          (e) => cb(e),
        );
      },
      close(fd, cb) {
        (async () => {
          await flushFd(fd);
          runner._fds.delete(fd);
          cb(null);
        })().catch((e) => cb(e));
      },
      fsync(fd, cb) {
        flushFd(fd).then(() => cb(null), (e) => cb(e));
      },
      read(fd, buf, offset, length, position, cb) {
        try {
          if (fd === 0) {
            const n = Math.min(length, runner._stdin.length);
            const bytes = enc.encode(runner._stdin.slice(0, n));
            buf.set(bytes, offset);
            runner._stdin = runner._stdin.slice(n);
            return cb(null, n);
          }
          const f = runner._fds.get(fd);
          if (!f) return cb(fsErr("EBADF", "EBADF"));
          const pos = position === null || position === undefined ? f.pos : position;
          const n = Math.max(0, Math.min(length, f.data.length - pos));
          buf.set(f.data.subarray(pos, pos + n), offset);
          if (position === null || position === undefined) f.pos += n;
          cb(null, n);
        } catch (e) { cb(e); }
      },
      write(fd, buf, offset, length, position, cb) {
        try {
          if (fd === 1) { runner._stdout += dec.decode(buf.subarray(offset, offset + length)); return cb(null, length); }
          if (fd === 2) { runner._stderr += dec.decode(buf.subarray(offset, offset + length)); return cb(null, length); }
          const f = runner._fds.get(fd);
          if (!f) return cb(fsErr("EBADF", "EBADF"));
          const pos = position === null || position === undefined ? f.pos : position;
          const end = pos + length;
          if (end > f.data.length) {
            const grown = new Uint8Array(end);
            grown.set(f.data);
            f.data = grown;
          }
          f.data.set(buf.subarray(offset, offset + length), pos);
          if (position === null || position === undefined) f.pos = end;
          cb(null, length);
        } catch (e) { cb(e); }
      },
      stat(p, cb) {
        statAny(p).then((s) => s ? cb(null, makeStats(s.type, s.size)) : cb(fsErr("ENOENT", `ENOENT: ${p}`)), (e) => cb(e));
      },
      lstat(p, cb) { fsObj.stat(p, cb); },
      fstat(fd, cb) {
        const f = runner._fds.get(fd);
        if (!f) return cb(fsErr("EBADF", "EBADF"));
        cb(null, makeStats(f.mode === "r" && f.data.length ? "file" : "file", f.data.length));
      },
      readdir(p, cb) {
        (async () => {
          let names;
          if (isGoroot(p)) {
            const rel = gorootRel(p);
            const prefix = rel === "" ? "" : rel + "/";
            const set = new Set();
            for (const k of runner._bundle.index.keys()) {
              if (k.startsWith(prefix)) {
                const rest = k.slice(prefix.length);
                const name = rest.split("/")[0];
                if (name) set.add(name);
              }
            }
            names = [...set].sort();
          } else {
            const entries = await vfs.list(p);
            names = entries.map((e) => e.replace(/\/+$/, ""));
          }
          cb(null, names);
        })().catch((e) => cb(e));
      },
      mkdir(p, perm, cb) {
        runner._dirs.add(p);
        cb(null);
      },
      rmdir(p, cb) {
        runner._dirs.delete(p);
        vfs.remove(p).then(() => cb(null), (e) => cb(e));
      },
      unlink(p, cb) {
        if (isGoroot(p)) return cb(fsErr("EROFS", "EROFS"));
        vfs.remove(p).then(() => cb(null), (e) => cb(e));
      },
      rename(from, to, cb) {
        if (isGoroot(from) || isGoroot(to)) return cb(fsErr("EROFS", "EROFS"));
        (async () => {
          const bytes = await readVfs(from);
          await vfs.writeBlob(to, new Blob([bytes]));
          await vfs.remove(from);
          cb(null);
        })().catch((e) => cb(e));
      },
      truncate(p, len, cb) {
        (async () => {
          const bytes = await readVfs(p);
          const out = bytes.slice(0, len);
          await vfs.writeBlob(p, new Blob([out]));
          cb(null);
        })().catch((e) => cb(e));
      },
      ftruncate(fd, len, cb) {
        const f = runner._fds.get(fd);
        if (!f) return cb(fsErr("EBADF", "EBADF"));
        const out = new Uint8Array(len);
        out.set(f.data.subarray(0, Math.min(len, f.data.length)));
        f.data = out;
        flushFd(fd).then(() => cb(null), (e) => cb(e));
      },
      utimes(p, atime, mtime, cb) { cb(null); },
      chmod(p, mode, cb) { cb(null); },
      fchmod(fd, mode, cb) { cb(null); },
      chown(p, uid, gid, cb) { cb(null); },
      fchown(fd, uid, gid, cb) { cb(null); },
      lchown(p, uid, gid, cb) { cb(null); },
      readlink(p, cb) { cb(fsErr("EINVAL", "readlink: not a symlink")); },
      link(a, b, cb) { cb(fsErr("EPERM", "link: not supported")); },
      symlink(a, b, cb) { cb(fsErr("EPERM", "symlink: not supported")); },
    };
    return fsObj;
  }

  // ─── Run one js/wasm Go module ─────────────────────────────

  // True if the wasm module is a Go js/wasm binary rather than a
  // wasm32-wasi binary. Go < 1.24 imports the "gojs" module; Go 1.24+
  // imports "go:debug". Either way it needs wasm_exec.js, not WASI.
  async isGoModule(wasmPath) {
    try {
      const wasm = await this._readBlobBytes(wasmPath);
      const module = await WebAssembly.compile(wasm);
      return WebAssembly.Module.imports(module)
        .some((i) => i.module === "gojs" || i.module === "go:debug");
    } catch {
      return false;
    }
  }

  // wasmPath is a VirtualFS path (e.g. /usr/bin/go.wasm). The module is
  // loaded via wasm_exec.js's Go class; args[0] becomes argv[0].
  async runModule(wasmPath, args, stdin = "") {
    // Go's syscall/js captures globalThis.fs/process at module init — wire
    // them up before anything runs. In node the real process stays (the
    // CLI has no fetch-based net/http anyway); in the browser both are ours.
    globalThis.fs = this.fs;
    if (!isNodeEnv()) globalThis.process = this.process;
    await this.ensureWasmExec();
    const wasm = await this._readBlobBytes(wasmPath);
    const module = await WebAssembly.compile(wasm);
    const go = new globalThis.Go();
    go.argv = args;
    go.env = { ...(isNodeEnv() ? process.env : {}), GOROOT };
    go.exit = (code) => { this._exitCode = code; };

    this._exitCode = 0;
    this._stdout = "";
    this._stderr = "";
    this._stdin = stdin || "";
    this._fds = new Map();
    this._dirs = new Set();
    this._cwd = "/";

    const instance = await WebAssembly.instantiate(module, go.importObject);
    await go.run(instance);
    return { code: this._exitCode ?? 0, stdout: this._stdout, stderr: this._stderr };
  }

  // Build the importcfg for compile/link from the bundle index:
  //   packagefile <importpath>=/goroot/pkg/js_wasm/<importpath>.a
  importCfg() {
    const lines = [];
    for (const rel of this._bundle.index.keys()) {
      if (!rel.startsWith("pkg/js_wasm/")) continue;
      const imp = rel.slice("pkg/js_wasm/".length, -".a".length);
      if (!imp) continue;
      lines.push(`packagefile ${imp}=${GOROOT}/pkg/js_wasm/${imp}.a`);
    }
    return lines.join("\n");
  }
}

// ─── The `go` shell command ────────────────────────────────────

export function createGoCommand(runner, out = process.stdout, errOut = process.stderr) {
  // Accept either a stream-like object (process.stdout, {write}) or a
  // plain function (the browser's write(text, cls)) — the browser shell
  // passes write, the CLI passes process.stdout.
  const writeOut = (s) => (typeof out === "function" ? out(s) : out.write(s));
  const writeErr = (s) => (typeof errOut === "function" ? errOut(s) : errOut.write(s));
  return async function go(args) {
    const sub = args[0];
    if (sub === "version") {
      writeOut("go version go1.22.2 js/wasm (real cmd/compile + cmd/link, cross-compiled)\n");
      return 0;
    }
    if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
      writeOut(`go — the REAL Go toolchain, running as WASM in the browser

usage:
  go run <main.go> [args...]   compile + link + run a Go program
  go build <main.go>           compile + link, leave <main>.wasm in cwd
  go version                   show the toolchain version
  go help                      this help

notes:
  • the compiler is cmd/compile, the linker is cmd/link, both compiled
    with GOOS=js GOARCH=wasm and run through Go's wasm_exec.js
  • imports are limited to the bundled stdlib (fmt os strings strconv
    math time sort encoding/json net/http + their deps)
  • net/http maps to the browser fetch API (CORS applies)
`);
      return 0;
    }
    if (sub !== "run" && sub !== "build") {
      writeErr(`go: unknown command '${sub}' (run, build, version, help)\n`);
      return 1;
    }
    const srcArg = args[1];
    if (!srcArg) {
      writeErr(`go ${sub}: missing source file (try 'go help')\n`);
      return 1;
    }
    const progArgs = args.slice(2);

    try {
      await runner.ensureWasmExec();
      await runner.ensureBundle();
      await runner.ensureToolchain();

      // Resolve the source path against the shell cwd.
      const srcPath = srcArg.startsWith("/") ? srcArg : (runner.vfs.cwd + "/" + srcArg);
      const st = await runner.vfs.stat(srcPath).catch(() => null);
      if (!st || st.type !== "file") {
        writeErr(`go ${sub}: cannot find '${srcArg}'\n`);
        return 1;
      }
      const src = await runner._readBlobBytes(srcPath);

      // Stage 0: seed the scratch dir.
      await runner.vfs.writeBlob(SCRATCH + "/main.go", new Blob([src]));
      await runner.vfs.writeBlob(SCRATCH + "/importcfg", new Blob([runner.importCfg()]));

      // Stage 1: compile.
      writeOut(`go ${sub}: compiling ${srcArg} (cmd/compile, js/wasm)…\n`);
      const c = await runner.runModule("/tmp/go-tool/go.wasm", [
        "compile", "-p", "main",
        "-importcfg", SCRATCH + "/importcfg",
        "-o", SCRATCH + "/main.o",
        SCRATCH + "/main.go",
      ]);
      if (c.code !== 0) {
        if (c.stdout) writeOut(c.stdout);
        if (c.stderr) writeErr(c.stderr);
        writeErr(`go: compile failed (exit ${c.code})\n`);
        return c.code;
      }

      // Stage 2: link.
      const linkCfg = runner.importCfg() + `\npackagefile main=${SCRATCH}/main.o\n`;
      await runner.vfs.writeBlob(SCRATCH + "/link.cfg", new Blob([linkCfg]));
      writeOut(`go ${sub}: linking (cmd/link, js/wasm)…\n`);
      const l = await runner.runModule("/tmp/go-tool/link.wasm", [
        "link", "-o", SCRATCH + "/main.wasm",
        "-importcfg", SCRATCH + "/link.cfg",
        SCRATCH + "/main.o",
      ]);
      if (l.code !== 0) {
        if (l.stdout) writeOut(l.stdout);
        if (l.stderr) writeErr(l.stderr);
        writeErr(`go: link failed (exit ${l.code})\n`);
        return l.code;
      }

      const outWasm = await runner._readBlobBytes(SCRATCH + "/main.wasm");

      if (sub === "build") {
        const base = srcArg.split("/").pop().replace(/\.go$/, "");
        const dest = (runner.vfs.cwd + "/" + base + ".wasm").replace(/\/+/g, "/");
        await runner.vfs.writeBlob(dest, new Blob([outWasm]));
        writeOut(`go: built ${base}.wasm (${(outWasm.length / 1024).toFixed(0)}K)\n`);
        return 0;
      }

      // Stage 3: run the freshly built program.
      await runner.vfs.writeBlob(SCRATCH + "/main.wasm", new Blob([outWasm]));
      const r = await runner.runModule(SCRATCH + "/main.wasm", ["main.wasm", ...progArgs]);
      if (r.stdout) writeOut(r.stdout);
      if (r.stderr) writeErr(r.stderr);
      return r.code;
    } catch (e) {
      writeErr(`go: ${e.message}\n`);
      return 1;
    }
  };
}
