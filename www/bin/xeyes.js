// xeyes v2 — the classic X11 eyes that follow the cursor (browser edition).
//   xeyes          show the eyes; close with any key, a click, or Ctrl+C
if (typeof document === "undefined") {
  console.log("xeyes: needs a browser (run in the web shell)");
  return 1;
}
var overlay = document.createElement("div");
overlay.className = "xeyes-overlay";
overlay.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;z-index:40;pointer-events:none;";
var eyes = [];
for (var e = 0; e < 2; e++) {
  var eye = document.createElement("div");
  eye.className = "xeyes-eye";
  eye.style.cssText = "position:absolute;top:24px;width:130px;height:86px;background:#fff;border:3px solid #1a1a2e;border-radius:50%;overflow:hidden;";
  eye.style.left = e === 0 ? "calc(50% - 150px)" : "calc(50% + 20px)";
  var pupil = document.createElement("div");
  pupil.className = "xeyes-pupil";
  pupil.style.cssText = "position:absolute;width:46px;height:46px;background:#1a1a2e;border-radius:50%;left:42px;top:20px;";
  eye.appendChild(pupil);
  overlay.appendChild(eye);
  eyes.push({ eye: eye, pupil: pupil });
}
var label = document.createElement("div");
label.textContent = "xeyes — press any key or Ctrl+C to close";
label.style.cssText = "position:absolute;top:130px;left:50%;transform:translateX(-50%);color:#8b949e;font:12px monospace;";
overlay.appendChild(label);
document.body.appendChild(overlay);

var mx = window.innerWidth / 2, my = 100;
function onMove(e) {
  mx = e.clientX;
  my = e.clientY;
  for (var i = 0; i < eyes.length; i++) {
    var ex = eyes[i];
    var r = ex.eye.getBoundingClientRect();
    var cx = r.left + r.width / 2;
    var cy = r.top + r.height / 2;
    var dx = mx - cx;
    var dy = my - cy;
    var dist = Math.max(1, Math.hypot(dx, dy));
    ex.pupil.style.left = (42 + (dx / dist) * 18) + "px";
    ex.pupil.style.top = (20 + (dy / dist) * 18) + "px";
  }
}
document.addEventListener("mousemove", onMove);
onMove({ clientX: mx, clientY: my });

var blinkTimer = setInterval(function () {
  for (var i = 0; i < eyes.length; i++) {
    eyes[i].pupil.style.height = "5px";
    eyes[i].pupil.style.top = "41px";
  }
  setTimeout(function () {
    for (var i = 0; i < eyes.length; i++) {
      eyes[i].pupil.style.height = "46px";
      eyes[i].pupil.style.top = "20px";
    }
  }, 120);
}, 3200);

// v2: ignore any key delivered by the launch gesture itself (Edge can
// report the Enter that started us differently), so the eyes don't
// self-close the instant they appear.
var launchGuard = Date.now() + 400;
var done = false;
function cleanup() {
  if (done) return;
  done = true;
  clearInterval(blinkTimer);
  document.removeEventListener("mousemove", onMove);
  document.removeEventListener("keydown", onKey);
  overlay.remove();
}
var waitResolve = null;
var wait = new Promise(function (r) { waitResolve = r; });
function onKey() {
  if (Date.now() < launchGuard) return;  // launch gesture — don't self-close
  cleanup();
  waitResolve();
}
document.addEventListener("keydown", onKey);
try {
  await wait;
} finally {
  cleanup();   // Ctrl+C (shell interrupt) also tears the eyes down
}
return 0;
