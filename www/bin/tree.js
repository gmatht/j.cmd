// tree v1 — recursive directory listing
//
// NAME
//      tree — recursive directory listing
//
// SYNOPSIS
//      tree [dir] [-L N] [-a]
//
// DESCRIPTION
//      Prints the directory tree under [dir] (default: the current
//      directory), with branch characters like the classic tree
//      command. -L limits the depth, -a includes dotfiles.
//
// OPTIONS
//      -L N     descend at most N levels
//      -a       include hidden files
//      -h, --help   show this help
//
// EXAMPLES
//      tree /home
//      tree -L 2 /tmp

var NL = String.fromCharCode(10);
var TE = String.fromCharCode(9500);   // ├
var LE = String.fromCharCode(9492);   // └
var VE = String.fromCharCode(9474);   // │
var HZ = String.fromCharCode(9472);   // ─

var maxDepth = Infinity;
var showAll = false;
var roots = [];
var i = 0;
while (i < args.length) {
  var a = args[i];
  if (a === "-h" || a === "--help") {
    console.log("tree — recursive directory listing");
    console.log("usage: tree [dir] [-L N] [-a]");
    console.log("example: tree /home · tree -L 2 /tmp");
    return 0;
  }
  if (a === "-L") {
    maxDepth = parseInt(args[i + 1], 10);
    if (!isFinite(maxDepth) || maxDepth < 1) {
      console.log("tree: bad depth '" + (args[i + 1] || "") + "'");
      return 2;
    }
    i += 2;
    continue;
  }
  if (a === "-a") { showAll = true; i++; continue; }
  if (a.charAt(0) === "-" && a.length > 1) {
    console.log("tree: invalid option -- '" + a + "'");
    return 2;
  }
  roots.push(a);
  i++;
}
if (roots.length === 0) roots.push(fs.cwd || "/home");

var out = "";
var dirCount = 0;
var fileCount = 0;

function joinPath(dir, name) {
  return dir === "/" ? "/" + name : dir + "/" + name;
}

async function walk(dir, prefix, depth) {
  var entries;
  try { entries = await fs.list(dir); } catch { return; }
  var items = entries.filter(function (e) { return showAll || e.charAt(0) !== "."; });
  items.sort();
  for (var k = 0; k < items.length; k++) {
    var e = items[k];
    var isDir = e.charAt(e.length - 1) === "/";
    var name = isDir ? e.slice(0, -1) : e;
    var last = k === items.length - 1;
    out += prefix + (last ? LE : TE) + HZ + HZ + " " + name + NL;
    if (isDir) {
      dirCount++;
      if (depth < maxDepth) {
        await walk(joinPath(dir, name), prefix + (last ? "    " : VE + "   "), depth + 1);
      }
    } else {
      fileCount++;
    }
  }
}

for (var r = 0; r < roots.length; r++) {
  var root = typeof fs._resolve === "function" ? fs._resolve(roots[r]) : roots[r];
  out += root + NL;
  await walk(root, "", 1);
  out += NL;
}
out += dirCount + " director" + (dirCount === 1 ? "y" : "ies") + ", " +
  fileCount + " file" + (fileCount === 1 ? "" : "s");
console.log(out);
return 0;
