// ─── DevFS: Virtual /dev/ filesystem for browser capabilities ──
//
// Implements the Plan 9 "everything is a file" metaphor for
// browser APIs. Each device is a file that exposes information
// about or control over a browser capability.
//
// Current devices:
//   /dev/null        — discards writes, returns empty on read
//   /dev/zero        — returns endless null bytes
//   /dev/random      — returns random bytes
//   /dev/info        — browser and system information
//   /dev/input       — keyboard state (placeholder)
//   /dev/webgl       — GPU device: shader/buffer/uniform/call files
//   /dev/camera      — webcam device: frame capture (on/off/size/device)
//   /dev/clipboard   — clipboard read/write (secure context + permission)
//   /dev/cpu         — CPU core count
//   /dev/mem         — memory info
//   /dev/ua          — user agent string
//   /dev/time        — current timestamp
// -----------------------------------------------------------------

import { WebGLDevice } from "./webgldev.js";
import { CameraDevice } from "./cameradev.js";

export class DevFS {
  constructor() {
    this.files = new Map();
    this._webgl = new WebGLDevice();
    this._camera = new CameraDevice();
    this._init();
  }

  _init() {
    // Static/generated-on-read files
    this.files.set("/null", "");
    this.files.set("/zero", "");

    // Browser info files that are computed and cached briefly
    this._cached = {};
  }

  async read(path) {
    const norm = path.replace(/\/$/, "") || "/";

    switch (norm) {
      case "/null":
        return "";

      case "/zero":
        return "\0".repeat(4096);

      case "/random":
        const bytes = new Uint8Array(64);
        crypto.getRandomValues(bytes);
        return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");

      case "/info":
        return [
          `tinysh browser shell`,
          `runtime: sh2runtime 0.1.0`,
          `platform: ${navigator.platform || "unknown"}`,
          `language: ${navigator.language || "unknown"}`,
          `cookies: ${navigator.cookieEnabled ? "enabled" : "disabled"}`,
          `online: ${navigator.onLine ? "yes" : "no"}`,
          `hardwareConcurrency: ${navigator.hardwareConcurrency || "unknown"}`,
          `deviceMemory: ${navigator.deviceMemory || "unknown"} GB`,
          `maxTouchPoints: ${navigator.maxTouchPoints || 0}`,
          `userAgent: ${navigator.userAgent}`,
        ].join("\n") + "\n";

      case "/cpu":
        return `${navigator.hardwareConcurrency || "?"}\n`;

      case "/mem":
        return `${navigator.deviceMemory || "?"} GB\n`;

      case "/ua":
        return `${navigator.userAgent}\n`;

      case "/time":
        return `${Date.now()}\n`;

      case "/clipboard":
        return await this._clipboardRead();

      case "/input/keyboard":
        return "Keyboard device not active. No keys currently pressed.\n";

      default:
        if (norm === "/webgl" || norm.startsWith("/webgl/")) {
          return this._webgl.read(norm.slice(6) || "/");
        }
        if (norm === "/camera" || norm.startsWith("/camera/")) {
          return this._camera.read(norm.slice(8) || "/");
        }
        throw new Error("ENOENT");
    }
  }

  async readBlob(path) {
    const norm = path.replace(/\/$/, "") || "/";
    // /dev/webgl/frame reads back as a PNG blob (binary-aware cp)
    if (norm === "/webgl/frame") {
      const dataUrl = await this._webgl.read("/frame");
      if (typeof fetch === "undefined") throw new Error("fetch unavailable");
      const res = await fetch(dataUrl);
      return await res.blob();
    }
    if (norm === "/camera/frame") {
      // PNG blob so `cp /dev/camera/frame /pc/shot.png` downloads a photo
      const dataUrl = await this._camera.read("/frame");
      if (typeof fetch === "undefined") throw new Error("fetch unavailable");
      const res = await fetch(dataUrl);
      return await res.blob();
    }
    const text = await this.read(norm);
    return new Blob([text], { type: "text/plain" });
  }

  async write(path, content) {
    const norm = path.replace(/\/$/, "") || "/";

    if (norm === "/webgl" || norm.startsWith("/webgl/")) {
      return this._webgl.write(norm.slice(6) || "/", content);
    }
    if (norm === "/camera" || norm.startsWith("/camera/")) {
      return this._camera.write(norm.slice(8) || "/", content);
    }

    switch (norm) {
      case "/null":
        return;  // silently discard
      case "/clipboard":
        await this._clipboardWrite(content);
        return;
      case "/time":
        // Time write is a no-op (you can't set browser time)
        return;
      default:
        throw new Error("EROFS: Read-only device");
    }
  }

  async list(path) {
    const norm = path.replace(/\/$/, "") || "/";

    if (norm === "/") {
      // List all available devices
      return [
        "camera/",
        "clipboard",
        "cpu/",
        "info",
        "input/",
        "mem",
        "null",
        "random",
        "time",
        "ua",
        "webgl/",
        "zero",
      ];
    }
    if (norm === "/webgl" || norm.startsWith("/webgl/")) {
      return this._webgl.list(norm.slice(6) || "/");
    }
    if (norm === "/camera" || norm.startsWith("/camera/")) {
      return this._camera.list(norm.slice(8) || "/");
    }
    if (norm === "/input") {
      return ["keyboard"];
    }
    throw new Error("ENOTDIR");
  }

  async stat(path) {
    const norm = path.replace(/\/$/, "") || "/";
    if (norm === "/") return { type: "dir", size: 0, mtime: undefined };
    if (norm === "/webgl" || norm.startsWith("/webgl/")) {
      return this._webgl.stat(norm.slice(6) || "/");
    }
    if (norm === "/camera" || norm.startsWith("/camera/")) {
      return this._camera.stat(norm.slice(8) || "/");
    }
    // Known virtual directories under /dev
    if (norm === "/cpu" || norm === "/input") {
      return { type: "dir", size: 0, mtime: undefined };
    }
    // Don't trigger a real clipboard read (permission prompt) just to
    // stat the file; report a fixed size instead.
    if (norm === "/clipboard") {
      return { type: "file", size: 0, mtime: undefined };
    }
    const content = await this.read(norm);
    return { type: "file", size: content.length, mtime: undefined };
  }

  async remove(path) {
    const norm = path.replace(/\/$/, "") || "/";
    if (norm === "/webgl" || norm.startsWith("/webgl/")) {
      return this._webgl.remove(norm.slice(6) || "/");
    }
    if (norm === "/camera" || norm.startsWith("/camera/")) {
      return this._camera.remove(norm.slice(8) || "/");
    }
    throw new Error("EROFS: Cannot remove devices");
  }

  // ─── Helpers ───────────────────────────────────────────────

  // ─── Clipboard ────────────────────────────────────────────
  // Plan 9-style /dev/clipboard: read returns the browser clipboard
  // text, write replaces it. The Clipboard API is only available in
  // secure contexts (https or localhost) and reads/writes may require
  // the clipboard-read/clipboard-write permissions (or a user gesture
  // in some browsers). Failures surface as readable errors so the
  // shell can show them via cat/redirect error handling.

  async _clipboardRead() {
    if (typeof navigator === "undefined" || !navigator.clipboard ||
        typeof navigator.clipboard.readText !== "function") {
      throw new Error("Clipboard API not available (needs secure context: https or localhost)");
    }
    try {
      return await navigator.clipboard.readText();
    } catch (err) {
      throw new Error(`Clipboard read denied: ${err.message || err}`);
    }
  }

  async _clipboardWrite(content) {
    if (typeof navigator === "undefined" || !navigator.clipboard ||
        typeof navigator.clipboard.writeText !== "function") {
      throw new Error("Clipboard API not available (needs secure context: https or localhost)");
    }
    try {
      await navigator.clipboard.writeText(content);
    } catch (err) {
      throw new Error(`Clipboard write denied: ${err.message || err}`);
    }
  }

}

