// debashc v2 — the bash compiler CLI (debashl reactor): parse → ESTree or Perl.
//   debashc parse 'echo hi'          ESTree JSON
//   debashc parse --perl 'echo hi'   Perl source
//   debashc file --estree x.sh       ESTree for a script file
//   debashc file --perl x.sh         Perl for a script file
//   debashc x.sh                     ESTree for a script file
if (!args.length || args[0] === "-h" || args[0] === "--help") {
  console.log("debashc — bash compiler (debashl)");
  console.log("  debashc parse 'echo hi'              ESTree JSON");
  console.log("  debashc parse --perl 'echo hi'       Perl source");
  console.log("  debashc file --estree x.sh           ESTree for a file");
  console.log("  debashc file --perl x.sh             Perl for a file");
  console.log("  debashc x.sh                         ESTree for a file");
  return args.length ? 0 : 2;
}
async function readSource() {
  if (args[0] === "file") {
    const file = args[2];
    if (!file) throw new Error("file mode needs a file name");
    return await fs.read(file);
  }
  if (args[0] === "<") {
    if (!args[1]) throw new Error("'<' needs a file name");
    return await fs.read(args[1]);
  }
  if (args.length === 1 && !args[0].startsWith("-")) {
    try { return await fs.read(args[0]); } catch { return args[0]; }
  }
  return args.slice(1).join(" ");
}
try {
  const src = await readSource();
  if (args[0] === "parse" && args[1] === "--perl") { console.log(await sh2lib.toPerl(src)); return 0; }
  if (args[0] === "file" && args[1] === "--perl") { console.log(await sh2lib.toPerl(src)); return 0; }
  if (args[0] === "parse") { console.log(JSON.stringify(await sh2lib.toEstree(src), null, 2)); return 0; }
  console.log(JSON.stringify(await sh2lib.toEstree(src), null, 2));
} catch (e) {
  console.log("debashc: " + e.message);
  return 1;
}
return 0;
