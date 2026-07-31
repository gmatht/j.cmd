// ─── DevFS: Virtual /dev/ filesystem for browser capabilities ──
//
// Implements the Plan 9 "everything is a file" metaphor for
// browser APIs. Each device is a file that exposes information
// about or control over a browser capability.
//
// Current devices (mostly informational placeholders):
//   /dev/null        — discards writes, returns empty on read
//   /dev/zero        — returns endless null bytes
//   /dev/random      — returns random bytes
//   /dev/info        — browser and system information
//   /dev/input       — keyboard state (placeholder)
//   /dev/webgl       — WebGL info (placeholder)
//   /dev/clipboard   — clipboard access (placeholder)
//   /dev/cpu         — CPU core count
//   /dev/mem         — memory info
//   /dev/ua          — user agent string
//   /dev/time        — current timestamp
// -----------------------------------------------------------------

export class DevFS {
  constructor() {
    this.files = new Map();
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

      case "/webgl":
        return this._webglInfo();

      case "/webgl/extensions":
        return this._webglExtensions();

      case "/clipboard":
        return "Clipboard requires user gesture. Use 'edit' command instead.\n";

      case "/input/keyboard":
        return "Keyboard device not active. No keys currently pressed.\n";

      default:
        throw new Error("ENOENT");
    }
  }

  async write(path, content) {
    const norm = path.replace(/\/$/, "") || "/";

    switch (norm) {
      case "/null":
        return;  // silently discard
      case "/clipboard":
        try {
          await navigator.clipboard.writeText(content);
        } catch {
          throw new Error("Clipboard write denied");
        }
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
    if (norm === "/webgl") {
      return ["extensions", "info"];
    }
    if (norm === "/input") {
      return ["keyboard"];
    }
    throw new Error("ENOTDIR");
  }

  async stat(path) {
    const norm = path.replace(/\/$/, "") || "/";
    if (norm === "/") return { type: "dir", size: 0, mtime: undefined };
    // Known virtual directories under /dev
    if (norm === "/cpu" || norm === "/webgl" || norm === "/input") {
      return { type: "dir", size: 0, mtime: undefined };
    }
    const content = await this.read(norm);
    return { type: "file", size: content.length, mtime: undefined };
  }

  async remove(path) {
    throw new Error("EROFS: Cannot remove devices");
  }

  // ─── Helpers ───────────────────────────────────────────────

  _webglInfo() {
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      if (!gl) return "WebGL not available\n";
      return [
        `vendor: ${gl.getParameter(gl.VENDOR)}`,
        `renderer: ${gl.getParameter(gl.RENDERER)}`,
        `version: ${gl.getParameter(gl.VERSION)}`,
        `shadingLanguageVersion: ${gl.getParameter(gl.SHADING_LANGUAGE_VERSION)}`,
        `maxTextureSize: ${gl.getParameter(gl.MAX_TEXTURE_SIZE)}`,
        `maxVertexAttributes: ${gl.getParameter(gl.MAX_VERTEX_ATTRIBS)}`,
        `maxCombinedTextureImageUnits: ${gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS)}`,
      ].join("\n") + "\n";
    } catch {
      return "WebGL error\n";
    }
  }

  _webglExtensions() {
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      if (!gl) return "WebGL not available\n";
      return gl.getSupportedExtensions().sort().join("\n") + "\n";
    } catch {
      return "WebGL error\n";
    }
  }
}
