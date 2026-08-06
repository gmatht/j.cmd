// cmatrix v1 — Matrix-style digital rain
//
// NAME
//      cmatrix — Matrix-style digital rain
//
// SYNOPSIS
//      cmatrix
//
// DESCRIPTION
//      In the browser, green katakana rain falls down the screen
//      (canvas-based, like the classic cmatrix); press any key, click,
//      or wait ~15s to leave. In the Node CLI a static rain frame is
//      printed.
//
// EXAMPLES
//      cmatrix

var RAIN_CHARS = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789";

// ─── CLI: a static frame of the rain ───
if (typeof document === "undefined" || typeof document.createElement !== "function") {
  for (var r = 0; r < 10; r++) {
    var line = "";
    for (var c = 0; c < 70; c++) {
      line += Math.random() < 0.35
        ? RAIN_CHARS.charAt(Math.floor(Math.random() * RAIN_CHARS.length))
        : " ";
    }
    console.log(line);
  }
  console.log("(the rain animation needs a browser — run cmatrix in the web shell)");
  return 0;
}

// ─── browser: canvas rain ───
var canvas = document.createElement("canvas");
canvas.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;z-index:50;background:#000;";
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;
document.body.appendChild(canvas);
var ctx = canvas.getContext("2d");
var FONT_PX = 16;
var cols = Math.floor(canvas.width / FONT_PX);
var drops = [];
for (var d = 0; d < cols; d++) drops[d] = Math.floor(Math.random() * -30);

function frame() {
  ctx.fillStyle = "rgba(0,0,0,0.08)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#0f0";
  ctx.font = "bold " + FONT_PX + "px monospace";
  for (var c = 0; c < cols; c++) {
    var ch = RAIN_CHARS.charAt(Math.floor(Math.random() * RAIN_CHARS.length));
    ctx.fillText(ch, c * FONT_PX, drops[c] * FONT_PX);
    if (drops[c] * FONT_PX > canvas.height && Math.random() > 0.975) drops[c] = 0;
    drops[c]++;
  }
}
frame();
var timer = setInterval(frame, 50);
var label = document.createElement("div");
label.textContent = "cmatrix — wake up, Neo... (any key or click to leave)";
label.style.cssText = "position:absolute;bottom:24px;left:50%;transform:translateX(-50%);color:#0f0;font:12px monospace;z-index:51;";
document.body.appendChild(label);

var resolve;
var wait = new Promise(function (r) { resolve = r; });
var finished = false;
function done() {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  document.removeEventListener("keydown", keyHandler, true);
  if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  if (label.parentNode) label.parentNode.removeChild(label);
  resolve();
}
function keyHandler(e) { done(); }
document.addEventListener("keydown", keyHandler, true);
canvas.addEventListener("click", done);
var autoStop = setTimeout(done, 15000);

await wait;
clearTimeout(autoStop);
return 0;
