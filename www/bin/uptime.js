// uptime v1 — how long the shell has been running
//
// NAME
//      uptime — how long the shell has been running
//
// SYNOPSIS
//      uptime
//
// DESCRIPTION
//      Prints the current time, how long the shell has been up
//      (since the page loaded in the browser, or since the process
//      started in the CLI), the current user, and a load average.
//      The load average is not tracked, so it reads 0.00.
//
// EXAMPLES
//      uptime

var NL = String.fromCharCode(10);

var uptimeSec = 0;
if (typeof performance !== "undefined" && performance.timeOrigin) {
  uptimeSec = (Date.now() - performance.timeOrigin) / 1000;
} else if (typeof process !== "undefined" && typeof process.uptime === "function") {
  uptimeSec = process.uptime();
}

function pad(n) { return n < 10 ? "0" + n : String(n); }

function fmtUptime(sec) {
  var s = Math.max(0, Math.floor(sec));
  var d = Math.floor(s / 86400);
  var h = Math.floor((s % 86400) / 3600);
  var m = Math.floor((s % 3600) / 60);
  if (d > 0) return d + " day" + (d === 1 ? "" : "s") + ", " + h + ":" + pad(m);
  if (h > 0) return h + ":" + pad(m);
  return m + " min";
}

var now = new Date();
var clock = pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds());
console.log(" " + clock + " up " + fmtUptime(uptimeSec) +
  ", 1 user, load average: 0.00, 0.00, 0.00");
console.log("(load average is not tracked by this shell)");
return 0;
