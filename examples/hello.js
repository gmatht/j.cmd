// ─── Example: hello.js ──────────────────────────────────────────
// A "compiled binary" for jtsh.
//
// This is what bash compiles down to. No bash syntax, no transpiler,
// just JavaScript — the machine code of the browser shell.
//
// Available globals (injected by jtsh):
//   args    — command-line arguments as an array of strings
//   fs      — the virtual filesystem instance
//   console — with .log() captured for output

const name = args[0] || "anonymous";
console.log(`Hello, ${name}! Welcome to the virtual filesystem.`);
console.log(`You are in: ${fs.cwd}`);
console.log(`There are ${args.length} argument(s): ${args.join(", ")}`);
