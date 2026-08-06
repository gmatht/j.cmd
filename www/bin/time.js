// time v1 — run a command and report how long it took
//
// NAME
//      time — time a command
//
// SYNOPSIS
//      time [-p] <command> [args...]
//
// DESCRIPTION
//      Runs the given command line through the shell and reports the
//      elapsed wall-clock time (real), plus user/system CPU time in
//      the Node CLI (the command runs in-process, so the process CPU
//      counters cover it). The command's own output is passed through
//      and its exit status becomes time's exit status.
//
// OPTIONS
//      -p, --portable   POSIX-style output (real 0.01 / user 0.00 ...)
//      -h, --help       show this help
//
// EXAMPLES
//      time ls /github
//      time bash -c 'echo hi'
//      time -p sleep 0.5

var NL = String.fromCharCode(10);
var TAB = String.fromCharCode(9);

if (args.length === 0) {
  console.log("time — run a command and report how long it took");
  console.log("usage: time [-p] <command> [args...]");
  console.log("examples: time ls /github · time bash -c 'echo hi' · time -p sleep 0.5");
  return 2;
}
if (args[0] === "-h" || args[0] === "--help") {
  console.log("time — run a command and report how long it took");
  console.log("usage: time [-p] <command> [args...]");
  console.log("");
  console.log("  -p, --portable  POSIX-style output (real 0.01)");
  console.log("  -h, --help      this help");
  console.log("");
  console.log("examples: time ls /github · time bash -c 'echo hi' · time -p sleep 0.5");
  return 0;
}
var portable = args[0] === "-p" || args[0] === "--portable";
if (portable) args = args.slice(1);
if (args.length === 0) {
  console.log("time: no command given");
  return 2;
}
if (typeof shell === "undefined" || typeof shell.runLine !== "function") {
  console.log("time: this shell has no runLine hook (needs the browser shell or jtsh CLI)");
  return 1;
}

var cmd = args.join(" ");
var t0 = Date.now();
var cpu0 = typeof process !== "undefined" && process.cpuUsage ? process.cpuUsage() : null;
var res;
try {
  res = await shell.runLine(cmd);
} catch (e) {
  console.log("time: " + (e && e.message ? e.message : String(e)));
  return 1;
}
var realMs = Date.now() - t0;
var cpu1 = typeof process !== "undefined" && process.cpuUsage && cpu0
  ? process.cpuUsage(cpu0) : null;

// The command's captured output — pass it through (strip trailing
// newlines; console.log adds one).
function emit(s) {
  if (!s) return;
  var t = String(s);
  while (t.charAt(t.length - 1) === NL) t = t.slice(0, t.length - 1);
  if (t) console.log(t);
}
emit(res && res.out);
emit(res && res.err);

function fmt(sec) {
  var m = Math.floor(sec / 60);
  var s = (sec - m * 60).toFixed(3);
  return m + "m" + s + "s";
}
if (portable) {
  console.log("real " + (realMs / 1000).toFixed(2));
  if (cpu1) {
    console.log("user " + (cpu1.user / 1000000).toFixed(2));
    console.log("sys " + (cpu1.system / 1000000).toFixed(2));
  }
} else {
  console.log("real" + TAB + fmt(realMs / 1000));
  if (cpu1) {
    console.log("user" + TAB + fmt(cpu1.user / 1000000));
    console.log("sys" + TAB + fmt(cpu1.system / 1000000));
  }
}
return res && typeof res.code === "number" ? res.code : 0;
