// screen v2 — tmux/screen-style panes for jtsh (browser)
//
// NAME
//      screen — split the terminal into panes (like tmux / GNU screen)
//
// SYNOPSIS
//      screen [-n N] [-S name]
//
// DESCRIPTION
//      screen takes over the terminal with a tmux-style pane layout.
//      Each pane is its own mini-shell: its own working directory, its
//      own output area and its own input line. Commands run in a pane
//      exactly as they would in the main shell (builtins, .js command
//      files, wasm binaries), but their output stays inside the pane.
//
//      Browser keyboards make tmux hotkeys unreliable, so every action
//      is a button:
//        [+]     add a pane (split)
//        [x]     close the pane
//        [C]     clear the pane's output
//        [=]     reset to a single pane
//        [q]     leave screen mode (Esc works too)
//      Click a pane to focus it; Enter or the Run button runs its
//      line. Ctrl+C in a pane input clears the line (a running command
//      finishes in the background, like the main shell's interrupt).
//      Commands run one at a time across panes (the shell is single
//      threaded), and a command that cd's changes only its own pane.
//
//      Full-screen commands (edit, vi, play, browse, the python REPL)
//      are refused in panes; use the main shell for those.
//
// OPTIONS
//      -n, --panes=N     start with N panes (default 1, max 16)
//      -S, --session=N   session name shown in the toolbar (default jtsh)
//      -h, --help        show this help
//
// EXAMPLES
//      screen               one pane, split it with the + button
//      screen -n 4          2x2 grid of panes
//      screen 4             same as -n 4 (positional count)
//      screen -S work -n 2  session named work with two panes
//
// SEE ALSO
//      arecord, play

// ─── parse options ───
var NL = String.fromCharCode(10);
var sessionName = "jtsh";
var paneCount = 1;
var i = 0;
var posCount = null;
while (i < args.length) {
  var a = args[i];
  var opt = a;
  var inline = null;
  var eq = a.indexOf("=");
  if (a.length > 1 && a.charAt(0) === "-" && eq !== -1) {
    opt = a.slice(0, eq);
    inline = a.slice(eq + 1);
  }
  var val;
  if (opt === "-h" || opt === "--help") {
    console.log("screen — tmux-style panes for jtsh (browser)");
    console.log("usage: screen [-n N] [-S name]");
    console.log("");
    console.log("  -n, --panes=N    start with N panes (default 1, max 16)");
    console.log("  -S, --session=N  session name (default jtsh)");
    console.log("  -h, --help       this help");
    console.log("");
    console.log("buttons: + split · x close · C clear · = reset · q/Esc exit");
    console.log("(browser keyboards make hotkeys unreliable, so everything is a button)");
    return 0;
  }
  if (opt === "-n" || opt === "--panes") {
    val = inline !== null ? inline : args[++i];
    if (val === undefined) { console.log("screen: option " + opt + " needs an argument"); return 2; }
    posCount = parseInt(val, 10);
    if (!isFinite(posCount) || posCount < 1) {
      console.log("screen: invalid pane count '" + val + "'");
      return 2;
    }
    i++;
    continue;
  }
  if (opt === "-S" || opt === "--session") {
    val = inline !== null ? inline : args[++i];
    if (val === undefined) { console.log("screen: option " + opt + " needs an argument"); return 2; }
    sessionName = val;
    i++;
    continue;
  }
  if (a.charAt(0) === "-" && a.length > 1) {
    console.log("screen: unrecognized option '" + a + "'");
    console.log("usage: screen [-n N] [-S name]  (try: screen -h)");
    return 2;
  }
  // positional argument: a pane count (screen 4 == screen -n 4)
  if (posCount === null) {
    posCount = parseInt(a, 10);
    if (!isFinite(posCount) || posCount < 1) {
      console.log("screen: invalid pane count '" + a + "'");
      return 2;
    }
  }
  i++;
}
if (posCount !== null) paneCount = posCount;
if (paneCount > 16) {
  console.log("screen: too many panes (max 16)");
  return 2;
}

// ─── environment check ───
if (typeof document === "undefined" || typeof window === "undefined" ||
    typeof window.shellPaneRun !== "function") {
  console.log("screen: needs the browser shell (www/index.html) with pane support");
  console.log("(the Node CLI has no terminal to split; run this in the browser)");
  return 1;
}

// ─── UI helpers ────────────────────────────────────────────────

function mkButton(label, tip, fn) {
  var b = document.createElement("button");
  b.className = "screen-btn";
  b.textContent = label;
  b.title = tip || "";
  b.addEventListener("click", function () {
    fn();
    if (focused) focused.input.focus();
  });
  return b;
}

function stripAnsi(s) {
  var out = "";
  var i = 0;
  while (i < s.length) {
    if (s.charCodeAt(i) === 27) {
      i++;
      if (i < s.length && s.charAt(i) === "[") {
        i++;
        while (i < s.length) {
          var b = s.charAt(i);
          if (b >= "@" && b <= "~") break;
          i++;
        }
        i++;
      }
    } else {
      out += s.charAt(i);
      i++;
    }
  }
  return out;
}

// ─── state ───
var root = null;
var grid = null;
var status = null;
var styleEl = null;
var panes = [];
var focused = null;
var cmdCount = 0;
var queue = Promise.resolve();
var exitResolve = null;
var exiting = false;
var input = document.getElementById("hidden-input");
var statusHint = document.getElementById("status-hint");
var hadDisabled = input ? input.disabled : false;
var prevHint = statusHint ? statusHint.textContent : "";

var GUI_CMDS = ["edit", "vi", "vim", "play", "browse", "mail"];

function guardLine(text) {
  var first = String(text).trim().split(" ")[0];
  if (first === "screen") return "screen is already running — press q to leave, then run it again";
  if (first === "python" && text.trim() === "python") {
    return "the python REPL can't run in a pane — use python -c with inline code instead";
  }
  if (GUI_CMDS.indexOf(first) !== -1) {
    return first + " is a full-screen browser command — it can't run inside a pane";
  }
  return null;
}

// ─── pane helpers ──────────────────────────────────────────────

function paneAppend(pane, text, isErr) {
  var clean = stripAnsi(String(text));
  if (!clean) return;
  var span = document.createElement("span");
  span.className = isErr ? "err" : "out";
  span.textContent = clean;
  pane.out.appendChild(span);
  while (pane.out.childNodes.length > 600) pane.out.removeChild(pane.out.firstChild);
  pane.out.scrollTop = pane.out.scrollHeight;
}

function banner(pane, text) {
  var span = document.createElement("span");
  span.className = "out";
  span.style.color = "#8b949e";
  span.textContent = "[screen] " + text + NL;
  pane.out.appendChild(span);
  pane.out.scrollTop = pane.out.scrollHeight;
}

function panePrompt(pane) {
  var dir = pane.cwd === "/" ? "/" : pane.cwd;
  pane.prompt.textContent = pane.idx + ":" + dir + "$ ";
  pane.title.textContent = "pane " + pane.idx + " · " + dir + (pane.busy ? " (busy)" : "");
}

function focusPane(pane) {
  if (focused && focused !== pane) focused.el.classList.remove("focused");
  focused = pane;
  pane.el.classList.add("focused");
  pane.input.focus();
}

function relayout() {
  var n = panes.length;
  if (n === 0) {
    grid.style.gridTemplateColumns = "1fr";
    grid.style.gridTemplateRows = "1fr";
    return;
  }
  var cols = 1;
  while (cols * cols < n) cols++;
  var rows = Math.ceil(n / cols);
  grid.style.gridTemplateColumns = "repeat(" + cols + ", 1fr)";
  grid.style.gridTemplateRows = "repeat(" + rows + ", 1fr)";
}

function updateStatus() {
  var busy = 0;
  for (var k = 0; k < panes.length; k++) if (panes[k].busy) busy++;
  status.textContent = "session " + sessionName + " · " + panes.length +
    " pane(s) · " + cmdCount + " command(s)" +
    (busy ? " · " + busy + " running" : "") +
    " · click a pane to focus · q/Esc exits";
}

function runLine(pane, raw) {
  var text = String(raw || "").trim();
  if (!text) return;
  var g = guardLine(text);
  if (g) {
    paneAppend(pane, g + NL, true);
    return;
  }
  paneAppend(pane, pane.prompt.textContent + text + NL);
  pane.input.value = "";
  pane.busy = true;
  pane.runBtn.disabled = true;
  pane.input.disabled = true;
  panePrompt(pane);
  cmdCount++;
  var p = queue.then(function () {
    return window.shellPaneRun(text, {
      cwd: pane.cwd,
      out: function (chunk) { paneAppend(pane, chunk, false); },
      err: function (chunk) { paneAppend(pane, chunk, true); },
    }).then(function (res) {
      if (res && res.cwd) pane.cwd = res.cwd;
      pane.busy = false;
      pane.runBtn.disabled = false;
      pane.input.disabled = false;
      panePrompt(pane);
      updateStatus();
      if (focused === pane) pane.input.focus();
    });
  });
  queue = p.catch(function () {});
  updateStatus();
}

function addPane(cwd, focusIt) {
  var idx = panes.length;
  var el = document.createElement("div");
  el.className = "screen-pane";
  var head = document.createElement("div");
  head.className = "screen-pane-head";
  var title = document.createElement("span");
  title.className = "screen-pane-title";
  var btnClear = mkButton("C", "clear this pane's output", function () { pane.out.textContent = ""; });
  var btnClose = mkButton("x", "close this pane", function () { removePane(pane); });
  btnClose.className += " screen-btn-close";
  head.appendChild(title);
  head.appendChild(btnClear);
  head.appendChild(btnClose);
  var out = document.createElement("div");
  out.className = "screen-pane-out";
  var row = document.createElement("div");
  row.className = "screen-pane-inputrow";
  var prompt = document.createElement("span");
  prompt.className = "screen-pane-prompt";
  var inp = document.createElement("input");
  inp.className = "screen-pane-input";
  inp.type = "text";
  inp.autocomplete = "off";
  inp.spellcheck = false;
  inp.placeholder = "type a command, Enter or Run";
  var runBtn = mkButton("Run", "run this line in the pane", function () { runLine(pane, inp.value); });
  row.appendChild(prompt);
  row.appendChild(inp);
  row.appendChild(runBtn);
  el.appendChild(head);
  el.appendChild(out);
  el.appendChild(row);
  var pane = {
    idx: idx, el: el, title: title, out: out,
    input: inp, prompt: prompt, runBtn: runBtn,
    cwd: cwd || fs.cwd, busy: false,
  };
  panePrompt(pane);
  el.addEventListener("click", function () { focusPane(pane); });
  inp.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      runLine(pane, inp.value);
    } else if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
      e.preventDefault();
      paneAppend(pane, "^C" + NL, false);
      inp.value = "";
    } else if (e.key === "Escape") {
      e.preventDefault();
      exitScreen();
    }
  });
  panes.push(pane);
  grid.appendChild(el);
  relayout();
  banner(pane, "pane " + idx + " ready — + split · x close · C clear · q/Esc exits");
  if (focusIt) focusPane(pane);
  updateStatus();
  return pane;
}

function removePane(pane) {
  var idx = panes.indexOf(pane);
  if (idx === -1) return;
  panes.splice(idx, 1);
  if (focused === pane) focused = null;
  if (pane.el.parentNode) pane.el.parentNode.removeChild(pane.el);
  for (var k = 0; k < panes.length; k++) {
    panes[k].idx = k;
    panePrompt(panes[k]);
  }
  relayout();
  updateStatus();
  if (panes.length === 0) {
    exitScreen();
  } else if (!focused) {
    focusPane(panes[panes.length - 1]);
  }
}

function resetPanes() {
  var keepCwd = focused ? focused.cwd : (panes.length ? panes[0].cwd : fs.cwd);
  while (panes.length) {
    var p = panes.pop();
    if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
  }
  focused = null;
  addPane(keepCwd, true);
}

// ─── lifecycle ─────────────────────────────────────────────────

function cleanup() {
  if (root && root.parentNode) root.parentNode.removeChild(root);
  if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
  if (input) input.disabled = hadDisabled;
  if (statusHint) statusHint.textContent = prevHint;
  root = null;
  panes = [];
  focused = null;
}

function exitScreen() {
  if (exiting) return;
  exiting = true;
  if (statusHint) statusHint.textContent = "screen: waiting for pane commands to finish...";
  queue.catch(function () {}).then(function () {
    cleanup();
    if (exitResolve) exitResolve(0);
  });
}

// ─── CSS ───────────────────────────────────────────────────────

var css = ".screen-root{position:fixed;top:0;left:0;right:0;bottom:48px;z-index:12;background:#0d1117;color:#e0e0e0;display:flex;flex-direction:column;font-family:'Cascadia Code','Fira Code','JetBrains Mono',monospace;}" +
  ".screen-toolbar{display:flex;align-items:center;gap:6px;padding:6px 10px;background:#161b22;border-bottom:1px solid #30363d;font-size:12px;color:#8b949e;}" +
  ".screen-title{font-weight:bold;color:#7ec8e3;}" +
  ".screen-btn{background:#21262d;color:#e0e0e0;border:1px solid #30363d;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:12px;}" +
  ".screen-btn:hover{background:#30363d;}" +
  ".screen-btn-close{background:#3d2222;border-color:#5a2e2e;padding:3px 8px;}" +
  ".screen-btn-exit{background:#1f6feb;border-color:#1f6feb;color:#fff;font-weight:bold;}" +
  ".screen-spacer{flex:1;}" +
  ".screen-grid{flex:1;display:grid;gap:6px;padding:8px;overflow:hidden;}" +
  ".screen-pane{display:flex;flex-direction:column;background:#0d1117;border:1px solid #30363d;border-radius:6px;overflow:hidden;min-height:0;min-width:0;}" +
  ".screen-pane.focused{border-color:#7ec8e3;box-shadow:0 0 0 1px #7ec8e3;}" +
  ".screen-pane-head{display:flex;align-items:center;gap:6px;padding:3px 8px;background:#161b22;border-bottom:1px solid #30363d;font-size:11px;color:#8b949e;}" +
  ".screen-pane-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
  ".screen-pane-out{flex:1;overflow:auto;padding:6px 8px;font-size:13px;line-height:1.35;white-space:pre-wrap;word-break:break-word;min-height:0;}" +
  ".screen-pane-out .err{color:#d6a0a0;}" +
  ".screen-pane-inputrow{display:flex;align-items:center;gap:6px;padding:4px 8px;background:#161b22;border-top:1px solid #30363d;}" +
  ".screen-pane-prompt{color:#a0d6a0;font-size:13px;white-space:nowrap;}" +
  ".screen-pane-input{flex:1;background:#0d1117;color:#e0e0e0;border:1px solid #30363d;border-radius:4px;padding:3px 6px;font:inherit;font-size:13px;outline:none;}" +
  ".screen-pane-input:focus{border-color:#7ec8e3;}" +
  ".screen-pane-input:disabled{opacity:.55;}" +
  ".screen-status{display:flex;gap:16px;padding:4px 10px;background:#161b22;border-top:1px solid #30363d;font-size:11px;color:#8b949e;}";

styleEl = document.createElement("style");
styleEl.textContent = css;
document.head.appendChild(styleEl);

// ─── build the screen UI ───────────────────────────────────────

root = document.createElement("div");
root.className = "screen-root";
root.tabIndex = -1;

var toolbar = document.createElement("div");
toolbar.className = "screen-toolbar";
var title = document.createElement("span");
title.className = "screen-title";
title.textContent = "screen: " + sessionName;
toolbar.appendChild(title);
toolbar.appendChild(mkButton("+ split", "add a pane (tmux split-window)", function () {
  addPane(focused ? focused.cwd : fs.cwd, true);
}));
toolbar.appendChild(mkButton("= reset", "collapse to a single pane", function () { resetPanes(); }));
var spacer = document.createElement("span");
spacer.className = "screen-spacer";
toolbar.appendChild(spacer);
var btnExit = mkButton("q exit", "leave screen mode", function () { exitScreen(); });
btnExit.className += " screen-btn-exit";
toolbar.appendChild(btnExit);
root.appendChild(toolbar);

grid = document.createElement("div");
grid.className = "screen-grid";
root.appendChild(grid);

status = document.createElement("div");
status.className = "screen-status";
root.appendChild(status);

root.addEventListener("keydown", function (e) {
  if (e.key === "Escape") {
    e.preventDefault();
    exitScreen();
  }
});
root.addEventListener("click", function (e) {
  if (!e.target.closest(".screen-pane") && focused) focused.input.focus();
});

if (input) input.disabled = true;
if (statusHint) statusHint.textContent = "screen: " + sessionName + " · click a pane · + split · q/Esc exits";

document.body.appendChild(root);

for (var k = 0; k < paneCount; k++) addPane(fs.cwd, k === 0);

// ─── run until the user leaves ─────────────────────────────────
var exitPromise = new Promise(function (res) { exitResolve = res; });
await exitPromise;
console.log("screen: session '" + sessionName + "' ended — " + cmdCount + " command(s) ran");
return 0;
