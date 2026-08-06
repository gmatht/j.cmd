// cowsay v1 — a configurable talking cow (and friends)
//
// NAME
//      cowsay — a talking cow
//
// SYNOPSIS
//      cowsay [-f ANIMAL] [message...]
//      echo message | cowsay
//
// DESCRIPTION
//      cowsay renders a message in a speech bubble, spoken by an ASCII
//      animal. Long messages wrap at 40 columns; a piped message works
//      too. The default animal is a cow; -f picks another.
//
// OPTIONS
//      -f, --file ANIMAL   cow (default), tux, dragon
//      -h, --help          show this help
//
// EXAMPLES
//      cowsay moo
//      cowsay -f tux hello
//      echo 'feeling lucky' | cowsay -f dragon

var NL = String.fromCharCode(10);
var BS = String.fromCharCode(92);   // backslash
var BT = String.fromCharCode(96);   // backtick
var UNDER = String.fromCharCode(95);  // _
var DASH = String.fromCharCode(45);   // -

// ─── the animals (special chars built from codes) ───
var ANIMALS = {
  cow: [
    "        " + BS + "   ^__^",
    "         " + BS + "  (oo)" + BS + "_______",
    "            (__)" + BS + "       )" + BS + "/" + BS,
    "                ||----w |",
    "                ||     ||",
  ],
  tux: [
    "   .--.",
    "  |o_o |",
    "  |:_/ |",
    " //   " + BS + " " + BS,
    " (|     | )",
    "/'" + BS + "_   _/" + BT + BS,
    BS + "___)=(___/",
  ],
  dragon: [
    "                ___",
    "               /   " + BS,
    "     " + BS + "         /  / " + BS + " " + BS,
    "      " + BS + "       /  / " + BS + " " + BS + "_",
    "       " + BS + "     /  /   " + BS + "_/_",
    "        " + BS + "   /  /   /  /",
    "         " + BS + "  /__/   /__/",
  ],
};
var DEFAULT_ANIMAL = "cow";
var WRAP = 40;

function usage() {
  console.log("cowsay — a talking cow (and friends)");
  console.log("usage: cowsay [-f ANIMAL] [message...]   |   echo msg | cowsay");
  console.log("animals: cow · tux · dragon   (default cow)");
}

// ─── parse args ───
var animal = DEFAULT_ANIMAL;
var i = 0;
var words = [];
while (i < args.length) {
  var a = args[i];
  if (a === "-h" || a === "--help") { usage(); return 0; }
  if (a === "-f" || a === "--file") {
    animal = (args[i + 1] || "").toLowerCase();
    if (!ANIMALS[animal]) {
      console.log("cowsay: unknown animal '" + (args[i + 1] || "") + "' (cow, tux, dragon)");
      return 2;
    }
    i += 2;
    continue;
  }
  words.push(a);
  i++;
}
var message = words.join(" ");
if (!message && stdin && stdin.trim()) message = stdin.trim();
if (!message) { usage(); return 2; }

// ─── wrap at WRAP columns ───
var lines = [];
var cur = "";
var w = message.split(" ");
for (var k = 0; k < w.length; k++) {
  var word = w[k];
  if (cur && cur.length + 1 + word.length > WRAP) {
    lines.push(cur);
    cur = word;
  } else {
    cur = cur ? cur + " " + word : word;
  }
}
if (cur) lines.push(cur);

// ─── speech bubble ───
var width = 0;
for (var m = 0; m < lines.length; m++) if (lines[m].length > width) width = lines[m].length;
function pad(s, n) {
  while (s.length < n) s += " ";
  return s;
}
function repeatChar(c, n) {
  var s = "";
  for (var r = 0; r < n; r++) s += c;
  return s;
}
var bubble = " " + repeatChar(UNDER, width + 2) + NL;
if (lines.length === 1) {
  bubble += "< " + lines[0] + " >" + NL;
} else {
  for (var m2 = 0; m2 < lines.length; m2++) {
    var l = lines[m2];
    var left = m2 === 0 ? "/" : m2 === lines.length - 1 ? BS : "|";
    var right = m2 === 0 ? BS : m2 === lines.length - 1 ? "/" : "|";
    bubble += left + " " + pad(l, width) + " " + right + NL;
  }
}
bubble += " " + repeatChar(DASH, width + 2) + NL;

// ─── assemble: bubble then animal ───
var art = ANIMALS[animal];
var out = bubble;
for (var a2 = 0; a2 < art.length; a2++) out += art[a2] + NL;
// trim trailing whitespace (console.log adds the final newline)
while (out.length > 0 && (out.charAt(out.length - 1) === " " || out.charAt(out.length - 1) === NL)) {
  out = out.slice(0, out.length - 1);
}
console.log(out);
return 0;
