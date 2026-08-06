async function sh2src() {
  if (args[0] === "-f" || args[0] === "--file") {
    if (!args[1]) throw new Error("-f needs a file name");
    return await fs.read(args[1]);
  }
  if (args[0] === "<") {
    if (!args[1]) throw new Error("'<' needs a file name");
    return await fs.read(args[1]);
  }
  if (args[0] === "-" || (args.length === 0 && stdin)) return stdin;
  if (args.length === 1 && !args[0].startsWith("-")) {
    try { return await fs.read(args[0]); } catch { return args[0]; }
  }
  return args.join(" ");
}
// sh2perl v2 — transpile bash to Perl via debashl.
//   sh2perl 'echo hi'      inline source
//   sh2perl script.sh      bash script file
//   sh2perl -f script.sh   bash script file (explicit)
//   cat script.sh | sh2perl  from a pipe (or: sh2perl -)
if (args.length === 0 && !stdin) {
  console.log("usage: sh2perl '<bash source>' | script.sh | -f FILE | pipe");
  return 2;
}
try {
  console.log(await sh2lib.toPerl(await sh2src()));
} catch (e) {
  console.log("sh2perl: " + e.message);
  return 1;
}
return 0;
