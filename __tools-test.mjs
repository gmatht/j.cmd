import { readFileSync } from "fs";

// ── shared VFS mock ──
function makeFS() {
  const files = new Map();   // path → Uint8Array
  const dirs = new Set(["/home"]);
  const norm = (p) => {
    let r = p.startsWith("/") ? p : "/home/" + p;
    const parts = r.split("/").filter(Boolean);
    const out = [];
    for (const part of parts) { if (part === "..") out.pop(); else if (part !== ".") out.push(part); }
    return "/" + out.join("/");
  };
  const ensureDirs = (p) => {
    let cur = "/";
    const parts = p.split("/").filter(Boolean).slice(0, -1);
    for (const part of parts) { cur += part; dirs.add(cur); cur += "/"; }
  };
  return {
    cwd: "/home",
    _resolve: norm,
    read: async (p) => new TextDecoder().decode(files.get(norm(p)) || (() => { throw new Error("ENOENT"); })()),
    readBlob: async (p) => {
      const b = files.get(norm(p));
      if (!b) throw new Error("ENOENT");
      return new Blob([b]);
    },
    write: async (p, s) => { const n = norm(p); ensureDirs(n); files.set(n, new TextEncoder().encode(s)); },
    writeBlob: async (p, blob) => { const n = norm(p); ensureDirs(n); files.set(n, new Uint8Array(await blob.arrayBuffer())); },
    list: async (p) => {
      const n = norm(p);
      const out = new Set();
      const prefix = n === "/" ? "/" : n + "/";
      for (const key of files.keys()) if (key.startsWith(prefix)) { const r = key.slice(prefix.length).split("/")[0]; if (r) out.add(r); }
      for (const d of dirs) if (d.startsWith(prefix) && d !== n) { const r = d.slice(prefix.length).split("/")[0]; if (r) out.add(r + "/"); }
      return [...out].sort();
    },
    stat: async (p) => {
      const n = norm(p);
      if (dirs.has(n)) return { type: "dir" };
      if (files.has(n)) return { type: "file", size: files.get(n).length };
      throw new Error("ENOENT");
    },
    mkdir: async (p) => { dirs.add(norm(p)); },
    remove: async (p) => { files.delete(norm(p)); },
  };
}

function run(src, fs, args, stdin = "") {
  const log = [];
  const fn = new Function("args", "fs", "console", "stdin", "env", "sh2", "sh2lib",
    "return (async () => { " + src + " })();");
  return fn(args, fs, { log: (...m) => log.push(m.join(" ")) }, stdin, { HOME: "/home", USER: "tinysh" }, {}, {}).then((c) => ({ c, log }));
}

const srcs = {
  md5sum: readFileSync("/tmp/md5sum-src.js", "utf8"),
  sha256sum: readFileSync("/tmp/sha256sum-src.js", "utf8"),
  gzip: readFileSync("/tmp/gzip-src.js", "utf8"),
  gunzip: readFileSync("/tmp/gunzip-src.js", "utf8"),
  zip: readFileSync("/tmp/zip-src.js", "utf8"),
  tar: readFileSync("/tmp/tar-src.js", "utf8"),
  tree: readFileSync("/tmp/tree-src.js", "utf8"),
  uptime: readFileSync("/tmp/uptime-src.js", "utf8"),
  curl: readFileSync("/tmp/curl-src.js", "utf8"),
};

// md5/sha256 known vectors
let fs = makeFS();
await fs.write("/home/hello.txt", "abc");
let r = await run(srcs.md5sum, fs, ["/home/hello.txt"]);
console.log("md5sum abc:", r.log[0], r.log[0] && r.log[0].startsWith("900150983cd24fb0d6963f7d28e17f72") ? "PASS" : "FAIL");
r = await run(srcs.sha256sum, fs, ["/home/hello.txt"]);
console.log("sha256sum abc:", r.log[0] && r.log[0].startsWith("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") ? "PASS" : "FAIL", r.log[0] && r.log[0].slice(0, 20));

// gzip → gunzip roundtrip
fs = makeFS();
await fs.write("/home/notes.txt", "hello hello hello hello hello gzip roundtrip");
r = await run(srcs.gzip, fs, ["/home/notes.txt"]);
console.log("gzip:", r.c, r.log[0]);
r = await run(srcs.gunzip, fs, ["/home/notes.txt.gz"]);
console.log("gunzip:", r.c, r.log[0]);
const roundtrip = new TextDecoder().decode((await fs.readBlob("/home/notes.txt")).arrayBuffer ? await (await fs.readBlob("/home/notes.txt")).arrayBuffer() : new Uint8Array(0));
console.log("roundtrip matches:", roundtrip === "hello hello hello hello hello gzip roundtrip" ? "PASS" : "FAIL");
console.log("notes.txt.gz exists:", !!(await fs.stat("/home/notes.txt.gz")));

// zip create → list → extract
fs = makeFS();
await fs.write("/home/a.txt", "alpha content here");
await fs.write("/home/b.txt", "beta content here");
await fs.mkdir("/home/sub");
await fs.write("/home/sub/c.txt", "gamma in subdir");
r = await run(srcs.zip, fs, ["/home/backup.zip", "/home/a.txt", "/home/sub/"]);
console.log("zip create:", r.c, r.log[0]);
r = await run(srcs.zip, fs, ["-l", "/home/backup.zip"]);
console.log("zip list:");
r.log.forEach((l) => console.log("  |", l));
r = await run(srcs.zip, fs, ["-x", "/home/backup.zip"]);
console.log("zip extract:", r.c, "|", r.log[0]);
const aOut = new TextDecoder().decode((await fs.readBlob("/home/a.txt")).arrayBuffer ? await (await fs.readBlob("/home/a.txt")).arrayBuffer() : new Uint8Array(0));
const cOut = new TextDecoder().decode((await fs.readBlob("/home/sub/c.txt")).arrayBuffer ? await (await fs.readBlob("/home/sub/c.txt")).arrayBuffer() : new Uint8Array(0));
console.log("zip extracted a.txt:", aOut === "alpha content here" ? "PASS" : "FAIL", "| c.txt:", cOut === "gamma in subdir" ? "PASS" : "FAIL");

// tar create → list → extract
fs = makeFS();
await fs.write("/home/x.txt", "x data padded to more than a block for testing");
await fs.write("/home/y.txt", "y");
await fs.mkdir("/home/d1");
await fs.write("/home/d1/z.txt", "z nested");
r = await run(srcs.tar, fs, ["-cf", "/home/backup.tar", "/home/x.txt", "/home/d1/"]);
console.log("tar create:", r.c, r.log[0]);
r = await run(srcs.tar, fs, ["-tf", "/home/backup.tar"]);
console.log("tar list:");
r.log.forEach((l) => console.log("  |", l));
fs = makeFS();   // fresh, then extract
r = await run(srcs.tar, fs, ["-xf", "/home/backup.tar"]);
console.log("tar extract:", r.c, "|", r.log[0]);
const xOut = new TextDecoder().decode((await fs.readBlob("/home/x.txt")).arrayBuffer ? await (await fs.readBlob("/home/x.txt")).arrayBuffer() : new Uint8Array(0));
const zOut = new TextDecoder().decode((await fs.readBlob("/home/d1/z.txt")).arrayBuffer ? await (await fs.readBlob("/home/d1/z.txt")).arrayBuffer() : new Uint8Array(0));
console.log("tar extracted x.txt:", xOut === "x data padded to more than a block for testing" ? "PASS" : "FAIL", "| z.txt:", zOut === "z nested" ? "PASS" : "FAIL");

// tar -z create → list (gunzip path)
fs = makeFS();
await fs.write("/home/g.txt", "gzip tar test data");
r = await run(srcs.tar, fs, ["-czf", "/home/g.tar.gz", "/home/g.txt"]);
console.log("tar -czf:", r.c, r.log[0]);
r = await run(srcs.tar, fs, ["-tzf", "/home/g.tar.gz"]);
console.log("tar -tzf list:", r.c, "|", r.log[0] || "(empty)");

// tree
fs = makeFS();
await fs.write("/home/top.txt", "top");
await fs.mkdir("/home/dirA");
await fs.write("/home/dirA/one.txt", "1");
await fs.mkdir("/home/dirA/dirB");
await fs.write("/home/dirA/dirB/two.txt", "2");
r = await run(srcs.tree, fs, ["/home"]);
console.log("tree:");
r.log.forEach((l) => console.log("  |", l));

// uptime
r = await run(srcs.uptime, fs, []);
console.log("uptime:", r.log[0], "|", r.log[1]);
