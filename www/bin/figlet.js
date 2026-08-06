// figlet v3 — big ASCII banner text (fonts, style, size)
//
// NAME
//      figlet — big ASCII banner text
//
// SYNOPSIS
//      figlet [-f FONT] [-s ROWS] [-b|-i|-n] <text...>
//      figlet -l | -h
//
// DESCRIPTION
//      figlet renders text as a large ASCII banner. In the browser it
//      draws the text with a real font on a hidden canvas and samples
//      the pixels into the banner (any characters, real font shapes);
//      in the Node CLI it uses the built-in block font. -l lists the
//      fonts, styles and sizes.
//
// OPTIONS
//      -f, --font NAME    blocks | mono | serif | sans | cursive |
//                         fantasy | courier | times | arial | impact
//                         (default: mono in the browser, blocks in CLI)
//      -s, --size ROWS    banner height 3..30 (canvas fonts; default 8)
//      -b, --bold         bold style (canvas fonts)
//      -i, --italic       italic style (canvas fonts; combine with -b)
//      -n, --normal       normal style (default)
//      -l, --list         list fonts, styles and sizes
//      -h, --help         show this help
//
// EXAMPLES
//      figlet hello
//      figlet -f impact -b J.CMD
//      figlet -f serif -i -s 12 hi
//      figlet -l

// ─── fonts ───
var FONTS = {
  blocks:  { family: null,        desc: "built-in 5-row block font (works in the CLI too)" },
  mono:    { family: "monospace", desc: "monospace" },
  serif:   { family: "serif",     desc: "serif" },
  sans:    { family: "sans-serif", desc: "sans-serif" },
  cursive: { family: "cursive",   desc: "cursive" },
  fantasy: { family: "fantasy",   desc: "fantasy" },
  courier: { family: "Courier New, monospace", desc: "Courier New" },
  times:   { family: "Times New Roman, serif", desc: "Times New Roman" },
  arial:   { family: "Arial, sans-serif", desc: "Arial" },
  impact:  { family: "Impact, fantasy", desc: "Impact" },
};
var DEFAULT_ROWS = 8;

function listAll() {
  console.log("figlet fonts:");
  for (var k in FONTS) {
    console.log("  " + k + "   " + FONTS[k].desc);
  }
  console.log("styles: normal (-n) · bold (-b) · italic (-i) · bold+italic");
  console.log("size: -s ROWS, 3..30 (banner height; default " + DEFAULT_ROWS + ", blocks is fixed at 5)");
}

function help() {
  console.log("figlet — big ASCII banner text");
  console.log("usage: figlet [-f FONT] [-s ROWS] [-b|-i|-n] <text...>");
  console.log("       figlet -l   list fonts, styles and sizes");
  console.log("fonts: blocks · mono · serif · sans · cursive · fantasy ·");
  console.log("       courier · times · arial · impact   (canvas fonts need a browser)");
  console.log("example: figlet -f impact -b j.cmd");
}

// ─── built-in block font (CLI + -f blocks) ───
var BLOCK = {
  "A": ".###.#...##...#######...#",
  "B": "####.#...#####.#...#####.",
  "C": ".#####....#....#.....####",
  "D": "####.#...##...##...#####.",
  "E": "######....####.#....#####",
  "F": "######....####.#....#....",
  "G": ".#####....#..###...#.####",
  "H": "#...##...#######...##...#",
  "I": "#####..#....#....#..#####",
  "J": "..###...#....#.#..#..##..",
  "K": "#...##..#.###..#..#.#...#",
  "L": "#....#....#....#....#####",
  "M": "#...###.###.#.##...##...#",
  "N": "#...###..##.#.##..###...#",
  "O": ".###.#...##...##...#.###.",
  "P": "####.#...#####.#....#....",
  "Q": ".###.#...##...##..#..##.#",
  "R": "####.#...#####.#..#.#...#",
  "S": ".#####.....###.....#####.",
  "T": "#####..#....#....#....#..",
  "U": "#...##...##...##...#.###.",
  "V": "#...##...##...##...#.#.#.",
  "W": "#...##...##.#.###.###...#",
  "X": "#...##...#.#.#...#....#..",
  "Y": "#...##...#.#.#...#....#..",
  "Z": "#####....#...#...#..#####",
  "0": ".###.#...##..###...#.###.",
  "1": "..#...##....#....#..#####",
  "2": ".###.....#.###.#....#####",
  "3": "####.....#.###.....#####.",
  "4": "#..#.#..#.#####....#....#",
  "5": "######....####.....#####.",
  "6": ".###.#....####.#...#.###.",
  "7": "#####....#...#...#....#..",
  "8": ".###.#...#.###.#...#.###.",
  "9": ".###.#...#.####....#.###.",
  " ": ".........................",
  "!": "..#....#....#.........#..",
  ".": "......................#..",
  "?": ".###.#...#...#...#....#..",
};

function glyphRow(glyph, r) {
  var s = glyph.slice(r * 5, r * 5 + 5);
  var out = "";
  for (var i = 0; i < s.length; i++) out += s.charAt(i) === "." ? " " : s.charAt(i);
  return out;
}

function blockFiglet(text) {
  var rows = ["", "", "", "", ""];
  var upper = text.toUpperCase();
  for (var c = 0; c < upper.length; c++) {
    var glyph = BLOCK[upper.charAt(c)] || BLOCK["?"];
    for (var r = 0; r < 5; r++) {
      var g = glyphRow(glyph, r);
      while (g.length > 0 && g.charAt(g.length - 1) === " ") g = g.slice(0, g.length - 1);
      rows[r] += g + " ";
    }
  }
  for (var rr = 0; rr < 5; rr++) {
    while (rows[rr].length > 0 && rows[rr].charAt(rows[rr].length - 1) === " ") {
      rows[rr] = rows[rr].slice(0, rows[rr].length - 1);
    }
  }
  return rows;
}

// ─── browser renderer: draw with the chosen font/style/size on a
//     hidden canvas and sample the pixels into the banner ───
function canvasFiglet(text, family, style, rows) {
  var canvas = document.createElement("canvas");
  var ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  var FS = rows * 12;               // ~12px of render per output row
  ctx.font = style + " " + FS + "px " + family;
  var tw = ctx.measureText(text).width;
  canvas.width = Math.ceil(tw) + 8;
  canvas.height = Math.ceil(FS * 1.35);
  ctx.font = style + " " + FS + "px " + family;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  ctx.textBaseline = "top";
  ctx.fillText(text, 4, 0);
  var img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

  var minY = canvas.height, maxY = -1;
  for (var y = 0; y < canvas.height; y++) {
    for (var x = 0; x < canvas.width; x++) {
      if (img[(y * canvas.width + x) * 4] < 128) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxY < 0) return [text];
  var boxH = maxY - minY + 1;
  var cellH = boxH / rows;
  var cellW = cellH * 0.55;         // glyphs are roughly 0.55 wide
  var cols = Math.max(1, Math.ceil(tw / cellW));
  if (cols > 160) cols = 160;
  var out = [];
  for (var r = 0; r < rows; r++) {
    var line = "";
    for (var c = 0; c < cols; c++) {
      var x0 = Math.floor(c * cellW);
      var y0 = minY + Math.floor(r * cellH);
      var x1 = Math.min(canvas.width, Math.ceil((c + 1) * cellW));
      var y1 = Math.min(maxY + 1, y0 + Math.ceil(cellH));
      var sum = 0, n = 0;
      for (var yy = y0; yy < y1; yy++) {
        for (var xx = x0; xx < x1; xx++) {
          sum += img[(yy * canvas.width + xx) * 4];
          n++;
        }
      }
      line += (sum / n) < 128 ? "#" : " ";
    }
    while (line.charAt(line.length - 1) === " ") line = line.slice(0, -1);
    out.push(line);
  }
  return out;
}

// ─── parse args ───
var font = null;
var rows = 0;
var bold = false;
var italic = false;
var i = 0;
var words = [];
while (i < args.length) {
  var a = args[i];
  if (a === "-h" || a === "--help") { help(); return 0; }
  if (a === "-l" || a === "--list") { listAll(); return 0; }
  if (a === "-f" || a === "--font") {
    font = (args[i + 1] || "").toLowerCase();
    if (!FONTS[font]) {
      console.log("figlet: unknown font '" + (args[i + 1] || "") + "' — try: figlet -l");
      return 2;
    }
    i += 2;
    continue;
  }
  if (a === "-s" || a === "--size") {
    rows = parseInt(args[i + 1], 10);
    if (!isFinite(rows) || rows < 3 || rows > 30) {
      console.log("figlet: bad size '" + (args[i + 1] || "") + "' (3..30 rows)");
      return 2;
    }
    i += 2;
    continue;
  }
  if (a === "-b" || a === "--bold") { bold = true; i++; continue; }
  if (a === "-i" || a === "--italic") { italic = true; i++; continue; }
  if (a === "-n" || a === "--normal") { bold = false; italic = false; i++; continue; }
  words.push(a);
  i++;
}
var text = words.join(" ");
if (!text) {
  help();
  return 2;
}

var isBrowser = typeof document !== "undefined" && typeof document.createElement === "function";
var useCanvas = isBrowser && font !== "blocks";
if (!font) font = isBrowser ? "mono" : "blocks";
if (!useCanvas && font !== "blocks") useCanvas = false;  // canvas font requested in CLI

if (useCanvas) {
  var styleStr = (bold && italic) ? "bold italic" : bold ? "bold" : italic ? "italic" : "normal";
  var r = rows || DEFAULT_ROWS;
  try {
    var canvasRows = canvasFiglet(text, FONTS[font].family, styleStr, r);
    for (var cr = 0; cr < canvasRows.length; cr++) console.log(canvasRows[cr]);
    return 0;
  } catch (e) {
    // canvas unavailable — fall through to the block font
  }
}
var blockRows = blockFiglet(text);
for (var br = 0; br < blockRows.length; br++) console.log(blockRows[br]);
return 0;
