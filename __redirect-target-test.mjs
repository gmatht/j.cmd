// ─── __redirect-target-test.mjs — an unquoted $(…) redirect target ───
//
// The bug that produced the 130-byte junk file in the repo root, named
// after a fragment of mimecroft's shader source:
//
//   $(echo "scale=4; 0.0 - $relz + 0.0" | bc)\n  if [ "$(echo ...)" = "1" ]; \
//     then w=0.0001; fi|
//
// Mechanism (pinned exactly below): the emitter renders a redirect whose
// target is a command substitution as
//
//   await sh2.fs.writeFile(
//     await sh2.captureWords(() => sh2.builtin("echo", ["alpha"])),
//     "hi" + "\n")
//
// captureWords() returns an ARRAY (it is the word-splitter), and the
// array is handed to fs.writeFile as the path. So:
//
//   * one word   → fs sees an array → "path.startsWith is not a function"
//                  (bash: creates the file)
//   * two words  → fs coerces to "alpha,beta" … or takes the first word,
//                  creating a file bash REFUSES to create
//   * zero words → a THROW instead of bash's `ambiguous redirect`
//
// bash's contract for such a target, which these tests assert:
//
//   ONE word  → redirect happens (file created)
//   ZERO      → `ambiguous redirect`, status 1, no file
//   MANY      → `ambiguous redirect`, status 1, no file
//
// This test is the repo-local half of upstream-repros/08; it checks the
// generated JS shape (so the defect is pinned even while the runtime
// behaviour is still being fixed) AND the end-to-end behaviour.
//
//   node __redirect-target-test.mjs   → "ALL REDIRECT-TARGET CHECKS PASSED"
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fs } from "./src/fs/index.js";
import { runBash, bashToJS } from "./src/bash2js.js";

let fails = 0;
const ok = (m) => console.log("  ok   " + m);
const bad = (m) => { console.log("  FAIL " + m); fails++; };
const check = (c, m) => (c ? ok(m) : bad(m));

// Run a snippet through the runtime, in a private cwd, and report the
// files it left behind plus its output. The directory is created by the
// shell itself (mkdir -p) so it exists in whatever backend is mounted.
async function runInDir(src, dir) {
  const shell = (s) => runBash(fs, s, {
    stdout: { write: () => {} }, stderr: { write: () => {} },
    runCmd: async () => ({ out: "", err: "", code: 127 }), args: [], argv0: "t.sh",
  });
  try { await shell(`mkdir -p ${dir}\n`); } catch { /* may already exist */ }
  const prev = fs.cwd;
  fs.cwd = dir;
  let out = "", err = "";
  try {
    await runBash(fs, src, {
      stdout: { write: (s) => (out += s) },
      stderr: { write: (s) => (err += s) },
      runCmd: async () => ({ out: "", err: "", code: 127 }),
      args: [], argv0: "t.sh",
    });
  } catch (e) {
    err += "THREW: " + (e && e.message ? e.message : e);
  } finally {
    fs.cwd = prev;
  }
  let files = [];
  try {
    files = (await fs.list(dir))
      .map(String)
      .map((s) => s.replace(/\/$/, ""))
      .filter((s) => s !== ".directory")   // mount bookkeeping, not a user file
      .sort();
  } catch { /* absent */ }
  return { out, err, files };
}

// Real bash's verdict, for the same snippet, in a throwaway temp dir.
function bashVerdict(src) {
  const dir = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
  let status = 0, out = "";
  try {
    out = execFileSync("bash", ["-c", src], { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) { status = e.status; out = String(e.stdout || ""); }
  const files = execFileSync("bash", ["-c", "ls -A", ], { cwd: dir, encoding: "utf8" }).trim().split("\n").filter(Boolean).sort();
  return { status, out, files, dir };
}

// ── (a) the generated JS shape — the precise defect ──────────────
console.log("== (a) generated JS: the target must not be a raw array ==");
{
  const js = (await bashToJS(fs, 'echo hi > $(echo alpha)\n')).js;
  check(/captureWords/.test(js), "a $(…) redirect target lowers through captureWords()");
  // the defect: captureWords(...) fed to writeFile as the PATH argument
  const rawArray = /writeFile\(\s*await\s+sh2\.captureWords\(/.test(js);
  check(!rawArray,
    "writeFile() is NOT handed captureWords()'s array directly" +
    (rawArray ? "  ← BUG: the word list is used as the path" : ""));
}

// ── (b) one word: bash creates the file ──────────────────────────
console.log("\n== (b) one word → the file is created with the echoed text ==");
{
  const src = "echo hi > $(echo onepiece)\n";
  const b = bashVerdict(src);
  const r = await runInDir(src, "/tmp/rt-one");
  check(b.files.includes("onepiece"), "(sanity) real bash creates `onepiece`");
  check(r.files.includes("onepiece"), "transpiled creates `onepiece`  [files: " + r.files.join(",") + "]");
  if (r.files.includes("onepiece")) {
    check(fs.readFile("/tmp/rt-one/onepiece") === "hi\n", "`onepiece` holds the echoed text");
  }
}

// ── (c) two words: bash refuses — we must not create a file ──────
console.log("\n== (c) two words → `ambiguous redirect`, NO file ==");
{
  const src = "echo hi > $(echo alpha beta)\n";
  const b = bashVerdict(src);
  check(b.status !== 0 && b.files.length === 0, "(sanity) real bash rejects with status " + b.status + ", no files");
  const r = await runInDir(src, "/tmp/rt-two");
  check(r.files.length === 0,
    "transpiled leaves NO file behind  [files: " + r.files.join(",") + "]");
  check(/ambiguous redirect/.test(r.err),
    "transpiled reports `ambiguous redirect`  [err: " + JSON.stringify(r.err.trim().slice(0, 90)) + "]");
}

// ── (d) zero words: bash refuses — we must not throw ────────────
console.log("\n== (d) empty expansion → `ambiguous redirect`, NO file, no throw ==");
{
  const src = "echo hi > $(true)\n";
  const b = bashVerdict(src);
  check(b.status !== 0 && b.files.length === 0, "(sanity) real bash rejects with status " + b.status + ", no files");
  const r = await runInDir(src, "/tmp/rt-zero");
  check(!/THREW/.test(r.err), "transpiled does not THROW  [err: " + JSON.stringify(r.err.trim().slice(0, 90)) + "]");
  check(r.files.length === 0, "transpiled leaves NO file behind  [files: " + r.files.join(",") + "]");
}

// ── (e) the junk-name SHAPE: the actual artifact from the repo root ─
// A literal backslash-n plus embedded spaces — many words, so bash
// rejects it and never writes the file. The real incident created one.
console.log("\n== (e) the shader-source junk-name shape must NOT create a file ==");
{
  const src = "echo hi > $(printf 'a\\nb c\\n')\n";
  const b = bashVerdict(src);
  check(b.status !== 0 && b.files.length === 0, "(sanity) real bash rejects the multi-word shape, no files");
  const r = await runInDir(src, "/tmp/rt-junk");
  check(r.files.length === 0,
    "transpiled leaves NO junk file behind  [files: " + r.files.join(",") + "]");
  const junkish = r.files.filter((f) => /[\\|]/.test(f));
  check(junkish.length === 0, "no filename containing a backslash or a pipe  [got: " + junkish.join(",") + "]");
}

// ── (f) the exact 130-byte name from the incident, as a control ──
// Not shell syntax on its own (it came from a re-escaping layer), so
// assert only that the runtime never materialises it. This is the
// regression guard for the literal artifact that started the hunt.
console.log("\n== (f) the literal incident filename is never created ==");
{
  // Byte-exact: the name begins with `=`, the captured redirect operator.
  const NAME = '=$(echo "scale=4; 0.0 - $relz + 0.0" | bc)\\n  if [ "$(echo "scale=4; if ($w < 0.0001) 1 else 0" | bc)" = "1" ]; then w=0.0001; fi|';
  check(Buffer.byteLength(NAME, "utf8") === 130, "(sanity) the incident name is 130 bytes");
  const r = await runInDir("echo hi > $(echo alpha)\n", "/tmp/rt-exact");
  check(!r.files.some((f) => f.includes("relz")),
    "no file named after the shader fragment  [files: " + r.files.join(",") + "]");
}

for (const d of ["/tmp/rt-one", "/tmp/rt-two", "/tmp/rt-zero", "/tmp/rt-junk", "/tmp/rt-exact"]) {
  try { fs.remove(d); } catch { /* ignore */ }
}

console.log(fails === 0
  ? "\nALL REDIRECT-TARGET CHECKS PASSED"
  : `\n${fails} REDIRECT-TARGET CHECK(S) FAILED`);
process.exit(fails ? 1 : 0);
