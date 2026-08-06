// sl v1 — when you mean ls but type sl, a steam locomotive crosses
// the screen (the classic Unix gag).
//
// NAME
//      sl — steam locomotive (the ls typo)
//
// SYNOPSIS
//      sl
//
// DESCRIPTION
//      In the browser a steam locomotive drives across the screen;
//      press any key, click, or wait for it to pass. In the Node CLI
//      the locomotive is printed statically.
//
// EXAMPLES
//      sl        (next time you mean ls)

var NL = String.fromCharCode(10);
var BS = String.fromCharCode(92);
var TRAIN = [
  "        ====        ________                ___________",
  "  _D _|  |_______/        " + BS + "__I_I_____===__|_________|",
  "   |(_)---  |   H" + BS + "________/ |   |        =|___ ___|      _________________",
  "       /     |  H_|   |     |   |         ||_| |_||     _|                " + BS + "_____A",
  "      |      |  H_|  |     |   |         ||_| |_||    |                        |",
  "      |      |        |   |    |______H|__|_____|__|__________________|_______|__|",
];

if (typeof document === "undefined" || typeof document.createElement !== "function") {
  for (var t = 0; t < TRAIN.length; t++) console.log(TRAIN[t]);
  console.log("(the locomotive can't move in the CLI — try the browser)");
  return 0;
}

// ─── browser: an overlay train crossing the screen ───
var overlay = document.createElement("div");
overlay.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;z-index:50;background:#0d1117;overflow:hidden;";
var train = document.createElement("pre");
train.textContent = TRAIN.join(NL);
train.style.cssText = "position:absolute;top:42%;color:#f0e68c;font:16px monospace;white-space:pre;";
overlay.appendChild(train);
var label = document.createElement("div");
label.textContent = "sl — you meant ls, didn't you? (any key or click to close)";
label.style.cssText = "position:absolute;bottom:24px;left:50%;transform:translateX(-50%);color:#8b949e;font:12px monospace;";
overlay.appendChild(label);
document.body.appendChild(overlay);

var x = window.innerWidth;
var timer = setInterval(function () {
  x -= 14;
  train.style.left = x + "px";
  if (x < -900) done();
}, 20);

var resolve;
var wait = new Promise(function (r) { resolve = r; });
var finished = false;
function done() {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  document.removeEventListener("keydown", keyHandler, true);
  if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  resolve();
}
function keyHandler(e) { done(); }
document.addEventListener("keydown", keyHandler, true);
overlay.addEventListener("click", done);

await wait;
return 0;
