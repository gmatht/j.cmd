// ─── ProcFS: /proc/ — process info + browser stats ────────────
//
// The browser kernel's view of what's running, mirroring the shape of
// Linux's /proc/ so familiar commands keep working in the shell:
//
//   /proc/uptime        seconds since page load, seconds idle
//   /proc/cpuinfo       virtual CPUs (navigator.hardwareConcurrency)
//   /proc/meminfo       memory (deviceMemory + JS heap, if exposed)
//   /proc/version       "kernel" version line (browser/engine)
//   /proc/loadavg       load averages from recent command durations
//   /proc/stat          aggregated CPU/process counters
//   /proc/mounts        the virtual filesystem mount table
//   /proc/devices       devices available under /dev
//   /proc/browser       browser/environment statistics
//   /proc/<pid>/        per-process files:
//       comm            command name
//       cmdline         arguments (space-separated)
//       stat            one-line Linux-style process stat
//       status          readable status block
//       environ         environment variables
//       cwd             current working directory
//       exe             executable (builtin | .js path | .wasm path)
//       fd/             open file descriptors (0=stdin,1=stdout,2=stderr)
//   /proc/self          the shell process itself (pid 1)
//
// jtsh registers every command it runs as a process via
// procfs.start()/finish() (see runSegment in jtsh.js), so `ls /proc`
// shows shell activity as process entries and
// `cat /proc/<pid>/cmdline` shows the command that ran.
//
// All browser-only metrics degrade gracefully in Node (the CLI):
// missing APIs are reported as "?" instead of crashing the shell.
// -----------------------------------------------------------------

import { env } from "../env.js";

const HISTORY_LIMIT = 64;   // keep at most this many exited processes
const SHELL_PID = 1;

// State characters, like Linux task_state_array
const STATE_CHAR = { running: "R", sleeping: "S", exited: "Z" };

class ProcFS {
  constructor() {
    this._bootTime = Date.now();
    this._vfs = null;                 // set via setVfs() by fs/index.js
    this._processes = new Map();      // pid → record
    this._nextPid = SHELL_PID + 1;
    this._history = [];               // sliding window of {end, dur} for loadavg
    this._log = ["procfs ready.\n"];

    // pid 1 — the shell itself (jtsh), waiting for input
    this._processes.set(SHELL_PID, {
      pid: SHELL_PID,
      ppid: 0,
      name: "jtsh",
      kind: "shell",
      path: "/bin/jtsh",
      cmdline: this._shellCmdline(),
      state: "sleeping",
      start: this._bootTime,
      end: 0,
      exitCode: null,
    });
  }

  // ─── VFS wiring (called once by fs/index.js) ────────────────

  setVfs(vfs) {
    this._vfs = vfs;
  }

  _logLine(text) {
    this._log.push(text + "\n");
    if (this._log.length > 200) this._log.shift();
  }

  // ─── Process registry (used by jtsh) ──────────────────────

  start(name, cmdline, opts = {}) {
    const pid = this._nextPid++;
    const record = {
      pid,
      ppid: SHELL_PID,
      name,
      kind: opts.kind || "file",
      path: opts.path || null,
      cmdline: cmdline || [name],
      state: "running",
      start: Date.now(),
      end: 0,
      exitCode: null,
    };
    this._processes.set(pid, record);
    this._logLine(`[proc] ${pid} started: ${(cmdline || [name]).join(" ")}`);
    this._trimHistory();
    return pid;
  }

  finish(pid, exitCode) {
    const p = this._processes.get(pid);
    if (!p) return;
    p.end = Date.now();
    p.state = "exited";
    p.exitCode = exitCode === undefined ? 0 : exitCode;
    const dur = p.end - p.start;
    this._history.push({ end: p.end, dur });
    this._logLine(`[proc] ${pid} exited (${p.exitCode}) after ${dur}ms: ${p.cmdline.join(" ")}`);
    this._trimHistory();
  }

  _trimHistory() {
    // Drop the oldest exited processes beyond the history limit,
    // but never a still-running one and never the shell itself.
    const exited = [...this._processes.keys()]
      .filter((pid) => pid !== SHELL_PID && this._processes.get(pid).state === "exited");
    while (exited.length > HISTORY_LIMIT) {
      this._processes.delete(exited.shift());
    }
  }

  _pids() {
    return [...this._processes.keys()].sort((a, b) => a - b);
  }

  _lastPid() {
    return Math.max(SHELL_PID, this._nextPid - 1);
  }

  _shellCmdline() {
    if (typeof process !== "undefined" && process.argv && process.argv.length > 1) {
      return ["jtsh", ...process.argv.slice(2)];
    }
    return ["jtsh", "-i"];
  }

  _proc(pid) {
    const p = this._processes.get(pid);
    if (!p) throw new Error("ENOENT: no such process");
    return p;
  }

  // ─── Browser/environment helpers (Node-safe) ────────────────

  _nav() {
    return typeof navigator !== "undefined" ? navigator : null;
  }

  _ua() {
    const nav = this._nav();
    if (nav && nav.userAgent) return nav.userAgent;
    if (typeof process !== "undefined" && process.version) {
      return `node/${process.version} (${process.platform || "unknown"})`;
    }
    return "unknown";
  }

  _browserLabel() {
    const ua = this._ua();
    const m = /(Chrome|Chromium|Firefox|Safari|Edg|OPR)\/([\d.]+)/.exec(ua);
    if (m) return `${m[1]} ${m[2]}`;
    // Node.js exposes navigator.userAgent as "Node.js/24" since v21
    const nm = /Node\.js\/([\d.]+)/.exec(ua);
    if (nm) return `node ${nm[1]}`;
    return "unknown browser";
  }

  _cores() {
    const nav = this._nav();
    if (nav && nav.hardwareConcurrency) return nav.hardwareConcurrency;
    return 1; // Node CLI doesn't expose the host core count here
  }

  _deviceMemoryGB() {
    const nav = this._nav();
    return nav && nav.deviceMemory ? nav.deviceMemory : null;
  }

  _heap() {
    // Chromium-only: performance.memory { usedJSHeapSize, totalJSHeapSize,
    // jsHeapSizeLimit }. Absent in Firefox/Safari/Node.
    if (typeof performance !== "undefined" && performance.memory) {
      return performance.memory;
    }
    return null;
  }

  // ─── Generated files ────────────────────────────────────────

  _uptime() {
    const secs = (Date.now() - this._bootTime) / 1000;
    const idle = secs - this._totalCommandSeconds();
    return `${secs.toFixed(2)} ${Math.max(0, idle).toFixed(2)}\n`;
  }

  _totalCommandSeconds() {
    let ms = 0;
    for (const p of this._processes.values()) {
      if (p.pid === SHELL_PID) continue;
      if (p.state === "exited") ms += p.end - p.start;
      else ms += Date.now() - p.start;
    }
    return ms / 1000;
  }

  _cpuinfo() {
    const cores = this._cores();
    const lines = ["# virtual CPUs reported by navigator.hardwareConcurrency"];
    const memGB = this._deviceMemoryGB();
    for (let i = 0; i < cores; i++) {
      lines.push(
        `processor\t: ${i}`,
        `vendor_id\t: BrowserJS`,
        `cpu family\t: 6`,
        `model\t\t: 165`,
        `model name\t: Browser virtual core (JavaScript)`,
        `stepping\t: 2`,
        `cpu MHz\t\t: 2400.000`,
        `cache size\t: 8192 KB`,
        `physical id\t: 0`,
        `siblings\t: ${cores}`,
        `core id\t\t: ${i}`,
        `cpu cores\t: ${cores}`,
        `fpu\t\t: yes`,
        `flags\t\t: js wasm async heapptr`
      );
      if (i < cores - 1) lines.push("");
    }
    if (memGB) lines.push(`bogomips\t: ${(memGB * 2048).toFixed(2)}`);
    return lines.join("\n") + "\n";
  }

  _meminfo() {
    const lines = [];
    lines.push("# browser memory snapshot — deviceMemory + JS heap (Chromium)");
    const devMem = this._deviceMemoryGB();
    if (devMem) {
      lines.push(`MemTotal:\t${Math.round(devMem * 1024 * 1024)} kB`);
    } else {
      lines.push(`MemTotal:\t? kB (navigator.deviceMemory not exposed)`);
    }
    const heap = this._heap();
    if (heap) {
      const avail = heap.jsHeapSizeLimit - heap.usedJSHeapSize;
      lines.push(
        `MemFree:\t${Math.round(avail / 1024)} kB`,
        `MemAvailable:\t${Math.round(avail / 1024)} kB`,
        "",
        `JSHeapUsed:\t${Math.round(heap.usedJSHeapSize / 1024)} kB`,
        `JSHeapTotal:\t${Math.round(heap.totalJSHeapSize / 1024)} kB`,
        `JSHeapLimit:\t${Math.round(heap.jsHeapSizeLimit / 1024)} kB`
      );
    } else {
      lines.push(
        `MemFree:\t? kB (performance.memory is Chromium-only)`,
        "",
        `JSHeapUsed:\t? kB`,
        `JSHeapTotal:\t? kB`,
        `JSHeapLimit:\t? kB`
      );
    }
    return lines.join("\n") + "\n";
  }

  _version() {
    const ua = this._ua();
    const plat = this._nav() && this._nav().platform
      ? this._nav().platform
      : (typeof process !== "undefined" ? process.platform : "unknown");
    const line =
      `jtsh 0.1.2 (browser kernel) #1 SMP PREEMPT_DYNAMIC ` +
      `${this._browserLabel()} on ${plat}`;
    return `${line}\n${ua}\n`;
  }

  _loadavg() {
    const now = Date.now();
    const cores = this._cores();
    const win = (ms) => {
      let sum = 0;
      for (const h of this._history) {
        if (now - h.end <= ms) sum += h.dur;
      }
      return Math.min(cores, sum / ms);
    };
    // Prune history older than 15 minutes
    const cutoff = now - 15 * 60 * 1000;
    while (this._history.length && this._history[0].end < cutoff) {
      this._history.shift();
    }
    const running = [...this._processes.values()].filter(p => p.state === "running").length;
    const total = this._processes.size;
    const l1 = win(60 * 1000);
    const l5 = win(5 * 60 * 1000);
    const l15 = win(15 * 60 * 1000);
    return `${l1.toFixed(2)} ${l5.toFixed(2)} ${l15.toFixed(2)} ${running}/${total} ${this._lastPid()}\n`;
  }

  _stat() {
    const secs = (Date.now() - this._bootTime) / 1000;
    const totalTicks = Math.round(secs * 100);                    // 1 tick = 10ms
    const userTicks = Math.min(totalTicks, Math.round(this._totalCommandSeconds() * 100));
    const idleTicks = totalTicks - userTicks;
    const cores = this._cores();
    const lines = [
      `cpu  ${userTicks} 0 ${idleTicks} 0 0 0 0 0 0 0`,
    ];
    // Per-core lines: idle spread evenly, user on cpu0 (it's all one tab)
    for (let i = 0; i < cores; i++) {
      const u = i === 0 ? userTicks : 0;
      const id = Math.round(idleTicks / cores);
      lines.push(`cpu${i}  ${u} 0 ${id} 0 0 0 0 0 0 0`);
    }
    const procs = this._processes.size;
    lines.push(
      `intr 0`,
      `ctxt ${procs * 2}`,
      `btime ${Math.round(this._bootTime / 1000)}`,
      `processes ${procs}`,
      `procs_running ${[...this._processes.values()].filter(p => p.state === "running").length}`,
      `procs_blocked 0`
    );
    return lines.join("\n") + "\n";
  }

  _mounts() {
    if (!this._vfs) return "# /proc not wired to a VirtualFS yet\n";
    const lines = this._vfs.mounts.map((m) =>
      `${m.name} ${m.prefix} ${m.name} rw 0 0`);
    return lines.join("\n") + "\n";
  }

  async _devices() {
    let devices = ["null", "zero"];
    if (this._vfs) {
      try {
        const dev = await this._vfs.list("/dev");
        if (dev) devices = dev;
      } catch {
        // fall through to the static list
      }
    }
    const lines = ["Character devices:"];
    for (const d of devices) lines.push(`  ${d}`);
    return lines.join("\n") + "\n";
  }

  _browser() {
    const nav = this._nav();
    const lines = [];
    lines.push(`userAgent: ${this._ua()}`);
    lines.push(`browser: ${this._browserLabel()}`);
    lines.push(`platform: ${nav && nav.platform ? nav.platform : (typeof process !== "undefined" ? process.platform : "unknown")}`);
    lines.push(`language: ${nav && nav.language ? nav.language : "unknown"}`);
    lines.push(`online: ${nav ? (nav.onLine ? "yes" : "no") : "n/a"}`);
    lines.push(`cookies: ${nav ? (nav.cookieEnabled ? "enabled" : "disabled") : "n/a"}`);
    lines.push(`hardwareConcurrency: ${nav && nav.hardwareConcurrency ? nav.hardwareConcurrency : "?"}`);
    lines.push(`deviceMemory: ${this._deviceMemoryGB() !== null ? this._deviceMemoryGB() + " GB" : "?"}`);
    lines.push(`maxTouchPoints: ${nav && nav.maxTouchPoints ? nav.maxTouchPoints : 0}`);
    if (typeof window !== "undefined" && window.screen) {
      lines.push(`screen: ${window.screen.width}x${window.screen.height}`);
    }
    // Page-load timing from the Navigation Timing API
    if (typeof performance !== "undefined") {
      const navEntry = performance.getEntriesByType &&
        performance.getEntriesByType("navigation")[0];
      if (navEntry) {
        lines.push(`pageLoad: ${Math.round(navEntry.loadEventEnd)}ms`);
        lines.push(`domContentLoaded: ${Math.round(navEntry.domContentLoadedEventEnd)}ms`);
      } else if (performance.timing && performance.timing.loadEventEnd) {
        lines.push(`pageLoad: ${Math.round(performance.timing.loadEventEnd - performance.timing.navigationStart)}ms`);
      }
    }
    lines.push(`uptime: ${((Date.now() - this._bootTime) / 1000).toFixed(1)}s`);
    return lines.join("\n") + "\n";
  }

  // ─── Per-process file generators ────────────────────────────

  _procComm(p) {
    return `${p.name}\n`;
  }

  _procCmdline(p) {
    return `${p.cmdline.join(" ")}\n`;
  }

  _procEnviron(p) {
    const entries = Object.keys(env).sort().map((k) => `${k}=${env[k]}`);
    if (p.kind === "shell" && typeof process !== "undefined" && process.env) {
      // In the CLI, also expose the host environment
      for (const [k, v] of Object.entries(process.env)) {
        if (k in env) continue;
        entries.push(`${k}=${v}`);
      }
    }
    return entries.join("\n") + "\n";
  }

  _procStat(p) {
    const now = p.state === "exited" ? p.end : Date.now();
    const ticks = (ms) => Math.round(ms / 10);
    const startTicks = Math.round((p.start - this._bootTime) / 10);
    const state = STATE_CHAR[p.state] || "?";
    return [
      p.pid,
      `(${p.name})`,
      state,
      p.ppid,
      p.ppid,            // pgrp
      p.ppid,            // session
      0,                 // tty_nr
      0,                 // tpgid
      0,                 // flags
      0, 0, 0, 0,        // minflt cminflt majflt cmajflt
      ticks(now - p.start), // utime — CPU time in jiffies
      0,                 // stime
      0, 0,              // cutime cstime
      20,                // priority
      0,                 // nice
      1,                 // num_threads
      0,                 // itrealvalue
      startTicks,        // starttime (jiffies since boot)
      0,                 // vsize
      0,                 // rss
    ].join(" ") + "\n";
  }

  _procStatus(p) {
    const durMs = p.state === "exited" ? p.end - p.start : Date.now() - p.start;
    const stateDesc = {
      running: "running",
      sleeping: "sleeping (waiting for input)",
      exited: `exited (code ${p.exitCode === null ? "?" : p.exitCode})`,
    }[p.state] || p.state;
    const lines = [
      `Name:\t${p.name}`,
      `State:\t${STATE_CHAR[p.state] || "?"} (${stateDesc})`,
      `Pid:\t${p.pid}`,
      `PPid:\t${p.ppid}`,
      `Uid:\tjtsh`,
      `Gid:\tjtsh`,
      `Threads:\t1`,
      `VmSize:\t0 kB (virtual)`,
      `VmRSS:\t0 kB (virtual)`,
      `Kind:\t${p.kind}`,
      `Cmdline:\t${p.cmdline.join(" ")}`,
      `StartTime:\t${new Date(p.start).toISOString()}`,
      `Uptime:\t${(durMs / 1000).toFixed(2)}s`,
    ];
    if (p.path) lines.push(`Exe:\t${p.path}`);
    if (p.state === "exited") lines.push(`ExitCode:\t${p.exitCode}`);
    return lines.join("\n") + "\n";
  }

  _procCwd(p) {
    const cwd = this._vfs && this._vfs.cwd ? this._vfs.cwd : "/home";
    return `${cwd}\n`;
  }

  _procExe(p) {
    if (p.path) return `${p.path}\n`;
    return `builtin:${p.name}\n`;
  }

  // ─── VirtualFS interface (paths relative to /proc) ─────────

  async read(path) {
    const norm = path.replace(/\/$/, "") || "/";
    const parts = norm.split("/").filter(Boolean);
    if (parts.length === 0) throw new Error("EISDIR: Is a directory");

    // /proc/self → pid 1 (the shell process)
    if (parts[0] === "self") parts[0] = String(SHELL_PID);

    if (parts.length === 1) {
      const top = parts[0];
      if (top === "uptime") return this._uptime();
      if (top === "cpuinfo") return this._cpuinfo();
      if (top === "meminfo") return this._meminfo();
      if (top === "version") return this._version();
      if (top === "loadavg") return this._loadavg();
      if (top === "stat") return this._stat();
      if (top === "mounts") return this._mounts();
      if (top === "devices") return await this._devices();
      if (top === "browser") return this._browser();
      if (top === "log") return this._log.join("");
      if (/^\d+$/.test(top) || top === "self") {
        // pid directory — reading it is a dir error
        this._proc(parseInt(top, 10)); // ENOENT check
        throw new Error("EISDIR: Is a directory");
      }
      throw new Error("ENOENT");
    }

    // /proc/<pid>/<file>
    const pid = parseInt(parts[0], 10);
    if (!Number.isFinite(pid)) throw new Error("ENOENT");
    const p = this._proc(pid);
    const file = parts.slice(1).join("/");
    switch (file) {
      case "comm": return this._procComm(p);
      case "cmdline": return this._procCmdline(p);
      case "stat": return this._procStat(p);
      case "status": return this._procStatus(p);
      case "environ": return this._procEnviron(p);
      case "cwd": return this._procCwd(p);
      case "exe": return this._procExe(p);
      case "fd":
        throw new Error("EISDIR: Is a directory");
      case "fd/0": return "pipe:[stdin]\n";
      case "fd/1": return "/dev/tty\n";
      case "fd/2": return "/dev/tty\n";
      default:
        throw new Error("ENOENT");
    }
  }

  async list(path) {
    const norm = path.replace(/\/$/, "") || "/";
    const parts = norm.split("/").filter(Boolean);

    if (parts.length === 0) {
      // Top-level /proc
      const entries = [
        "browser", "cpuinfo", "devices", "loadavg", "log",
        "meminfo", "mounts", "self/", "stat", "uptime", "version",
      ];
      for (const pid of this._pids()) entries.push(`${pid}/`);
      return entries.sort((a, b) => {
        const na = a.endsWith("/") ? a.slice(0, -1) : a;
        const nb = b.endsWith("/") ? b.slice(0, -1) : b;
        if (/^\d+$/.test(na) && /^\d+$/.test(nb)) return parseInt(na, 10) - parseInt(nb, 10);
        return na.localeCompare(nb);
      });
    }

    if (parts[0] === "self") parts[0] = String(SHELL_PID);
    if (!/^\d+$/.test(parts[0])) throw new Error("ENOTDIR");
    const pid = parseInt(parts[0], 10);
    this._proc(pid); // ENOENT check

    if (parts.length === 1) {
      return ["cmdline", "comm", "cwd", "environ", "exe", "fd/", "stat", "status"];
    }
    if (parts.length === 2 && parts[1] === "fd") {
      return ["0", "1", "2"];
    }
    throw new Error("ENOTDIR");
  }

  async stat(path) {
    const norm = path.replace(/\/$/, "") || "/";
    if (norm === "/") return { type: "dir", size: 0, mtime: undefined };
    const parts = norm.split("/").filter(Boolean);
    if (parts[0] === "self") parts[0] = String(SHELL_PID);

    // Directories
    if (/^\d+$/.test(parts[0])) {
      this._proc(parseInt(parts[0], 10)); // ENOENT check
      if (parts.length === 1) return { type: "dir", size: 0, mtime: undefined };
      if (parts.length === 2 && parts[1] === "fd") {
        return { type: "dir", size: 0, mtime: undefined };
      }
    }
    // Regular generated files — size from actual content
    try {
      const text = await this.read(norm);
      return { type: "file", size: text.length, mtime: undefined };
    } catch (e) {
      if ((e.message || "").includes("EISDIR")) {
        return { type: "dir", size: 0, mtime: undefined };
      }
      throw e;
    }
  }

  async write(path, content) {
    throw new Error("EROFS: /proc is read-only — processes can't be poked from the shell");
  }

  async remove(path) {
    throw new Error("EROFS: Cannot remove /proc entries");
  }
}

// Singleton shared by fs/index.js (mounts it at /proc) and jtsh.js
// (registers every command it runs as a process).
export const procfs = new ProcFS();
export { ProcFS };
