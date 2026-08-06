// xterm v3 — a floating, draggable terminal (xterm.js) that is its own
// shell session: own cwd and own environment, sharing the filesystem.
//   xterm            open the floating terminal; type exit to close
// Each line runs through the shell's machinery with the session's cwd
// and env overlaid; cd/export inside never touch the main shell.
var NL = String.fromCharCode(10);
var BS = String.fromCharCode(8);
var DEL = String.fromCharCode(127);
var ETX = String.fromCharCode(3);   // Ctrl+C
var FF = String.fromCharCode(12);   // Ctrl+L
var CR = String.fromCharCode(13);   // Enter
var ESC = String.fromCharCode(27);  // escape (arrow keys)
if (typeof document === "undefined") {
  console.log("xterm: needs a browser (run in the web shell)");
  return 1;
}
// Load xterm.js + the fit addon from the vendored www/vendor/ dir.
function loadScript(src) {
  return new Promise(function (resolve, reject) {
    if (document.querySelector('script[src="' + src + '"]')) return resolve();
    var s = document.createElement("script");
    s.src = src;
    s.onload = function () { resolve(); };
    s.onerror = function () { reject(new Error("failed to load " + src)); };
    document.head.appendChild(s);
  });
}
try {
  await loadScript("vendor/xterm.js");
  await loadScript("vendor/xterm-fit.js");
} catch (e) {
  console.log("xterm: " + e.message);
  return 1;
}
if (!window.Terminal) { console.log("xterm: Terminal not available after load"); return 1; }
var Terminal = window.Terminal;
if (!document.querySelector('link[href="vendor/xterm.css"]')) {
  var link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "vendor/xterm.css";
  document.head.appendChild(link);
}
// ── floating window (draggable by the title bar) ──
var win = document.createElement("div");
win.className = "xterm-window";
win.style.cssText = "position:fixed;left:15%;top:10%;width:70%;height:60%;background:#0d1117;border:1px solid #30363d;border-radius:8px;z-index:60;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,.5);";
var bar = document.createElement("div");
bar.className = "xterm-bar";
bar.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:6px 12px;background:#161b22;color:#8b949e;font:12px monospace;border-bottom:1px solid #30363d;border-radius:8px 8px 0 0;cursor:move;user-select:none;";
var title = document.createElement("span");
title.textContent = "xterm — floating shell (drag me · exit to close)";
var closeBtn = document.createElement("button");
closeBtn.textContent = "x";
closeBtn.style.cssText = "background:#21262d;color:#d6a0a0;border:1px solid #30363d;border-radius:4px;cursor:pointer;padding:0 9px;font:bold 14px monospace;";
bar.appendChild(title);
bar.appendChild(closeBtn);
var body = document.createElement("div");
body.style.cssText = "flex:1;padding:8px;overflow:hidden;";
win.appendChild(bar);
win.appendChild(body);
document.body.appendChild(win);
var dragState = null;
function onBarDown(e) {
  dragState = { dx: e.clientX - win.offsetLeft, dy: e.clientY - win.offsetTop };
  e.preventDefault();
}
function onDocMove(e) {
  if (!dragState) return;
  win.style.left = (e.clientX - dragState.dx) + "px";
  win.style.top = (e.clientY - dragState.dy) + "px";
}
function onDocUp() { dragState = null; }
bar.addEventListener("mousedown", onBarDown);
document.addEventListener("mousemove", onDocMove);
document.addEventListener("mouseup", onDocUp);
// ── terminal ──
var term = new Terminal({
  cursorBlink: true,
  fontSize: 14,
  convertEol: true,
  scrollback: 1000,
  theme: { background: "#0d1117", foreground: "#e0e0e0", cursor: "#7ec8e3", selectionBackground: "#264f78" },
});
var fit = new window.FitAddon.FitAddon();
term.loadAddon(fit);
term.open(body);
fit.fit();
var onResize = function () { try { fit.fit(); } catch (e) {} };
window.addEventListener("resize", onResize);
// ── the session: own cwd + own env, shared filesystem ──
var termCwd = fs.cwd;
var termEnv = {};
var EXCLUDE = { PWD: 1, COLUMNS: 1, LINES: 1, SHELL: 1 };
function runSession(cmd) {
  var mainCwd = fs.cwd;
  // Snapshot the WHOLE shared env before touching it — the session's
  // exports must be reverted afterwards, and pre-existing vars (PATH,
  // HOME, ...) must never be captured as if the session exported them.
  var envSnapshot = {};
  for (var k in env) envSnapshot[k] = env[k];
  var tKeys = Object.keys(termEnv);
  for (var i = 0; i < tKeys.length; i++) env[tKeys[i]] = termEnv[tKeys[i]];
  fs.cwd = termCwd;
  var preCwd = fs.cwd;                       // the float's cwd before this run
  return shell.runLine(cmd).then(function (res) {
    // capture what the run exported or changed into the session env
    for (var k in env) {
      if (!EXCLUDE[k] && (envSnapshot[k] === undefined || env[k] !== envSnapshot[k])) termEnv[k] = env[k];
    }
    for (var j = 0; j < tKeys.length; j++) {
      if (!(tKeys[j] in env)) delete termEnv[tKeys[j]];
    }
    // cd inside follows the session. Compare against the float's own
    // pre-run cwd, not the main shell's: when the float cd's to the
    // main shell's cwd (e.g. /home) the old check mistook it for "no
    // change" and left the float's prompt stuck.
    if (fs.cwd !== preCwd) termCwd = fs.cwd;
    fs.cwd = mainCwd;                            // main shell unaffected
    env.PWD = mainCwd;
    // revert every key the session env touches (overlay + new exports)
    var sKeys = Object.keys(termEnv);
    for (var m = 0; m < sKeys.length; m++) {
      var k3 = sKeys[m];
      if (envSnapshot[k3] === undefined) delete env[k3];
      else env[k3] = envSnapshot[k3];
    }
    return res;
  });
}
// ── line editing + history ──
var line = "";
var history = [];
var histIdx = 0;
function prompt() { term.write("jtsh:" + termCwd + "$ "); }
function setLine(s) {
  while (line.length > 0) { line = line.slice(0, -1); term.write(BS + " " + BS); }
  line = s;
  term.write(s);
}
function submit() {
  var cmd = line;
  line = "";
  term.write(NL);
  if (cmd.trim() === "exit" || cmd.trim() === "quit") { closeIt(); return; }
  if (cmd.trim()) history.push(cmd);
  histIdx = history.length;
  runSession(cmd).then(function (res) {
    var out = (res && res.out ? res.out : "") + (res && res.err ? res.err : "");
    if (out) term.write(out);
    if (!out.endsWith(NL)) term.write(NL);
    prompt();
  }).catch(function (e) {
    term.write("error: " + e.message + NL);
    prompt();
  });
}
function histPrev() {
  if (history.length === 0) return;
  histIdx = Math.max(0, histIdx - 1);
  setLine(history[histIdx]);
}
function histNext() {
  if (histIdx < history.length) {
    histIdx++;
    setLine(histIdx === history.length ? "" : history[histIdx]);
  }
}
function onData(data) {
  if (data === ESC + "[A") { histPrev(); return; }
  if (data === ESC + "[B") { histNext(); return; }
  for (var i = 0; i < data.length; i++) {
    var ch = data[i];
    if (ch === CR) submit();
    else if (ch === DEL || ch === BS) {
      if (line.length > 0) { line = line.slice(0, -1); term.write(BS + " " + BS); }
    }
    else if (ch === ETX) { line = ""; term.write("^C" + NL); prompt(); }
    else if (ch === FF) { term.clear(); prompt(); }
    else if (ch >= " ") { line += ch; term.write(ch); }
  }
}
term.onData(onData);
// ── close (button, exit command, or shell Ctrl+C) ──
var done = false;
function cleanup() {
  if (done) return;
  done = true;
  window.removeEventListener("resize", onResize);
  document.removeEventListener("mousemove", onDocMove);
  document.removeEventListener("mouseup", onDocUp);
  bar.removeEventListener("mousedown", onBarDown);
  try { term.dispose(); } catch (e) {}
  win.remove();
}
var waitResolve = null;
var wait = new Promise(function (r) { waitResolve = r; });
function closeIt() { cleanup(); waitResolve(); }
closeBtn.onclick = closeIt;
term.write("jtsh floating session — own cwd and env, shared filesystem" + NL);
prompt();
term.focus();
try {
  await wait;
} finally {
  cleanup();   // shell Ctrl+C also tears the terminal down
}
return 0;
