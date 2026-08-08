// ─── realbash: the REAL bash 5.3 (wasm32-emscripten) ───────────
//
// www/wasm-bin/bash.wasm + www/vendor/bash.js — the actual bash
// binary (bahamas10/bash-wasm build), the same one the otranspiler
// GUI runs. The shell's bare `bash` builtin TRANSPILES bash → JS and
// runs it against the sh2.* runtime; `/bin/bash` is this real binary
// (full bash: printf/[[/arrays/…, no transpile). Both shells call
// runRealBash() for the explicit `/bin/bash` path.
//
// LIVE VirtualFS bridge (no mirroring): bash.wasm has its own
// emscripten filesystem, so we MOUNT a custom emscripten FS backend
// at /vfs that routes every file call synchronously to the shell's
// VirtualFS (readSync/writeSync/listSync/statSync — local mounts are
// in memory, so the sync bridge is honest), and symlink /tmp, /home,
// /usr/bin, /bin into it. `cat /tmp/x` and `echo hi > /home/out.txt`
// in bash read and write the shell's REAL files, live. External
// commands (cat/ls/grep…) still can't run — bash.wasm can't fork.
// -----------------------------------------------------------------

import { fs as vfs } from "./fs/index.js";

// The emscripten MODULARIZE factory: browser fetches vendor/bash.js
// relative to the page; node imports the repo copy from disk.
async function bashFactory() {
  if (typeof document !== "undefined") {
    return (await import(new URL("vendor/bash.js", import.meta.url).href)).default;
  }
  return (await import(new URL("../www/vendor/bash.js", import.meta.url).href)).default;
}

function wasmUrl(p) {
  if (typeof document !== "undefined") {
    // the module lives at src/realbash.js; the wasm is vendored at
    // www/wasm-bin/ (page-relative fetches use "wasm-bin/..." directly).
    return new URL("../www/wasm-bin/" + p, import.meta.url).href;
  }
  return new URL("../www/wasm-bin/" + p, import.meta.url).pathname;
}

// ── custom emscripten FS backend → the shell's VirtualFS ────────
// C file calls are synchronous; the local VFS mounts are in-memory, so
// readSync/writeSync/listSync/statSync bridge them 1:1. The backend
// implements the emscripten node_ops/stream_ops contract (mirroring
// MEMFS): nodes carry a vpath + cached bytes; writes go through to the
// VFS immediately.
function mkdirP(FS, path) {
  const parts = path.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts) {
    cur += "/" + p;
    try { FS.mkdir(cur); } catch {}
  }
}

function installVirtualFSMount(FS) {
  const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFREG = 0o100000;
  const ENOENT = 44, EISDIR = 31, ENOTDIR = 44, ENOSYS = 52;
  const E = (c) => new FS.ErrnoError(c);
  const join = (parentV, name) => (parentV === "/" ? "/" : parentV) + "/" + name;
  const makeNode = (parent, name, mode, vpath) => {
    const node = FS.createNode(parent, name, mode);
    node.node_ops = nodeOps;
    node.stream_ops = streamOps;
    node.vpath = vpath;
    return node;
  };

  const nodeOps = {
    getattr(node) {
      // mirror MEMFS's stat shape exactly — bash's [[ -f ]] / stat()
      // reads these fields through the C syscall struct
      const isDir = (node.mode & S_IFMT) === S_IFDIR;
      const size = isDir ? 4096 : (node._data ? node._data.length : 0);
      return {
        dev: 1,
        ino: node.id || 1,
        mode: node.mode,
        nlink: 1,
        uid: 0,
        gid: 0,
        rdev: 0,
        size,
        atime: new Date(node.atime), mtime: new Date(node.mtime), ctime: new Date(node.ctime),
        blksize: 4096,
        blocks: Math.ceil(size / 4096),
      };
    },
    setattr(node, attr) {
      if (attr.mode !== undefined) node.mode = (node.mode & S_IFMT) | (attr.mode & 0o7777);
      if (attr.timestamp !== undefined) node.timestamp = attr.timestamp;
      return 0;
    },
    lookup(parent, name) {
      const vp = join(parent.vpath, name);
      const st = vfs.statSync(vp);
      if (!st) throw E(ENOENT);
      const mode = (st.type === "dir" ? S_IFDIR | 0o755 : S_IFREG | 0o644);
      const node = makeNode(parent, name, mode, vp);
      if (st.type === "file") node._data = vfs.readSync(vp) || new Uint8Array(0);
      return node;
    },
    mknod(parent, name, mode) {
      const node = makeNode(parent, name, mode, join(parent.vpath, name));
      node._data = new Uint8Array(0);
      return node;
    },
    readdir(node) {
      const entries = node.vpath === "/"
        ? (vfs.listSync("/") || ["tmp", "home", "usr", "bin"])
        : vfs.listSync(node.vpath);
      return [".", "..", ...(entries || []).map((n) => String(n).replace(/\/+$/, ""))];
    },
    unlink() { throw E(ENOSYS); },
    rmdir() { throw E(ENOSYS); },
    rename() { throw E(ENOSYS); },
    symlink(parent, newname, oldpath) {
      // nodeOps.symlink contract: (parent, newname, oldpath) — MEMFS style
      const node = makeNode(parent, newname, 0o120777, join(parent.vpath, newname));
      node.link = oldpath;
      return node;
    },
    readlink(node) {
      if (!node.link) throw E(ENOSYS);
      return node.link;
    },
  };
  const streamOps = {
    read(stream, buffer, offset, length, position) {
      const data = stream.node._data || new Uint8Array(0);
      if (position >= data.length) return 0;
      const n = Math.min(data.length - position, length);
      buffer.set(data.subarray(position, position + n), offset);
      return n;
    },
    write(stream, buffer, offset, length, position) {
      const node = stream.node;
      let data = node._data || new Uint8Array(0);
      const end = position + length;
      if (end > data.length) {
        const grown = new Uint8Array(end);
        grown.set(data);
        data = grown;
        node._data = data;
      }
      data.set(buffer.subarray(offset, offset + length), position);
      vfs.writeSync(node.vpath, data);   // live write-through to the VFS
      return length;
    },
    llseek(stream, offset, whence) {
      const size = (stream.node._data || new Uint8Array(0)).length;
      let pos = offset;
      if (whence === 1) pos += stream.position;
      else if (whence === 2) pos += size;
      if (pos < 0) throw E(22);
      return pos;
    },
    mmap() { throw E(ENOSYS); },
    msync() { throw E(ENOSYS); },
  };

  // Mount the live backend directly over the shell paths bash scripts
  // use (the glue pre-creates /tmp and /home as empty MEMFS dirs).
  for (const mp of ["/tmp", "/home", "/usr/bin", "/bin"]) {
    try { mkdirP(FS, mp); } catch {}
    try { FS.mount({ mount(mount) { return makeNode(null, "/", S_IFDIR | 0o755, mount.mountpoint || "/"); } }, {}, mp); } catch {}
  }
}

// Run a bash script through the REAL bash binary. Returns
// { out, err, code } (emscripten's exit/flush/syscall chatter is
// filtered from err). The shell's cwd is the starting directory and
// the VirtualFS is mounted live at /vfs (see installVirtualFSMount).
//
// opts.hostRun(cmdline) — an async host command runner. bash.wasm
// can't fork ("Function not implemented"), but the build has a `web`
// builtin that calls globalThis.__bash_web_internal: we point it at
// hostRun, so `web <cmd>` (and the injected wrapper functions for the
// common external commands — cat, ls, sed, grep, …) send the command
// OUTSIDE bash.wasm to the shell. The host run is async (the EM_JS
// can't block without an asyncify build), so its output streams to the
// shell terminal as it completes and $? may lag — the ordering caveat.
export async function runRealBash(script, opts = {}) {
  const hostRun = opts.hostRun;
  const factory = await bashFactory();
  let out = "", err = "";
  const MARKER = "__OTRANSPILER_EXIT_";
  // The asyncify build runs main via the runtime's own auto-run (a
  // manual callMain breaks the asyncify unwind/rewind — main re-runs).
  let finished = false;
  const cfg = {
    noInitialRun: false,
    arguments: ["/script.sh"],   // auto-run passes these to main (callMain can't — it breaks asyncify)
    locateFile: wasmUrl,
    print: (t) => { out += t + "\n"; },
    printErr: (t) => {
      err += t + "\n";
      // `exit N` in the script exits bash before the marker — detect the
      // runtime's exit notice (keepRuntimeAlive suppresses onExit).
      const em = /program exited \(with status: (\d+)\)/.exec(t);
      if (em) { finished = true; cfg.__exitCode = Number(em[1]); }
    },
    preRun: [() => {
      installVirtualFSMount(cfg.FS);
      // the patched bash calls __bash_spawn(argv, stdin, cwd) for
      // top-level external commands — ASYNCIFY blocks until the host
      // finishes, so output is in the right order and $? is correct.
      globalThis.__bash_spawn = async (args, stdin, bashCwd) => {
        const cmd = (args || []).join(" ");
        if (!hostRun || !cmd) return 127;
        try {
          // bash's PWD is "/" when it started on a mount root (it can't
          // sit there) — fall back to the shell's cwd for host commands.
          const useCwd = bashCwd && bashCwd !== "/" ? bashCwd : cwd;
          const h = await hostRun(cmd, stdin || "", useCwd || "");
          // host output goes through bash's own stdout so the execution
          // order is preserved in the final transcript.
          if (h && h.out) out += h.out;
          if (h && h.err) err += h.err;
          return (h && typeof h.code === "number") ? h.code : 0;
        } catch {
          return 127;
        }
      };
      // `$( )` command substitution: the string runs in the host shell
      // and its stdout is captured (fed back into bash's pipe).
      globalThis.__bash_spawn_capture = async (cmd, bashCwd) => {
        if (!hostRun || !cmd) return { out: "", code: 127 };
        try {
          const useCwd = bashCwd && bashCwd !== "/" ? bashCwd : cwd;
          const h = await hostRun(cmd, "", useCwd || "");
          return {
            out: h && h.out ? h.out : "",
            code: (h && typeof h.code === "number") ? h.code : 0,
          };
        } catch {
          return { out: "", code: 127 };
        }
      };
      // the `web` builtin → the host (fire-and-forget; output streams in
      // after the script, $? reads 0).
      globalThis.__bash_web_internal = (args) => {
        const cmd = (args || []).join(" ");
        if (hostRun && cmd) { setImmediate(() => { try { hostRun(cmd); } catch {} }); }
        return 0;
      };
      // bash can't start with its cwd ON a custom-FS mountpoint — subdirs
      // inside the mount are fine. Start at / when the cwd is a mount root.
      const cwd = (vfs.cwd !== undefined ? vfs.cwd : "/") || "/";
      const MOUNT_ROOTS = ["/tmp", "/home", "/usr/bin", "/bin"];
      if (MOUNT_ROOTS.includes(cwd)) {
        try { cfg.FS.chdir("/"); } catch {}
      } else {
        try { cfg.FS.chdir(cwd); } catch { try { cfg.FS.chdir("/"); } catch {} }
      }
      // the script + a completion marker carrying the last exit status
      // (the only reliable "main has finished" signal in the asyncify
      // runtime — onExit never fires while keepRuntimeAlive is set).
      cfg.FS.writeFile("/script.sh", String(script) + "\necho " + MARKER + "$?_\n");
    }],
  };
  const m = await factory(cfg);
  // wait for the completion marker (all asyncify rewinds done by then)
  // or an explicit exit (the runtime's "program exited" notice).
  const deadline = Date.now() + 120000;
  while (!out.includes(MARKER) && !finished) {
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  let code = 0;
  if (cfg.__exitCode !== undefined) code = Number(cfg.__exitCode);
  const mm = out.match(new RegExp(MARKER + "(\\d+)_"));
  if (mm) code = Number(mm[1]);
  out = out.replace(new RegExp(MARKER + "\\d+_", "g"), "").trim() + "\n";

  // emscripten's runtime notices are noise — drop them.
  err = err.split("\n").filter((l) =>
    !/^warning: unsupported syscall/.test(l) &&
    !/^program exited \(with status/.test(l) &&
    !/^warning: stdio streams had content/.test(l)
  ).join("\n");
  return { out, err, code };
}
