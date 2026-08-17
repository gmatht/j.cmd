// ─── BgDevice: /dev/bg — background script execution via a JS thread ─
//
// MAY BE DEPRECATED — the /dev/bg FILE INTERFACE is unused. mimecroft.sh
// previously submitted its texture generation here (`echo "submit …" >
// /dev/bg`) and polled the jobs; it now backgrounds the generators with
// the shell `&` operator, and the RUNTIME's `&` fork heuristic calls
// bgworker.js's bgSubmit DIRECTLY (src/sh2runtime.js) — no device
// involvement. No current game/shell code writes to /dev/bg; the device
// is retained for backward compatibility (older examples may still
// submit) but is a candidate for removal: drop BgDevice and the DevFS
// mount. NOTE: bgworker.js is NOT deprecated — it is the `&` backend.
//
// Plan 9-style device for the worker-backed background compute
// (src/bgworker.js): the shell writes a submit line, polls /dev/bg/
// status, and cats the result when the job is done. The generation
// runs on a SEPARATE THREAD, so the submitting script (the game's menu
// loop) never blocks on it.
//
//   echo "submit <script-path> [args...]" > /dev/bg    → job N
//   cat /dev/bg/status      → "N done|running [code]" lines
//   cat /dev/bg/<N>         → the job's stdout (empty while running)
//   cat /dev/bg/<N>/code    → the exit code ("" while running)
//
// The script file is read through the attached VirtualFS; the job's
// stdout is posted back by the worker thread (pure computation — no
// shared fs/device state crosses the boundary). Falls back to
// synchronously running the script in-process when no worker thread is
// available (e.g. a constrained embedder) — same wire format, just
// blocking.
import { bgSubmit, bgPeek, bgStatus } from "../bgworker.js";
import { runBash } from "../bash2js.js";

export class BgDevice {
  constructor() {
    this._fs = null;      // attached by the parent DevFS (needs /examples reads)
    this._jobs = new Map(); // id → { scriptPath, args, done, out, code, err }
    this._next = 1;
  }

  attachFs(fs) { this._fs = fs; }

  async write(path, content) {
    const p = (path.replace(/\/$/, "") || "/");
    const parts = p.split("/").filter(Boolean);
    const text = String(content).trim();
    if (parts.length > 1 || (parts.length === 1 && parts[0] !== "bg")) {
      throw new Error("EROFS: /dev/bg — write 'submit <script> [args...]'");
    }
    if (!text.startsWith("submit ")) {
      throw new Error("EROFS: /dev/bg — write 'submit <script> [args...]'");
    }
    const rest = text.slice("submit ".length).trim();
    if (!rest) throw new Error("EROFS: /dev/bg — missing script path");
    const sp = rest.split(/\s+/);
    const scriptPath = sp[0];
    const args = sp.slice(1);
    let scriptText;
    try {
      scriptText = await this._fs.read(scriptPath);
    } catch {
      throw new Error(`/dev/bg: cannot read ${scriptPath}`);
    }
    const id = this._next++;
    // worker path: bgSubmit returns immediately (the menu never blocks)
    try {
      const { promise } = bgSubmit(scriptText, args);
      this._jobs.set(id, { id, scriptPath, args, done: false, out: "", code: null, err: null });
      promise.then(() => {
        const j = bgPeek(id);
        const rec = this._jobs.get(id);
        if (rec) { rec.done = j.done; rec.out = j.out; rec.code = j.code; rec.err = j.err; }
      }).catch((e) => {
        const rec = this._jobs.get(id);
        if (rec) { rec.done = true; rec.code = 1; rec.err = e && e.message; }
      });
    } catch {
      // no worker thread available — run synchronously in-process
      let out = "";
      const code = await runBash(this._fs, scriptText, {
        stdout: { write: (s) => { out += s; } },
        stderr: { write: () => {} },
        runCmd: async () => ({ out: "", err: "", code: 0 }),
        args, argv0: scriptPath.split("/").pop(),
      });
      this._jobs.set(id, { id, scriptPath, args, done: true, out, code, err: null });
    }
    return `${id}\n`;
  }

  async read(path) {
    // the devfs slices "/bg" before calling us — paths arrive as
    // "/status", "/1", "/1/code" (or "" for the root)
    const norm = (path.replace(/\/$/, "") || "/");
    if (norm === "/bg" || norm === "/status" || norm === "/list") return this.status();
    if (norm === "/next") return `${this._next}\n`;
    const m = /^\/(\d+)$/.exec(norm);
    if (m) {
      const j = this._jobs.get(Number(m[1]));
      if (!j) return "no such job\n";
      return j.out || "";
    }
    const mc = /^\/(\d+)\/code$/.exec(norm);
    if (mc) {
      const j = this._jobs.get(Number(mc[1]));
      if (!j) return "";
      return j.code === null ? "" : `${j.code}\n`;
    }
    return "";
  }

  status() {
    return [...this._jobs.values()]
      .map((j) => `${j.id} ${j.done ? "done" : "running"}${j.code !== null ? " " + j.code : ""}`)
      .join("\n") + "\n";
  }

  async list() { return ["status"]; }
  stat(path) {
    // post-slice paths ("/status", "/1", "/1/code", "/next")
    const norm = path.replace(/\/$/, "") || "/";
    if (norm === "/" || norm === "/status" || norm === "/list" || norm === "/next") return { type: "file", size: 0, mode: 0o444 };
    const m = /^\/(\d+)$/.exec(norm);
    if (m) return { size: (this._jobs.get(Number(m[1])) || {}).out?.length || 0, mode: 0o444 };
    return null;
  }
}
