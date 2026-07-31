// ─── CameraDevice: /dev/camera — webcam via filesystem reads ───
//
// Plan 9-style camera: the webcam is a set of files under /dev/camera/.
// Reading /dev/camera/frame captures the current frame as a PNG data
// URL (readBlob returns a real PNG blob, so `cp /dev/camera/frame
// /pc/shot.png` downloads a photo). The camera starts lazily on the
// first frame read — the browser asks for camera permission once — and
// keeps running until /dev/camera/off is written.
//
//   /dev/camera/info     read   enumerate cameras + current state
//   /dev/camera/status   read   one-line state summary
//   /dev/camera/frame    read   PNG data URL of current frame
//                               (readBlob: image/png Blob)
//   /dev/camera/log      read   activity log
//   /dev/camera/on       write  start the camera (request permission)
//   /dev/camera/off      write  stop the camera, release the webcam
//   /dev/camera/size     write  "WxH" capture resolution (default 640x480)
//   /dev/camera/device   write  select camera: index from /dev/camera/info,
//                               a deviceId, or "default"
//
// Notes:
//   - getUserMedia requires a secure context (https or localhost) and a
//     user gesture, which a typed shell command provides.
//   - Frames are drawn from a hidden <video> element onto a hidden
//     <canvas> — no preview UI, "everything is a file".
//   - In Node (the CLI) there is no DOM or webcam; reads fail with a
//     descriptive error instead of crashing the shell.
// -----------------------------------------------------------------

class CameraDevice {
  constructor() {
    this._stream = null;      // active MediaStream (null when off)
    this._video = null;       // hidden <video> element
    this._canvas = null;      // hidden <canvas> for frame grabs
    this._width = 640;        // requested capture width
    this._height = 480;       // requested capture height
    this._deviceId = "default"; // selected camera ("" = default)
    this._error = null;       // last start/capture error, if any
    this._lastFrameAt = 0;    // epoch ms of the most recent frame
    this._log = ["camera device ready.\n"];
  }

  _logLine(text) {
    this._log.push(text + "\n");
    if (this._log.length > 200) this._log.shift();
  }

  // ─── Environment checks ─────────────────────────────────────

  _ensureBrowser() {
    if (typeof document === "undefined") {
      throw new Error("camera not available (no DOM — needs a browser)");
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getUserMedia !== "function") {
      throw new Error(
        "Camera API not available (needs secure context: https or localhost, plus camera permission)");
    }
  }

  // ─── Stream lifecycle ───────────────────────────────────────

  _ensureElements() {
    if (this._video) return;
    this._video = document.createElement("video");
    this._video.style.display = "none";
    this._video.setAttribute("playsinline", "");
    this._video.setAttribute("muted", "");
    this._video.muted = true;
    document.body.appendChild(this._video);

    this._canvas = document.createElement("canvas");
    this._canvas.width = this._width;
    this._canvas.height = this._height;
  }

  async _ensureStream() {
    this._ensureBrowser();
    if (this._stream && this._stream.active) return this._stream;
    this._ensureElements();
    const video = this._video;
    const constraints = {
      video: {
        width: { ideal: this._width },
        height: { ideal: this._height },
      },
    };
    if (this._deviceId && this._deviceId !== "default") {
      constraints.video.deviceId = { exact: this._deviceId };
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;
      await video.play();
      this._stream = stream;
      this._error = null;
      this._logLine(`[camera] started ${this._width}x${this._height}` +
        (this._deviceId !== "default" ? ` (device ${this._deviceId})` : ""));
      return stream;
    } catch (e) {
      this._error = e && e.message ? e.message : String(e);
      this._logLine(`[camera] start failed: ${this._error}`);
      throw new Error(
        `camera start failed: ${this._error} (grant camera permission and use https/localhost)`);
    }
  }

  _stop() {
    if (this._stream) {
      for (const track of this._stream.getTracks()) track.stop();
      this._stream = null;
    }
    if (this._video) {
      this._video.srcObject = null;
      if (this._video.parentNode) this._video.parentNode.removeChild(this._video);
      this._video = null;
      this._canvas = null;
    }
    this._logLine("[camera] stopped");
  }

  get _running() {
    return !!(this._stream && this._stream.active);
  }

  // ─── Frame capture ──────────────────────────────────────────

  // Resolve once the hidden video has a frame (readyState >= 2), with a
  // timeout so a dead/blocked camera fails with a clear error.
  _waitForVideoFrame(timeoutMs = 5000) {
    const video = this._video;
    if (video.readyState >= 2) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (fn) => () => { cleanup(); fn(); };
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener("loadeddata", onData);
        video.removeEventListener("playing", onData);
      };
      const onData = done(resolve);
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("timed out waiting for a camera frame"));
      }, timeoutMs);
      video.addEventListener("loadeddata", onData);
      video.addEventListener("playing", onData);
    });
  }

  async _captureFrame() {
    const stream = await this._ensureStream();
    await this._waitForVideoFrame();
    const video = this._video;
    const canvas = this._canvas;
    const w = video.videoWidth || this._width;
    const h = video.videoHeight || this._height;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, w, h);
    this._lastFrameAt = Date.now();
    this._logLine(`[camera] frame ${w}x${h} captured`);
    return canvas.toDataURL("image/png");
  }

  // ─── Device enumeration ─────────────────────────────────────

  async _devices() {
    this._ensureBrowser();
    const list = await navigator.mediaDevices.enumerateDevices();
    const cams = list.filter((d) => d.kind === "videoinput");
    if (cams.length === 0) {
      return "No cameras found. Plug one in and reload the page.\n";
    }
    return cams.map((d, i) =>
      `${i}: ${d.label || "(label hidden until camera permission is granted)"}` +
      (d.deviceId ? ` [${d.deviceId}]` : ""))
      .join("\n") + "\n";
  }

  // ─── Read-only generated files ──────────────────────────────

  _status() {
    const lines = [];
    lines.push(`state: ${this._running ? "capturing" : "idle"}`);
    lines.push(`resolution: ${this._width}x${this._height}` +
      (this._canvas && this._canvas.width ? ` (actual ${this._canvas.width}x${this._canvas.height})` : ""));
    lines.push(`device: ${this._deviceId || "default"}`);
    lines.push(`lastFrame: ${this._lastFrameAt ? new Date(this._lastFrameAt).toISOString() : "none"}`);
    if (this._error) lines.push(`lastError: ${this._error}`);
    return lines.join("\n") + "\n";
  }

  async _info() {
    let devices;
    try {
      devices = await this._devices();
    } catch (e) {
      devices = `${e.message}\n`;
    }
    return "cameras:\n" +
      devices.split("\n").map((l) => "  " + l).join("\n") +
      "\n" + this._status();
  }

  // ─── VirtualFS interface (paths relative to /camera) ────────

  async read(path) {
    const p = path.replace(/\/$/, "") || "/";
    if (p === "/") return this._info();
    if (p === "info") return this._info();
    if (p === "status") return this._status();
    if (p === "log") return this._log.join("");
    if (p === "frame") return await this._captureFrame();
    if (p === "size") return `${this._width}x${this._height}\n`;
    if (p === "device") return (this._deviceId || "default") + "\n";
    throw new Error("ENOENT");
  }

  async write(path, content) {
    const p = path.replace(/\/$/, "") || "/";
    const text = String(content).trim();
    if (p === "on") {
      if (this._running) return; // already running
      await this._ensureStream();
      return;
    }
    if (p === "off") {
      this._stop();
      return;
    }
    if (p === "size") {
      const m = /^(\d{1,4})\s*[xX]\s*(\d{1,4})$/.exec(text);
      if (!m) throw new Error("size needs 'WxH' (e.g. 640x480)");
      this._width = parseInt(m[1], 10);
      this._height = parseInt(m[2], 10);
      if (this._canvas) {
        this._canvas.width = this._width;
        this._canvas.height = this._height;
      }
      this._logLine(`[camera] size set to ${this._width}x${this._height}`);
      return;
    }
    if (p === "device") {
      // Accept an index from /dev/camera/info, a deviceId, or "default"
      if (text === "default" || text === "") {
        this._deviceId = "default";
        this._logLine("[camera] device set to default");
        return;
      }
      const idx = /^\d+$/.test(text) ? parseInt(text, 10) : -1;
      if (idx >= 0) {
        this._ensureBrowser();
        const list = await navigator.mediaDevices.enumerateDevices();
        const cams = list.filter((d) => d.kind === "videoinput");
        if (idx >= cams.length) throw new Error(`no camera #${idx} (see /dev/camera/info)`);
        this._deviceId = cams[idx].deviceId;
        this._logLine(`[camera] device set to #${idx} ${cams[idx].label || ""}`.trim());
        return;
      }
      this._deviceId = text;
      this._logLine(`[camera] device set to ${text}`);
      return;
    }
    throw new Error(`EROFS: cannot write /dev/camera/${p} ` +
      `(writable: on | off | size WxH | device <idx|id|default>)`);
  }

  async list(path) {
    const p = path.replace(/\/$/, "") || "/";
    if (p === "/") return ["device", "frame", "info", "log", "off", "on", "size", "status"];
    throw new Error("ENOTDIR");
  }

  async stat(path) {
    const p = path.replace(/\/$/, "") || "/";
    if (p === "/") return { type: "dir", size: 0, mtime: undefined };
    // Don't trigger a camera permission prompt just to stat the file;
    // report a fixed size instead (like /dev/clipboard).
    if (p === "frame") return { type: "file", size: 0, mtime: undefined };
    try {
      const text = await this.read(p);
      return { type: "file", size: text.length, mtime: undefined };
    } catch {
      return { type: "file", size: 0, mtime: undefined };
    }
  }

  async remove(path) {
    throw new Error("EROFS: Cannot remove camera devices");
  }
}

export { CameraDevice };
