// ─── WebGLDevice: /dev/webgl — GPU via filesystem writes ────────
//
// Plan 9-style WebGL: every GPU resource is a file under /dev/webgl/.
// Write shader source, buffer data and uniform values as plain text,
// then drive drawing through /dev/webgl/call. The canvas is presented
// to the screen when a "swap" call is written (hidden until then).
//
//   /dev/webgl/info                 read   GPU vendor/renderer/version
//   /dev/webgl/extensions           read   supported extensions
//   /dev/webgl/state                read   full device state
//   /dev/webgl/log                  read   shader compile / link log
//   /dev/webgl/shader/vertex        write  vertex shader source (compiles)
//   /dev/webgl/shader/fragment      write  fragment shader source (compiles)
//   /dev/webgl/program              write  "link" relinks · read status
//   /dev/webgl/buffer/<name>        write  "f32 0 1 2 …" | "u16 0 1 2 …"
//   /dev/webgl/bind                 write  "<attribute> <buffer> [size]"
//   /dev/webgl/uniform/<t>/<name>   write  values (t: 1f 2f 3f 4f 1i m4)
//   /dev/webgl/clearcolor           write  "r g b a"
//   /dev/webgl/call                 write  "clear" | "swap" |
//                                         "draw [arrays|elements] <mode> <count> <offset> [buffer]"
//   /dev/webgl/frame                read   current frame as PNG data URL
//
// Shaders compile on write; the program links automatically at draw
// time (or explicitly via /dev/webgl/program). Vertex attributes are
// bound by name — a buffer whose name matches an active attribute
// (case-insensitively) is bound to it, or use /dev/webgl/bind to remap.
// -----------------------------------------------------------------

const UNIFORM_TYPES = ["1f", "2f", "3f", "4f", "1i", "m4"];
const UNIFORM_ARITY = { "1f": 1, "2f": 2, "3f": 3, "4f": 4, "1i": 1, m4: 16 };
const BUFFER_TYPES = ["f32", "f64", "u8", "u16", "i32"];

const BASE_ENTRIES = [
  "bind", "buffer/", "call", "clearcolor", "extensions", "frame",
  "info", "key", "log", "program", "shader/", "state", "uniform/",
];

function glTypeSize(gl, type) {
  switch (type) {
    case gl.FLOAT:
    case gl.INT: return 1;
    case gl.FLOAT_VEC2:
    case gl.INT_VEC2: return 2;
    case gl.FLOAT_VEC3:
    case gl.INT_VEC3: return 3;
    case gl.FLOAT_VEC4:
    case gl.INT_VEC4: return 4;
    case gl.FLOAT_MAT2: return 2;
    case gl.FLOAT_MAT3: return 3;
    case gl.FLOAT_MAT4: return 4;
    default: return 1;
  }
}

// ─── NullGL: headless no-op device (CLI / tests, no DOM) ─────────
// Accepts every write and draw so /dev/webgl scripts (games like
// mimecroft.sh) run logic-only in the Node CLI; the browser gets a real
// WebGL context. Reads return plausible values; frame is a placeholder.
function makeNullGL() {
  const counters = { shaders: 0, programs: 0, buffers: 0, draws: 0 };
  const gl = {
    VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30,
    ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893,
    STATIC_DRAW: 0x88e4, COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x100, DEPTH_TEST: 0x0b71, LEQUAL: 0x0203,
    TRIANGLES: 0x0004, TRIANGLE_STRIP: 0x0005, TRIANGLE_FAN: 0x0006,
    POINTS: 0x0000, LINES: 0x0001, LINE_LOOP: 0x0002, LINE_STRIP: 0x0003,
    FLOAT: 0x1406, INT: 0x1404, FLOAT_VEC2: 0x8b50, FLOAT_VEC3: 0x8b51,
    FLOAT_VEC4: 0x8b52, INT_VEC2: 0x8b53, INT_VEC3: 0x8b54, INT_VEC4: 0x8b55,
    FLOAT_MAT2: 0x8b5a, FLOAT_MAT3: 0x8b5b, FLOAT_MAT4: 0x8b5c,
    UNSIGNED_BYTE: 0x1401, UNSIGNED_SHORT: 0x1403,
    LINK_STATUS: 0x8b82,
    ACTIVE_ATTRIBUTES: 0x8b89, ACTIVE_UNIFORMS: 0x8b86,
    COMPILE_STATUS: 0x8b81,
    createBuffer: () => ({ id: ++counters.buffers }),
    deleteBuffer: () => {},
    bindBuffer: () => {},
    bufferData: () => {},
    createShader: () => ({ id: ++counters.shaders }),
    deleteShader: () => {},
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => "",
    createProgram: () => ({ id: ++counters.programs }),
    deleteProgram: () => {},
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: (p, name) => name === 0x8b82 ? 1 : (name === 0x8b89 ? 2 : (name === 0x8b86 ? 6 : 0)),  // LINK/ATTRIBS/UNIFORMS for the null device
    getProgramInfoLog: () => "",
    useProgram: () => {},
    getUniformLocation: () => ({}),
    uniform1f: () => {}, uniform2f: () => {}, uniform3f: () => {},
    uniform4f: () => {}, uniform1i: () => {}, uniformMatrix4fv: () => {},
    getAttribLocation: () => 0,
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    getActiveAttrib: (p, i) => ({
      name: i === 0 ? "aPosition" : "aShade",
      type: gl.FLOAT_VEC3,
    }),
    drawArrays: () => { counters.draws++; },
    drawElements: () => { counters.draws++; },
    clear: () => {},
    clearColor: () => {},
    flush: () => {},
    getParameter: (p) => p === 0x1f02 ? "headless null device" : "0",
    getSupportedExtensions: () => [],
  };
  gl._counters = counters;
  return gl;
}

export class WebGLDevice {
  constructor() {
    this._gl = null;              // lazily created WebGL context
    this._canvas = null;
    this._contextName = null;
    this._shaderSource = { vertex: "", fragment: "" };
    this._shaders = { vertex: null, fragment: null };  // compiled shaders
    this._program = null;
    this._programLinked = false;
    this._log = "WebGL device ready.\n";
    this._buffers = new Map();    // name → { buffer, arr, type }
    this._bindings = new Map();   // attribute → { buffer, size }
    this._uniforms = new Map();   // name → { type, value: number[] }
    this._clearColor = [0, 0, 0, 1];
    this._lastCall = "";
    this._lastElementBuffer = null;  // name of last written u8/u16 buffer
    this._keys = [];                 // key queue (a game reads /dev/webgl/key)
    this._hudRects = null;           // overlay rect list (batched /dev/webgl/hud)
    this._hudTris = null;           // overlay triangles (T … lines)
    this._lastSwapAt = 0;            // for key-steal timeout after a game ends
    this._keyListener = null;
    this._null = false;              // headless null-device mode (no DOM)
  }

  // ─── Context ────────────────────────────────────────────────

  _ensureGL() {
    if (this._gl) return this._gl;
    if (typeof document === "undefined") {
      // Headless: a null device that accepts everything (no visuals).
      this._gl = makeNullGL();
      this._null = true;
      this._contextName = "headless (null device)";
      this._log += "[context] headless null device (no DOM)\n";
      return this._gl;
    }
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 800;
      canvas.height = 600;
      canvas.id = "sh2runtime-webgl";
      canvas.style.cssText = [
        "position:fixed", "right:12px", "bottom:12px", "z-index:9999",
        "border:1px solid #444", "border-radius:4px", "background:#000",
        "display:none", "box-shadow:0 4px 20px rgba(0,0,0,.5)",
      ].join(";");
      document.body.appendChild(canvas);
      this._canvas = canvas;
      // Prefer WebGL1: the target GLSL (attribute/varying/gl_FragColor)
      // is ES 1.00, which only compiles on a WebGL1 context.
      const ctx = canvas.getContext("webgl") ||
                  canvas.getContext("webgl2") ||
                  canvas.getContext("experimental-webgl");
      if (!ctx) throw new Error("context creation failed");
      this._gl = ctx;
      // Depth testing: the painter's-algorithm games (mimecroft.sh) draw
      // cubes far-to-near, but a cube right against the camera has its
      // near face at z≈0 (huge on screen) while its far face is small —
      // without per-pixel depth those faces overlap and the block
      // flickers between "zoomed in" and "zoomed out". Enable depth so
      // the GPU sorts every fragment correctly.
      try { ctx.enable(ctx.DEPTH_TEST); ctx.depthFunc(ctx.LEQUAL); } catch {}
      this._contextName = (typeof WebGL2RenderingContext !== "undefined" &&
                           ctx instanceof WebGL2RenderingContext)
        ? "WebGL2" : "WebGL1";
      this._log += `[context] ${this._contextName} ready\n`;
      // A game (e.g. mimecroft.sh) steals the keyboard while the canvas
      // is presenting: capture keys into a queue readable at
      // /dev/webgl/key. Keys flow back to the shell ~2s after the last
      // swap, so an abandoned game can't lock the terminal.
      if (!this._keyListener) {
        this._keyListener = (e) => {
          const visible = this._canvas && this._canvas.style.display !== "none";
          const fresh = Date.now() - this._lastSwapAt < 2000;
          if (!visible || !fresh) return;
          if (this._keys.length < 64) this._keys.push(e.key === " " ? "space" : e.key);
          e.preventDefault();
          e.stopPropagation();
        };
        document.addEventListener("keydown", this._keyListener, true);
      }
      return ctx;
    } catch (e) {
      throw new Error("WebGL not available: " + (e.message || e));
    }
  }

  _glOrNull() {
    try { return this._ensureGL(); } catch { return null; }
  }

  // ─── Shaders / program ──────────────────────────────────────

  _compileShader(kind, source) {
    const gl = this._ensureGL();
    const type = kind === "vertex" ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER;
    this._shaderSource[kind] = source;
    if (this._shaders[kind]) {
      gl.deleteShader(this._shaders[kind]);
      this._shaders[kind] = null;
    }
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = (gl.getShaderInfoLog(shader) || "unknown compile error").trim();
      gl.deleteShader(shader);
      this._programLinked = false;
      this._log += `[shader/${kind}] FAILED: ${info}\n`;
      throw new Error(`shader ${kind} compile failed: ${info}`);
    }
    this._shaders[kind] = shader;
    this._programLinked = false;  // needs relink
    this._log += `[shader/${kind}] compiled OK (${source.length} chars)\n`;
  }

  _linkProgram() {
    const gl = this._ensureGL();
    if (this._programLinked && this._program) return this._program;
    if (!this._shaders.vertex || !this._shaders.fragment) {
      throw new Error("need both shaders first: write /dev/webgl/shader/vertex and /dev/webgl/shader/fragment");
    }
    const program = gl.createProgram();
    gl.attachShader(program, this._shaders.vertex);
    gl.attachShader(program, this._shaders.fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = (gl.getProgramInfoLog(program) || "unknown link error").trim();
      gl.deleteProgram(program);
      this._log += `[program] link FAILED: ${info}\n`;
      throw new Error(`program link failed: ${info}`);
    }
    if (this._program) gl.deleteProgram(this._program);
    this._program = program;
    this._programLinked = true;
    this._log += "[program] linked OK\n";
    return program;
  }

  // ─── Buffers ────────────────────────────────────────────────

  _parseBuffer(text) {
    let tokens = text.trim().split(/[\s,]+/).filter(Boolean);
    if (!tokens.length) throw new Error("empty buffer data");
    let type = "f32";
    const first = tokens[0].toLowerCase();
    if (BUFFER_TYPES.includes(first)) {
      type = first;
      tokens = tokens.slice(1);
    }
    if (!tokens.length) throw new Error("buffer data needs values after the type (e.g. 'f32 0 1 2')");
    const nums = tokens.map(Number);
    if (nums.some((n) => Number.isNaN(n))) throw new Error("non-numeric value in buffer data");
    let arr;
    switch (type) {
      case "f32": arr = new Float32Array(nums); break;
      case "f64": arr = new Float64Array(nums); break;
      case "u8": arr = new Uint8Array(nums); break;
      case "u16": arr = new Uint16Array(nums); break;
      case "i32": arr = new Int32Array(nums); break;
    }
    return { arr, type };
  }

  _uploadBuffer(name, parsed) {
    const gl = this._ensureGL();
    let entry = this._buffers.get(name);
    if (!entry) {
      entry = { name, buffer: gl.createBuffer(), arr: null, type: null };
      this._buffers.set(name, entry);
    }
    const isElement = parsed.type === "u8" || parsed.type === "u16";
    const target = isElement ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER;
    gl.bindBuffer(target, entry.buffer);
    gl.bufferData(target, parsed.arr, gl.STATIC_DRAW);
    entry.arr = parsed.arr;
    entry.type = parsed.type;
    if (isElement) this._lastElementBuffer = name;
    this._log += `[buffer/${name}] ${parsed.type} ${parsed.arr.length} values\n`;
    return entry;
  }

  // ─── Uniforms / bindings / clear color ──────────────────────

  _setUniform(type, name, text) {
    const vals = text.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (vals.some(Number.isNaN)) throw new Error(`uniform '${name}': non-numeric value`);
    const need = UNIFORM_ARITY[type];
    if (vals.length < need) {
      throw new Error(`uniform '${name}' (${type}) needs ${need} value(s), got ${vals.length}`);
    }
    this._uniforms.set(name, { type, value: vals });
    this._log += `[uniform/${type}/${name}] ${vals.join(" ")}\n`;
  }

  _applyUniforms() {
    const gl = this._gl;
    for (const [name, u] of this._uniforms) {
      const loc = gl.getUniformLocation(this._program, name);
      if (loc === null) continue;  // not active in the current program
      const v = u.value;
      switch (u.type) {
        case "1f": gl.uniform1f(loc, v[0]); break;
        case "2f": gl.uniform2f(loc, v[0], v[1]); break;
        case "3f": gl.uniform3f(loc, v[0], v[1], v[2]); break;
        case "4f": gl.uniform4f(loc, v[0], v[1], v[2], v[3]); break;
        case "1i": gl.uniform1i(loc, v[0]); break;
        case "m4": gl.uniformMatrix4fv(loc, false, new Float32Array(v)); break;
      }
    }
  }

  _setBind(text) {
    const parts = text.trim().split(/[\s,]+/).filter(Boolean);
    if (parts.length < 2) throw new Error("bind needs: <attribute> <buffer> [size]");
    const size = parts[2] ? parseInt(parts[2], 10) : null;
    this._bindings.set(parts[0], { buffer: parts[1], size });
    this._log += `[bind] ${parts[0]} → ${parts[1]}${size ? " size=" + size : ""}\n`;
  }

  _setClearColor(text) {
    const vals = text.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (vals.length < 4 || vals.some(Number.isNaN)) {
      throw new Error("clearcolor needs 4 numbers: r g b a");
    }
    this._clearColor = vals.slice(0, 4);
    this._log += `[clearcolor] ${vals.join(" ")}\n`;
  }

  // ─── Drawing ────────────────────────────────────────────────

  _doCall(raw) {
    const gl = this._ensureGL();
    const parts = raw.trim().split(/[\s,]+/).filter(Boolean);
    if (!parts.length) throw new Error("empty call");
    const op = parts[0].toLowerCase();
    if (op === "clear") {
      gl.clearColor(this._clearColor[0], this._clearColor[1],
                    this._clearColor[2], this._clearColor[3]);
      // depth too — the per-frame depth buffer must reset or fragments
      // from the previous frame stay "nearer" and blocks vanish
      gl.clear(gl.COLOR_BUFFER_BIT | (gl.DEPTH_BUFFER_BIT || 0x100));
      this._lastCall = raw.trim();
      return;
    }
    if (op === "swap") {
      // Present to screen — the canvas stays hidden until the first swap
      gl.flush();
      if (this._canvas) this._canvas.style.display = "block";
      this._lastSwapAt = Date.now();
      this._lastCall = raw.trim();
      return;
    }
    if (op === "hide") {
      // A game finished: hide the canvas and drop the key queue so the
      // keyboard returns to the shell immediately.
      this._keys = [];
      if (this._canvas) this._canvas.style.display = "none";
      this._lastCall = raw.trim();
      return;
    }
    if (op === "draw") {
      this._draw(parts.slice(1));
      this._lastCall = raw.trim();
      return;
    }
    throw new Error(`unknown call '${op}' (use: clear | swap | draw [arrays|elements] <mode> <count> <offset>)`);
  }

  _draw(args) {
    const gl = this._ensureGL();
    const program = this._linkProgram();
    gl.useProgram(program);

    let kind = "arrays";
    let mode = "triangles";
    let count = undefined;
    let offset = 0;
    let indexBuffer = null;
    let rest = args;
    if (rest[0] === "arrays" || rest[0] === "elements") {
      kind = rest[0];
      rest = rest.slice(1);
    }
    if (rest.length) mode = rest.shift().toLowerCase();
    if (rest.length && rest[0] !== "") {
      const n = parseInt(rest.shift(), 10);
      if (!Number.isNaN(n)) count = n;
    }
    if (rest.length && rest[0] !== "") {
      const o = parseInt(rest.shift(), 10);
      if (!Number.isNaN(o)) offset = o;
    }
    if (rest.length) indexBuffer = rest.shift();

    const modes = {
      points: gl.POINTS, lines: gl.LINES, line_loop: gl.LINE_LOOP,
      line_strip: gl.LINE_STRIP, triangles: gl.TRIANGLES,
      triangle_strip: gl.TRIANGLE_STRIP, triangle_fan: gl.TRIANGLE_FAN,
    };
    const glMode = modes[mode];
    if (glMode === undefined) throw new Error(`unknown draw mode '${mode}'`);

    const maxVerts = this._bindAttributes();
    this._applyUniforms();

    if (kind === "elements") {
      const bufName = indexBuffer || this._lastElementBuffer;
      if (!bufName) throw new Error("no index buffer: write 'u16 …' data first (e.g. /dev/webgl/buffer/indices)");
      const entry = this._buffers.get(bufName);
      if (!entry) throw new Error(`unknown index buffer '${bufName}'`);
      const isU8 = entry.type === "u8";
      const glIndexType = isU8 ? gl.UNSIGNED_BYTE : gl.UNSIGNED_SHORT;
      const bytesPer = isU8 ? 1 : 2;
      const n = count !== undefined ? count : entry.arr.length;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, entry.buffer);
      gl.drawElements(glMode, n, glIndexType, offset * bytesPer);
    } else {
      const n = count !== undefined ? count : maxVerts;
      if (n <= 0) throw new Error("no vertices to draw (are buffers bound to attributes?)");
      gl.drawArrays(glMode, offset, n);
    }
    this._log += `[call] draw ${kind} ${mode} count=${count !== undefined ? count : "auto"} offset=${offset}\n`;
  }

  // Binds every active attribute to a same-named buffer (or an explicit
  // /dev/webgl/bind override). Returns the max vertex count available.
  _bindAttributes() {
    const gl = this._gl;
    const program = this._program;
    const attribCount = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES);
    let bound = 0;
    let maxVerts = 0;
    for (let i = 0; i < attribCount; i++) {
      const info = gl.getActiveAttrib(program, i);
      if (!info) continue;
      const override = this._bindings.get(info.name);
      let bufferName = override ? override.buffer : this._findBufferForAttrib(info.name);
      if (!bufferName) continue;
      const entry = this._buffers.get(bufferName);
      if (!entry) continue;
      const size = override && override.size ? override.size : glTypeSize(gl, info.type);
      const loc = gl.getAttribLocation(program, info.name);
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      bound++;
      const verts = (entry.type === "f32" || entry.type === "f64")
        ? Math.floor(entry.arr.length / size) : 0;
      if (verts > maxVerts) maxVerts = verts;
    }
    if (bound === 0) {
      throw new Error("no attributes bound (name buffers after attributes, e.g. /dev/webgl/buffer/aPosition, or use /dev/webgl/bind)");
    }
    return maxVerts;
  }

  _findBufferForAttrib(name) {
    const lower = name.toLowerCase();
    for (const key of this._buffers.keys()) {
      if (key.toLowerCase() === lower) return key;
    }
    return null;
  }

  // ─── Read-only generated files ──────────────────────────────

  _info() {
    const gl = this._glOrNull();
    if (!gl) return "WebGL not available\n";
    return [
      `context: ${this._contextName}`,
      `vendor: ${gl.getParameter(gl.VENDOR)}`,
      `renderer: ${gl.getParameter(gl.RENDERER)}`,
      `version: ${gl.getParameter(gl.VERSION)}`,
      `shadingLanguageVersion: ${gl.getParameter(gl.SHADING_LANGUAGE_VERSION)}`,
      `maxTextureSize: ${gl.getParameter(gl.MAX_TEXTURE_SIZE)}`,
      `maxVertexAttributes: ${gl.getParameter(gl.MAX_VERTEX_ATTRIBS)}`,
      `maxCombinedTextureImageUnits: ${gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS)}`,
    ].join("\n") + "\n";
  }

  _extensions() {
    const gl = this._glOrNull();
    if (!gl) return "WebGL not available\n";
    return gl.getSupportedExtensions().sort().join("\n") + "\n";
  }

  _state() {
    const gl = this._glOrNull();
    const lines = [];
    lines.push(`context: ${gl ? this._contextName : "not available"}`);
    lines.push(`canvas: ${this._canvas
      ? `${this._canvas.width}x${this._canvas.height}${this._canvas.style.display === "none" ? " (hidden)" : " (visible)"}`
      : "none"}`);
    for (const kind of ["vertex", "fragment"]) {
      const src = this._shaderSource[kind];
      const status = !src ? "not set"
        : this._shaders[kind] ? "compiled" : "FAILED";
      lines.push(`shader/${kind}: ${src ? src.length + " chars" : "—"} — ${status}`);
    }
    lines.push(`program: ${this._programLinked ? "linked" : "not linked"}`);
    if (this._buffers.size) {
      lines.push("buffers:");
      for (const [name, e] of this._buffers) {
        lines.push(`  ${name}: ${e.type}, ${e.arr.length} values`);
      }
    }
    if (this._uniforms.size) {
      lines.push("uniforms:");
      for (const [name, u] of this._uniforms) {
        lines.push(`  ${name} (${u.type}): ${u.value.join(" ")}`);
      }
    }
    if (this._bindings.size) {
      lines.push("bindings:");
      for (const [attr, b] of this._bindings) {
        lines.push(`  ${attr} → ${b.buffer}${b.size ? " (size " + b.size + ")" : ""}`);
      }
    }
    lines.push(`clearColor: ${this._clearColor.join(" ")}`);
    lines.push(`lastCall: ${this._lastCall || "—"}`);
    return lines.join("\n") + "\n";
  }

  _programStatus() {
    const gl = this._glOrNull();
    const lines = [`program: ${this._programLinked ? "linked" : "not linked"}`];
    if (this._program && gl) {
      lines.push(`active attributes: ${gl.getProgramParameter(this._program, gl.ACTIVE_ATTRIBUTES)}`);
      lines.push(`active uniforms: ${gl.getProgramParameter(this._program, gl.ACTIVE_UNIFORMS)}`);
    }
    return lines.join("\n") + "\n";
  }

  // Draw the batched 2D overlay (see /dev/webgl/hud). Uses the quad
  // buffers the game uploads (quadpos/quadshade/quadi) and the overlay
  // shader path — one direct GL pass, no per-rect async round-trips.
  _drawHud() {
    const gl = this._gl;
    if (!gl || !this._hudRects || !this._hudRects.length) return;
    const rects = this._hudRects;
    this._hudRects = null;
    const program = this._linkProgram();
    gl.useProgram(program);
    const bind = (attr, bufName) => {
      const entry = this._buffers.get(bufName);
      if (!entry) return false;
      const loc = gl.getAttribLocation(program, attr);
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
      return true;
    };
    if (!bind("aPosition", "quadpos")) return;
    bind("aShade", "quadshade");
    const idx = this._buffers.get("quadi");
    if (!idx) return;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx.buffer);
    const loc = (n) => gl.getUniformLocation(program, n);
    const uPos = loc("uObjPos"), uScale = loc("uScale"), uColor = loc("uBlockColor"), uOverlay = loc("uOverlay");
    if (uOverlay) gl.uniform1f(uOverlay, 1.0);
    const idxType = idx.type === "u8" ? gl.UNSIGNED_BYTE : gl.UNSIGNED_SHORT;
    for (const [cx, cy, w, h, r, g, b] of rects) {
      if (uPos) gl.uniform3f(uPos, cx, cy, 0);
      if (uScale) gl.uniform3f(uScale, w, h, 1);
      if (uColor) gl.uniform3f(uColor, r, g, b);
      gl.drawElements(gl.TRIANGLES, 6, idxType, 0);
    }
    // triangles: T cx cy size r g b deg — a dynamic vertex buffer, rotated
    const tris = this._hudTris || [];
    if (tris.length) {
      if (!this._triBuf) this._triBuf = gl.createBuffer();
      const aLoc = gl.getAttribLocation(program, "aPosition");
      gl.bindBuffer(gl.ARRAY_BUFFER, this._triBuf);
      gl.enableVertexAttribArray(aLoc);
      gl.vertexAttribPointer(aLoc, 3, gl.FLOAT, false, 0, 0);
      for (const [cx, cy, size, r, g, b, deg] of tris) {
        const a = deg * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
        const v = (vx, vy) => [cx + size * (vx * c - vy * sn), cy + size * (vx * sn + vy * c), 0];
        const verts = new Float32Array([...v(0, 0.5), ...v(-0.5, -0.5), ...v(0.5, -0.5)]);
        gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
        if (uColor) gl.uniform3f(uColor, r, g, b);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    }
    this._log += `[hud] ${rects.length} rects ${tris.length} tris\n`;
  }

  _frameDataURL() {
    const gl = this._ensureGL();
    gl.flush();
    if (!this._canvas || this._null) return "data:image/png;base64,iVBORw0KGgo=";
    return this._canvas.toDataURL("image/png");
  }

  // ─── VirtualFS interface (paths relative to /webgl) ─────────

  async read(path) {
    const p = path.replace(/\/$/, "") || "/";
    const parts = p.split("/").filter(Boolean);
    if (p === "/" || parts[0] === "info") return this._info();
    if (parts[0] === "extensions") return this._extensions();
    if (parts[0] === "state") return this._state();
    if (parts[0] === "log") return this._log + "\n";
    if (parts[0] === "frame") return this._frameDataURL();
    if (parts[0] === "call") return this._lastCall + "\n";
    if (parts[0] === "key") {
      const keys = this._keys;
      this._keys = [];
      return keys.join(",") + "\n";
    }
    if (parts[0] === "clearcolor") return this._clearColor.join(" ") + "\n";
    if (parts[0] === "program") return this._programStatus();
    if (parts[0] === "bind") {
      if (!this._bindings.size) return "(auto: buffers bind to attributes by name)\n";
      return [...this._bindings.entries()]
        .map(([a, b]) => `${a} ${b.buffer}${b.size ? " " + b.size : ""}`)
        .join("\n") + "\n";
    }
    if (parts[0] === "shader" && parts.length === 2 &&
        (parts[1] === "vertex" || parts[1] === "fragment")) {
      return this._shaderSource[parts[1]] || "// no shader written yet\n";
    }
    if (parts[0] === "buffer" && parts.length === 2) {
      const e = this._buffers.get(parts[1]);
      if (!e) throw new Error(`ENOENT: no buffer '${parts[1]}' (write: echo "f32 …" > /dev/webgl/buffer/${parts[1]})`);
      return e.type + " " + Array.from(e.arr).join(" ") + "\n";
    }
    if (parts[0] === "uniform" && parts.length === 3) {
      const u = this._uniforms.get(parts[2]);
      if (!u) throw new Error(`ENOENT: no uniform '${parts[2]}'`);
      return u.type + " " + u.value.join(" ") + "\n";
    }
    throw new Error("ENOENT");
  }

  async write(path, content) {
    const p = path.replace(/\/$/, "") || "/";
    const parts = p.split("/").filter(Boolean);
    if (!parts.length) throw new Error("EROFS: /dev/webgl is a directory");
    if (parts[0] === "shader" && parts.length === 2 &&
        (parts[1] === "vertex" || parts[1] === "fragment")) {
      this._compileShader(parts[1], String(content));
      return;
    }
    if (parts[0] === "program") {
      if (String(content).trim().toLowerCase() !== "link") {
        throw new Error("write 'link' to /dev/webgl/program");
      }
      this._linkProgram();
      return;
    }
    if (parts[0] === "buffer" && parts.length === 2) {
      this._uploadBuffer(parts[1], this._parseBuffer(String(content)));
      return;
    }
    if (parts[0] === "bind") {
      this._setBind(String(content));
      return;
    }
    if (parts[0] === "uniform" && parts.length === 3) {
      if (!UNIFORM_TYPES.includes(parts[1])) {
        throw new Error(`unknown uniform type '${parts[1]}' (use: 1f 2f 3f 4f 1i m4)`);
      }
      this._setUniform(parts[1], parts[2], String(content));
      return;
    }
    if (parts[0] === "clearcolor") {
      this._setClearColor(String(content));
      return;
    }
    if (parts[0] === "call") {
      this._doCall(String(content));
      return;
    }
    if (parts[0] === "hud") {
      // 2D overlay: newline-separated rects "cx cy w h r g b" (NDC).
      // Drawn IMMEDIATELY into the back buffer, so the presented frame
      // (world + HUD) is atomic at the next swap — one write instead of
      // hundreds of per-quad round-trips (the HUD used to cost ~90ms
      // of async writes and blink because it landed after the swap).
      this._hudRects = [];
      this._hudTris = [];
      for (const line of String(content).split("\n")) {
        const t = line.trim();
        if (t.startsWith("T ")) {
          // triangle: T cx cy size r g b deg (deg rotates the up-pointing
          // unit triangle clockwise in NDC — the player facing marker)
          const nums = t.slice(2).trim().split(/[\s,]+/).filter(Boolean).map(Number);
          if (nums.length >= 7 && nums.every((n) => Number.isFinite(n))) {
            this._hudTris.push(nums.slice(0, 7));
          }
        } else {
          const nums = t.split(/[\s,]+/).filter(Boolean).map(Number);
          if (nums.length >= 7 && nums.every((n) => Number.isFinite(n))) {
            this._hudRects.push(nums.slice(0, 7));
          }
        }
      }
      this._drawHud();
      return;
    }
    if (parts[0] === "key") {
      if (String(content).trim().toLowerCase() === "clear") this._keys = [];
      return;
    }
    throw new Error(`EROFS: cannot write /dev/webgl/${p}`);
  }

  async list(path) {
    const p = path.replace(/\/$/, "") || "/";
    const parts = p.split("/").filter(Boolean);
    if (!parts.length) return [...BASE_ENTRIES];
    if (parts[0] === "shader" && parts.length === 1) return ["fragment", "vertex"];
    if (parts[0] === "buffer" && parts.length === 1) return [...this._buffers.keys()].sort();
    if (parts[0] === "uniform" && parts.length === 1) {
      const types = new Set();
      for (const u of this._uniforms.values()) types.add(u.type + "/");
      return [...types].sort();
    }
    if (parts[0] === "uniform" && parts.length === 2) {
      return [...this._uniforms.entries()]
        .filter(([, u]) => u.type === parts[1])
        .map(([name]) => name)
        .sort();
    }
    throw new Error(`ENOTDIR: /dev/webgl/${p}`);
  }

  async stat(path) {
    const p = path.replace(/\/$/, "") || "/";
    const parts = p.split("/").filter(Boolean);
    const isDir = !parts.length ||
      (parts[0] === "shader" && parts.length === 1) ||
      (parts[0] === "buffer" && parts.length === 1) ||
      (parts[0] === "uniform" && parts.length <= 2);
    if (isDir) return { type: "dir", size: 0, mtime: undefined };
    try {
      const text = await this.read(p);
      return { type: "file", size: text.length, mtime: undefined };
    } catch {
      return { type: "file", size: 0, mtime: undefined };
    }
  }

  async remove(path) {
    const p = path.replace(/\/$/, "") || "/";
    const parts = p.split("/").filter(Boolean);
    if (parts[0] === "buffer" && parts.length === 2) {
      const e = this._buffers.get(parts[1]);
      if (!e) throw new Error(`ENOENT: no buffer '${parts[1]}'`);
      if (this._gl) this._gl.deleteBuffer(e.buffer);
      this._buffers.delete(parts[1]);
      if (this._lastElementBuffer === parts[1]) this._lastElementBuffer = null;
      return;
    }
    if (parts[0] === "uniform" && parts.length === 3) {
      if (!this._uniforms.delete(parts[2])) throw new Error(`ENOENT: no uniform '${parts[2]}'`);
      return;
    }
    throw new Error(`EROFS: cannot remove /dev/webgl/${p}`);
  }
}
