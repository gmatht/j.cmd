// watch v2 — run a command repeatedly and refresh the display.
// v2: as a background job (&), renders into the job's panel slice (shell.outputTarget).
//   watch ls /home          every 2s (default)
//   watch -n 5 date         every 5s (any positive number, e.g. 0.5)
//   watch -h                help
// Stops on Ctrl+C (or when the watched command exits with -e? no —
// it keeps going, like real watch).
var NL = String.fromCharCode(10);
var ESC = String.fromCharCode(27);
var isBrowser = typeof document !== "undefined";

if (args[0] === "-h" || args[0] === "--help") {
  console.log("watch — run a command repeatedly and refresh the display");
  console.log("  watch [-n SECONDS] <command> [args...]");
  console.log("  Ctrl+C stops it");
  return 0;
}
var interval = 2;
var i = 0;
if (args[0] === "-n" || args[0] === "--interval") {
  interval = parseFloat(args[1]);
  if (!(interval > 0)) { console.log("watch: invalid interval '" + args[1] + "'"); return 2; }
  i = 2;
}
var cmd = args.slice(i).join(" ");
if (!cmd) {
  console.log("watch: no command given (watch [-n SECONDS] <command> [args...])");
  return 2;
}
if (typeof shell === "undefined" || typeof shell.runLine !== "function") {
  console.log("watch: this shell has no runLine hook");
  return 1;
}

var panel = null;
var bgTarget = (typeof shell !== "undefined" && shell.outputTarget) || null;
if (isBrowser) {
  if (bgTarget) {
    // Running as a background job — render into the job's panel slice
    // on the right of the display instead of the terminal.
    panel = bgTarget;
    panel.className = "bg-body";
    panel.textContent = "";
  } else {
    // A self-refreshing region right above the prompt line — no scrollback spam.
    panel = document.createElement("div");
    panel.className = "watch-panel";
    panel.style.cssText = "white-space:pre-wrap;word-wrap:break-word;font-family:monospace;font-size:13px;margin:2px 0;";
    var termEl = document.getElementById("terminal");
    var promptLine = document.getElementById("prompt-line");
    termEl.insertBefore(panel, promptLine);
  }
}

// ANSI SGR (color codes) → colored spans, without regex escapes.
var COLORS = {
  "30": "#333333", "31": "#d6a0a0", "32": "#a0d6a0", "33": "#d6d6a0",
  "34": "#7ec8e3", "35": "#d6a0d6", "36": "#a0d6d6", "37": "#e0e0e0",
  "90": "#8b949e", "91": "#d6a0a0", "92": "#a0d6a0", "94": "#7ec8e3",
};
function setPanel(text) {
  panel.textContent = "";
  var i2 = 0, cur = "";
  var add = function (chunk, c) {
    if (!chunk) return;
    var span = document.createElement("span");
    if (c && COLORS[c]) span.style.color = COLORS[c];
    span.textContent = chunk;
    panel.appendChild(span);
  };
  while (true) {
    var j = text.indexOf(ESC, i2);
    if (j === -1) { add(text.slice(i2), cur); break; }
    add(text.slice(i2, j), cur);
    if (text[j + 1] === "[") {
      var k = j + 2;
      while (k < text.length && text[k] !== "m" && !/[A-Za-z]/.test(text[k])) k++;
      if (text[k] === "m") {
        var params = text.slice(j + 2, k);
        cur = params === "" || params === "0" ? "" : params;
        i2 = k + 1;
      } else { i2 = j + 2; }
    } else { i2 = j + 1; }
  }
}

var done = false;
var timer = null;
var waitResolve = null;
var wait = new Promise(function (r) { waitResolve = r; });

// Ctrl+C (shell interrupt) tears the panel down — the shell's
// runInterruptible abandons rather than rejects the command promise, so
// onInterrupt is how long-running commands learn about SIGINT.
if (shell.onInterrupt) shell.onInterrupt(cleanup);

function cleanup() {
  if (done) return;
  done = true;
  if (timer) clearTimeout(timer);
  if (panel) {
    if (bgTarget) {
      panel.textContent = "";      // leave the slice to the panel UI
      if (panel.style) panel.style.cssText = "";
    } else if (panel.parentNode) {
      panel.parentNode.removeChild(panel);
    }
  }
  if (waitResolve) waitResolve();
}

async function tick() {
  var stamp = new Date().toLocaleTimeString();
  var header = "Every " + interval.toFixed(1) + "s: " + cmd + NL + "[" + stamp + "]" + NL;
  var res;
  try {
    res = await shell.runLine(cmd);
  } catch (e) {
    res = { out: "", err: "watch: " + (e && e.message ? e.message : String(e)), code: 1 };
  }
  if (done) return;
  var body = (res && res.out ? res.out : "") + (res && res.err ? res.err : "");
  if (isBrowser) {
    setPanel(header + body);
  } else {
    process.stdout.write(ESC + "[2J" + ESC + "[H" + header + body);
  }
  if (!done) timer = setTimeout(tick, interval * 1000);
}

timer = setTimeout(tick, 0);
try {
  await wait;
} finally {
  cleanup();   // Ctrl+C (shell interrupt) tears the panel down
}
return 0;
