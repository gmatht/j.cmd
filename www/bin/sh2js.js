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
// sh2js v2 — transpile bash to JavaScript (debashl ESTree path).
//   sh2js 'echo hi'        inline source
//   sh2js script.sh        bash script file
//   sh2js -f script.sh     bash script file (explicit)
//   cat script.sh | sh2js  from a pipe (or: sh2js -)
//   sh2js -e 'echo hi'     ESTree JSON
if (args[0] === "-e") {
  const ast = await sh2lib.toEstree(args.slice(1).join(" "));
  console.log(JSON.stringify(ast, null, 2));
  return 0;
}
if (args.length === 0 && !stdin) {
  console.log("usage: sh2js '<bash source>' | script.sh | -f FILE | pipe");
  return 2;
}
try {
  console.log(await sh2lib.bashToJs(await sh2src()));
} catch (e) {
  console.log("sh2js: " + e.message);
  return 1;
}
return 0;
