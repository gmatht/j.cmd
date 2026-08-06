// Symlink + /http/ featured entries tests (Node)
import { fs } from "./src/fs/index.js";

let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("FAIL  " + name); }
};
const eq = (a, b, name) => ok(a === b, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// ── prepopulated Examples symlinks exist at boot ──
console.log("## prepopulated ~/Examples links");
const entries = await fs.list("/home/examples");
for (const want of ["sample.mp3", "sample.ogg", "sample.webm", "sample.png", "sample.jpg", "sample.mp4", "sample.txt"]) {
  ok(entries.includes(want), `ls /home/examples shows ${want}`);
}
eq(await fs.readlink("/home/examples/sample.txt"), "/http/raw.githubusercontent.com/git/git/master/README.md", "readlink sample.txt");
eq(await fs.readlink("/home/examples/sample.mp3"), "/http/raw.githubusercontent.com/mdn/webaudio-examples/main/audio-analyser/viper.mp3", "readlink sample.mp3");

// readlink on a non-link must fail
let threw = false;
try { await fs.readlink("/home/examples/hello.sh"); } catch { threw = true; }
ok(threw, "readlink on non-link throws");

// ── reading through a link resolves to the target ──
console.log("## resolution");
const viaLink = await fs.read("/home/examples/sample.txt");
const direct = await fs.read("/http/raw.githubusercontent.com/git/git/master/README.md");
ok(viaLink.includes("Git") && viaLink.length > 100, "cat through link reads target");
ok(viaLink === direct, "link read == direct read");

// relative link in /tmp
await fs.write("/tmp/hello.txt", "hello world\n");
await fs.link("hello.txt", "/tmp/rel-link");
eq(await fs.readlink("/tmp/rel-link"), "hello.txt", "readlink relative target");
eq((await fs.read("/tmp/rel-link")).trim(), "hello world", "relative link resolves against link dir");
const relEntries = await fs.list("/tmp");
ok(relEntries.includes("rel-link"), "ls /tmp shows relative link");

// link to a directory works (cd through it, list through it)
await fs.link("/home/examples", "/tmp/examples-link");
const thru = await fs.list("/tmp/examples-link");
ok(thru.includes("hello.sh"), "ls through dir-link lists target dir");
// .. after a symlink refers to the target's parent (/home/examples/.. = /home)
eq(fs._resolve("/tmp/examples-link/../hello.txt"), "/home/hello.txt", ".. through dir-link resolves to target parent");

// chained links follow
await fs.link("/tmp/hello.txt", "/tmp/a");
await fs.link("/tmp/a", "/tmp/b");
eq((await fs.read("/tmp/b")).trim(), "hello world", "chained links follow");

// ELOOP
await fs.link("/tmp/loop1", "/tmp/loop2");
await fs.link("/tmp/loop2", "/tmp/loop1");
threw = false;
try { await fs.read("/tmp/loop1"); } catch (e) { threw = /ELOOP/.test(e.message); }
ok(threw, "link loop throws ELOOP");

// ── ls rendering ──
console.log("## listing rendering");
const short = await fs.formatList("/home/examples");
ok(short.includes("sample.mp3"), "short ls includes link name");
const long = await fs.formatList("/home/examples", { long: true });
ok(long.includes("lrwxrwxrwx"), "long ls shows lrwxrwxrwx for links");
ok(long.includes("-> /http/"), "long ls shows -> target");
const longFile = await fs.formatLongFile("/home/examples/sample.mp3");
ok(longFile.includes("lrwxrwxrwx") && longFile.includes("-> /http/"), "ls -l file shows link row");

// ── rm unlinks, target untouched ──
console.log("## remove");
await fs.remove("/tmp/rel-link");
threw = false;
try { await fs.readlink("/tmp/rel-link"); } catch { threw = true; }
ok(threw, "rm removes the link itself");
eq((await fs.read("/tmp/hello.txt")).trim(), "hello world", "rm of link leaves target intact");

// rm the prepopulated example link — target must survive, and ls must
// no longer show it
await fs.remove("/home/examples/sample.txt");
const after = await fs.list("/home/examples");
ok(!after.includes("sample.txt"), "removed prepopulated link gone from listing");
const st = await fs.stat("/http/raw.githubusercontent.com/git/git/master/README.md");
ok(st && st.type === "file", "remote target still stat-able (untouched)");

// dangling link: rm removes it
await fs.link("/tmp/nowhere/not-there", "/tmp/dangle");
await fs.remove("/tmp/dangle");
const d = await fs.list("/tmp");
ok(!d.includes("dangle"), "rm removes dangling link");

// ── link() validation ──
console.log("## validation");
threw = false;
try { await fs.link("/tmp/hello.txt", "/tmp/no-such-dir/x"); } catch (e) { threw = /ENOENT/.test(e.message); }
ok(threw, "link into missing dir fails ENOENT");
threw = false;
try { await fs.link("/tmp/hello.txt", "/tmp/hello.txt"); } catch (e) { threw = /EEXIST/.test(e.message); }
ok(threw, "link over existing file fails EEXIST");

// ── /http/ featured entries ──
// The samples form a folder tree: hosts are dirs at the root, the
// curated files sit at the leaves. Root lists hosts + README; deep
// listings show the path fragments down to the files.
console.log("## /http/ featured");
const http = await fs.list("/http");
for (const want of ["README.md", "archive.org/", "upload.wikimedia.org/", "mdn.github.io/", "picsum.photos/", "raw.githubusercontent.com/"]) {
  ok(http.includes(want), `ls /http shows ${want}`);
}
const deep = await fs.list("/http/archive.org/download/testmp3testfile");
ok(deep.includes("mpthreetest.mp3"), "ls deep path shows the leaf file");
const deep2 = await fs.list("/http/upload.wikimedia.org/wikipedia/commons/6/6a");
ok(deep2.includes("JavaScript-logo.png"), "ls wikimedia tree shows the png");
const readme = await fs.read("/http/README.md");
ok(readme.includes("Featured sample files"), "/http/README.md renders");
const st2 = await fs.stat("/http/raw.githubusercontent.com/mdn/webaudio-examples/main/audio-analyser/viper.mp3");
ok(st2 && st2.type === "file", "stat of featured /http entry is a file");
const st3 = await fs.stat("/http/upload.wikimedia.org");
ok(st3 && st3.type === "dir", "stat of a host folder is a dir");

// ── shell builtins (ln / readlink / mv / rm) through jtsh batch ──
console.log("## shell builtins");
const { execSync } = await import("node:child_process");
const script = [
  "echo hi > /tmp/hello.txt",
  "ln -s /tmp/hello.txt /tmp/shell-link",
  "readlink /tmp/shell-link",
  "cat /tmp/shell-link",
  "mv /tmp/shell-link /tmp/shell-link2",
  "readlink /tmp/shell-link2",
  "rm /tmp/shell-link2",
  "mkdir /tmp/dirlink",
  "ln -s /home/examples /tmp/dirlink/",
  "readlink /tmp/dirlink/examples",
  "rm /home/examples/sample.ogg",
  "ls /home/examples/",
].join("\n");
const out = execSync("node src/jtsh.js", { input: script, cwd: process.cwd(), encoding: "utf8" });
console.log(out);
ok(out.includes("hello.txt"), "ln+readlink via shell");
ok(out.includes("hi"), "cat through shell-created link");
ok(out.includes("/tmp/hello.txt"), "mv relinks (target preserved, link moved)");
ok(out.includes("/home/examples"), "ln -s target dir/ uses basename");
ok(!out.includes("sample.ogg"), "rm of example link works in shell");
ok(out.includes("sample.mp3") && out.includes("sample.png"), "ls still shows other sample links");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
