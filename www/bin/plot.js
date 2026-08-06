// plot v1 — ASCII line charts in the terminal
//
// NAME
//      plot — draw an ASCII line chart from data or an expression
//
// SYNOPSIS
//      plot [options] [file|-]
//      plot -e EXPR [-xmin A] [-xmax B]
//
// DESCRIPTION
//      With a file (or piped stdin), each line is split on whitespace:
//      the first column is x, the rest are series (up to 3). A single
//      column plots y against its index. With -e EXPR, plots the
//      expression over [xmin,xmax] (default 0..2π); common math
//      functions (sin cos tan exp log sqrt abs floor ceil pi) work.
//
// OPTIONS
//      -w N        width in columns (default 72)
//      -h N        height in rows (default 16)
//      -t TEXT     title
//      -e EXPR     plot y = EXPR as a function of x
//      -xmin/-xmax/-ymin/-ymax   axis limits (auto by default)
//
// EXAMPLES
//      plot -e "sin(x)" -xmax 6.283
//      cat data.txt | plot -w 60 -t "sensor 1"
//      plot /home/temps.dat -w 80 -h 20

var width = 72, height = 16, title = null;
var expr = null, xmin = null, xmax = null, ymin = null, ymax = null;
var file = null;
var i = 0;
while (i < args.length) {
  var a = args[i];
  if (a === "-w") { width = parseInt(args[++i], 10) || 72; }
  else if (a === "-h") { height = parseInt(args[++i], 10) || 16; }
  else if (a === "-t") { title = args[++i]; }
  else if (a === "-e") { expr = args[++i]; }
  else if (a === "-xmin") { xmin = parseFloat(args[++i]); }
  else if (a === "-xmax") { xmax = parseFloat(args[++i]); }
  else if (a === "-ymin") { ymin = parseFloat(args[++i]); }
  else if (a === "-ymax") { ymax = parseFloat(args[++i]); }
  else if (a === "-h" || a === "--help") {
    console.log("plot — ASCII line charts");
    console.log("usage: plot [file|-] · plot -e EXPR · cat data | plot");
    console.log("options: -w N -h N -t title -e EXPR -xmin/-xmax/-ymin/-ymax");
    console.log("example: plot -e 'sin(x)' -xmax 6.283 · cat data.txt | plot");
    return 0;
  }
  else if (a.charAt(0) === "-" && a.length > 1) {
    console.log("plot: unknown option '" + a + "'");
    return 2;
  }
  else if (file === null) { file = a; }
  i++;
}

// ─── gather data points ───
var data = null;
if (expr !== null) {
  // allow sin(x) / cos(x) / pi without Math. prefix
  var pre = expr.replace(/\b(sin|cos|tan|asin|acos|atan|exp|log|sqrt|abs|floor|ceil|round|pow|min|max|PI|E)\b/g,
    function (m) { return m === "PI" ? "Math.PI" : m === "E" ? "Math.E" : "Math." + m; });
  var fn;
  try { fn = new Function("x", "return (" + pre + ")"); }
  catch (e) { console.log("plot: bad expression: " + e.message); return 2; }
  var lo = (xmin === null ? 0 : xmin), hi = (xmax === null ? 2 * Math.PI : xmax);
  if (hi <= lo) { console.log("plot: xmax must be > xmin"); return 2; }
  var n = Math.min(width * 3, 400);
  data = [];
  for (var k = 0; k <= n; k++) {
    var x = lo + (hi - lo) * k / n;
    var y;
    try { y = fn(x); } catch (e) { y = NaN; }
    if (typeof y === "number" && isFinite(y)) data.push([x, y]);
  }
} else {
  var raw = file !== null ? await fs.read(file) : stdin;
  if (!raw || !raw.trim()) { console.log("plot: no data (give a file, pipe stdin, or -e EXPR)"); return 2; }
  data = [];
  var lines = raw.split("\n");
  for (var li = 0; li < lines.length; li++) {
    var t = lines[li].trim();
    if (!t || t.charAt(0) === "#") continue;
    var cols = t.split(/[\s,;]+/).map(parseFloat);
    if (cols.some(function (v) { return isNaN(v); })) continue;
    if (cols.length === 1) data.push([data.length, cols[0]]);
    else data.push(cols);
  }
  if (data.length === 0) { console.log("plot: no numeric data found"); return 2; }
}

// ─── axis limits ───
var xs = data.map(function (r) { return r[0]; });
var nSeries = Math.min(3, Math.max(1, data[0].length - 1));
var ysAll = [];
for (var s = 0; s < nSeries; s++) for (var q = 0; q < data.length; q++) ysAll.push(data[q][s + 1]);
if (xmin === null) xmin = Math.min.apply(null, xs);
if (xmax === null) xmax = Math.max.apply(null, xs);
if (ymin === null) ymin = Math.min.apply(null, ysAll);
if (ymax === null) ymax = Math.max.apply(null, ysAll);
if (xmax === xmin) xmax = xmin + 1;
if (ymax === ymin) ymax = ymin + 1;

// ─── render ───
var glyphs = ["*", "+", "o"];
var rows = [];
for (var r = 0; r < height; r++) {
  var row = [];
  for (var c = 0; c < width; c++) row.push(" ");
  rows.push(row);
}
var px = function (x) { return Math.round((x - xmin) / (xmax - xmin) * (width - 1)); };
var py = function (y) { return Math.round((ymax - y) / (ymax - ymin) * (height - 1)); };
// axes
if (ymin <= 0 && ymax >= 0) { var zr = py(0); for (var c2 = 0; c2 < width; c2++) if (rows[zr][c2] === " ") rows[zr][c2] = "-"; }
if (xmin <= 0 && xmax >= 0) { var zc = px(0); for (var r2 = 0; r2 < height; r2++) if (rows[r2][zc] === " " || rows[r2][zc] === "-") rows[r2][zc] = "|"; }
// points
for (var s2 = 0; s2 < nSeries; s2++) {
  var g = glyphs[s2];
  for (var p = 0; p < data.length; p++) {
    var X = px(data[p][0]);
    var Y = py(data[p][1 + s2]);
    if (X < 0 || X >= width || Y < 0 || Y >= height) continue;
    if (rows[Y][X] === " " || rows[Y][X] === "-") rows[Y][X] = g;
  }
}
// axes labels
var xL = "" + (Math.round(xmin * 100) / 100), xR = "" + (Math.round(xmax * 100) / 100);
var yT = "" + (Math.round(ymax * 100) / 100), yB = "" + (Math.round(ymin * 100) / 100);
rows[0][0] = yT.charAt(0);
rows[height - 1][0] = yB.charAt(0);
rows[height - 1][width - xL.length] = " ";
// print
if (title) console.log(title);
console.log("^".padEnd ? "" : "");
for (var rr = 0; rr < height; rr++) console.log(rows[rr].join("").replace(/\s+$/, ""));
console.log("0" + " ".repeat(Math.max(0, width - 3)) + xL + " " + xR);
return 0;
