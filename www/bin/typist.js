// typist v1 — typing speed and accuracy practice
//
// NAME
//      typist — typing speed and accuracy practice
//
// SYNOPSIS
//      typist          interactive typing test (browser)
//      typist demo     self-running demo (works in the CLI too)
//
// DESCRIPTION
//      Shows a passage; type it character by character. Wrong keys
//      are counted (accuracy), Backspace rewinds, Enter/Esc ends
//      early. Live WPM and accuracy on finish. In the CLI there is
//      no key capture, so `typist demo` types the passage itself.

var NL = String.fromCharCode(10);
var isBrowser = typeof document !== "undefined";

var PASSAGES = [
  "the quick brown fox jumps over the lazy dog while the amber sunset fades into a quiet evening sky",
  "in the beginning was the command line, a simple prompt where thoughts become programs and programs become worlds",
  "type slowly and deliberately at first, then let your fingers find the rhythm as speed follows accuracy",
  "the shell is a place where the virtual and the real meet, where files flow like water through pipes",
  "practice makes permanent, so type with intention and let every keystroke teach your hands the way",
];

if (args[0] === "-h" || args[0] === "--help") {
  console.log("typist — typing speed and accuracy practice");
  console.log("  typist          interactive typing test (browser)");
  console.log("  typist demo     self-running demo");
  console.log("  Backspace rewinds · Enter/Esc ends early");
  return 0;
}

var demo = args[0] === "demo";
var text = PASSAGES[Math.floor(Math.random() * PASSAGES.length)];
var pos = 0, errors = 0, start = Date.now(), done = false;
var panel = null;

function stats() {
  var secs = (Date.now() - start) / 1000;
  var wpm = Math.round((pos / 5) / Math.max(secs / 60, 0.001));
  var acc = pos + errors === 0 ? 0 : Math.round(100 * pos / (pos + errors));
  return "wpm " + wpm + " · accuracy " + acc + "% · " + pos + " chars in " + secs.toFixed(1) + "s";
}

function finish() {
  if (done) return;
  done = true;
  if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
  console.log("");
  console.log("✓ " + stats());
  if (resolver) resolver();
}

var resolver = null;

if (!isBrowser || demo) {
  // CLI / demo: type the passage ourselves so it works anywhere.
  console.log(text);
  for (var k = 0; k < text.length; k++) {
    process.stdout.write(text[k]);
    pos = k + 1;
    await new Promise(function (r) { setTimeout(r, demo ? 40 : 25); });
  }
  console.log("");
  console.log("✓ " + stats());
  return 0;
}

// ─── browser: interactive typing test ───
var term = document.getElementById("terminal");
var promptLine = document.getElementById("prompt-line");
panel = document.createElement("div");
panel.style.cssText = "white-space:pre-wrap;word-wrap:break-word;font-family:monospace;font-size:14px;margin:2px 0;color:#a0d6a0;";
term.insertBefore(panel, promptLine);
console.log("Type the passage — wrong keys count against accuracy. Backspace rewinds, Enter/Esc ends.");
console.log("");

function render() {
  panel.textContent = text.slice(0, pos) + (pos < text.length ? "▎" + text.slice(pos) : "");
}
render();

// Register the key handler BEFORE awaiting — the command stays alive
// until the user finishes (Enter/Esc/Ctrl+C), then stats are printed.
if (typeof shell !== "undefined" && typeof shell.onKey === "function") {
  shell.onKey(function (key) {
    if (done) return false;
    if (key === "Enter" || key === "Escape") { finish(); return true; }
    if (key === "Backspace") { if (pos > 0) pos--; render(); return true; }
    if (key.length === 1) {
      if (key === text[pos]) pos++; else errors++;
      render();
      if (pos >= text.length) finish();
      return true;
    }
    return false;
  });
}
if (typeof shell !== "undefined" && typeof shell.onInterrupt === "function") {
  shell.onInterrupt(function () { finish(); });
}
await new Promise(function (resolve) { resolver = resolve; });
return 0;
