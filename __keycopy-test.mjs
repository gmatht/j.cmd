// ─── __keycopy-test.mjs — while a game (mimecroft.sh) is presenting,
// the WebGLDevice's keydown capture must NOT swallow modifier-key
// combos: the j.cmd terminal copies a mouse selection on Ctrl+C (and
// the browser uses Ctrl+Shift+C / Meta+C), and the game's listener ran
// AFTER the terminal's capture-phase handler and preventDefault'd the
// default copy. The game only reads plain keys (wasd/arrows/space/q/
// Escape), so Ctrl/Meta/Alt keydowns must fall through untouched.
//
// Drives the REAL _ensureGL listener with a minimal DOM/WebGL stub and
// asserts: a plain key is queued + swallowed; every modifier combo is
// neither queued nor preventDefault'd; stale/hidden canvases still let
// everything through.
import { WebGLDevice } from "./src/fs/webgldev.js";

const fakeCtx = {
  DEPTH_TEST: 0x0b71, LEQUAL: 0x0203,
  enable() {}, depthFunc() {}, viewport() {}, clearColor() {}, clear() {},
  getParameter() { return ""; },
  createShader() { return {}; }, shaderSource() {}, compileShader() {},
  getShaderParameter() { return true; }, getShaderInfoLog() { return ""; },
  createProgram() { return {}; }, attachShader() {}, linkProgram() {},
  getProgramParameter() { return true; }, getProgramInfoLog() { return ""; },
  createBuffer() { return {}; }, bindBuffer() {}, bufferData() {},
  getAttribLocation() { return 0; }, enableVertexAttribArray() {},
  vertexAttribPointer() {}, getUniformLocation() { return {}; },
  uniform1f() {}, uniform2f() {}, uniform3f() {}, uniform4f() {}, uniform1i() {},
  drawElements() {}, drawArrays() {}, flush() {}, depthMask() {}, depthFunc() {},
  getExtension() { return null; },
};

let docListener = null;
const fakeCanvas = {
  style: { display: "none" },
  getContext: () => fakeCtx,
  appendChild() {},
  toDataURL: () => "data:,",
};
globalThis.document = {
  createElement: (tag) => (tag === "canvas" ? fakeCanvas : { style: {}, appendChild() {}, addEventListener() {}, classList: { add() {}, remove() {} } }),
  body: { appendChild() {} },
  addEventListener: (type, fn) => { if (type === "keydown") docListener = fn; },
};

const dev = new WebGLDevice();
// force the browser path so the real listener registers
dev._ensureGL();
if (!docListener) { console.log("FAIL: listener not registered"); process.exit(1); }

dev._canvas.style.display = "block";   // visible
dev._lastSwapAt = Date.now();          // fresh (< 2s)

let fails = 0;
const fire = (key, mods) => {
  const e = { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods, prevented: 0, stopped: 0, preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; } };
  dev._keys.length = 0;
  docListener(e);
  return e;
};
const check = (name, cond) => {
  if (cond) console.log("PASS: " + name);
  else { fails++; console.log("FAIL: " + name); }
};

// plain keys — the game's controls — are queued and swallowed
let e = fire("w", {});
check("plain 'w' queued", dev._keys.join(",") === "w");
check("plain 'w' preventDefault'd", e.prevented === 1);
check("plain 'w' stopPropagation'd", e.stopped === 1);

e = fire(" ", {});
check("plain space queued as 'space'", dev._keys.join(",") === "space");

// modifier combos — terminal/browser shortcuts — pass through untouched
for (const [name, mods] of [["ctrl", { ctrlKey: true }], ["meta", { metaKey: true }], ["alt", { altKey: true }], ["ctrl+shift", { ctrlKey: true, shiftKey: true }]]) {
  e = fire("c", mods);
  check(`${name}+c NOT queued`, dev._keys.length === 0);
  check(`${name}+c NOT preventDefault'd`, e.prevented === 0);
  check(`${name}+c NOT stopPropagation'd`, e.stopped === 0);
}

// the escape hatch still works: hidden or stale canvas → nothing captured
dev._canvas.style.display = "none";
e = fire("w", {});
check("hidden canvas: not queued", dev._keys.length === 0);
check("hidden canvas: not preventDefault'd", e.prevented === 0);
dev._canvas.style.display = "block";
dev._lastSwapAt = Date.now() - 5000;   // stale (swap > 2s ago)
e = fire("w", {});
check("stale canvas: not queued", dev._keys.length === 0);
check("stale canvas: not preventDefault'd", e.prevented === 0);

console.log(fails === 0 ? "__keycopy-test.mjs OK" : `FAILURES: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
