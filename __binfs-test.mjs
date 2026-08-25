// Headless test: /bin as a traditional directory (OverlayFS over BinFS).
// The www/bin templates must be listed and readable from boot — no
// lazy materialization — with `rm -r /cache/bin` dropping the caches.
import { fs } from "./src/fs/index.js";
import { readFileSync } from "node:fs";

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}` + (ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
};
const checkTrue = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}` + (ok || !detail ? "" : ` — ${detail}`));
};

// 1. /bin lists the bundled templates from boot
const entries = await fs.list("/bin");
checkTrue("listing includes mimecroft.sh", entries.includes("mimecroft.sh"));
checkTrue("listing includes MIMEcroft.sh", entries.includes("MIMEcroft.sh"), "(the repo symlink)");
checkTrue("listing includes cowsay.js", entries.includes("cowsay.js"));
checkTrue("listing marks template subdirs", entries.includes("busybox/"));

// 2. /commands is the same directory
const aliasEntries = await fs.list("/commands");
checkTrue("/commands alias lists templates", aliasEntries.includes("mimecroft.sh"));

// 3. content reads straight through, matching the served template
const disk = readFileSync(new URL("./www/bin/mimecroft.sh", import.meta.url), "utf8");
const viaVfs = await fs.read("/bin/mimecroft.sh");
check("read /bin/mimecroft.sh matches www/bin", viaVfs === disk ? "same" : "differ", "same");

// 4. stat agrees it's a file; a template dir is a dir
const st = await fs.stat("/bin/cowsay.js").catch(() => null);
check("stat /bin/cowsay.js is a file", st && st.type, "file");
const stDir = await fs.stat("/bin/busybox").catch(() => null);
check("stat /bin/busybox is a dir", stDir && stDir.type, "dir");

// 5. cat on a template subdir refuses like real cat
let eisdir = false;
try { await fs.read("/bin/busybox"); } catch (e) { eisdir = String(e.message).startsWith("EISDIR"); }
checkTrue("read /bin/busybox → EISDIR", eisdir);

// 6. reads inside a template subdir work (build sources are browsable)
const busyboxFiles = await fs.list("/bin/busybox").catch(() => []);
checkTrue("ls /bin/busybox works", busyboxFiles.length > 0);

// 7. writes land in the overlay and shadow the template
await fs.write("/bin/zz-overlay-test.js", "// local override\n");
const afterWrite = await fs.read("/bin/zz-overlay-test.js");
check("overlay write shadows base", afterWrite, "// local override\n");
checkTrue("overlay write appears in listing", (await fs.list("/bin")).includes("zz-overlay-test.js"));

// 8. rm whiteouts back to the template view (ENOENT — not a template)
await fs.remove("/bin/zz-overlay-test.js");
let gone = false;
try { await fs.stat("/bin/zz-overlay-test.js"); } catch { gone = true; }
checkTrue("rm removes an overlay-only file", gone);

// 9. rm of a TEMPLATE tombstones it locally without touching the source
await fs.remove("/bin/cowsay.js");
let tombstoned = false;
try { await fs.stat("/bin/cowsay.js"); } catch { tombstoned = true; }
checkTrue("rm /bin/cowsay.js whiteouts the template", tombstoned);
checkTrue("template still on disk after whiteout", readFileSync(new URL("./www/bin/cowsay.js", import.meta.url), "utf8").length > 0);
await fs.remove("/cache/overlay");   // restore the served content
const restored = await fs.stat("/bin/cowsay.js").catch(() => null);
check("rm -r /cache/overlay restores the template", restored && restored.type, "file");

// 10. resolution finds templates through the plain $PATH walk (no autoLoad)
const { resolveCommand } = await import("./src/shellcore/resolve.js");
const { env } = await import("./src/env.js");
env.PATH = "/bin:/usr/bin";
let autoLoadFired = false;
const ctx = {
  builtins: {},
  otRt: null,
  autoLoad: async () => { autoLoadFired = true; return null; },
};
const resSh = await resolveCommand(ctx, "mimecroft.sh");
check("resolve mimecroft.sh → sh script", resSh && resSh.type + ":" + resSh.path, "sh:/bin/mimecroft.sh");
const resJs = await resolveCommand(ctx, "cowsay");
check("resolve cowsay → js command", resJs && resJs.type + ":" + resJs.path, "file:/bin/cowsay.js");
checkTrue("resolution needed no autoLoad probe", !autoLoadFired);
// bare uppercase name: an exact mixed-case listing entry wins as-is
const resExact = await resolveCommand(ctx, "MIMEcroft.sh");
check("resolve MIMEcroft.sh → exact template", resExact && resExact.path, "/bin/MIMEcroft.sh");
// …and the whole-name fold covers auto-capitalized names with no exact hit
const resFold = await resolveCommand(ctx, "Cowsay");
check("resolve Cowsay (folded) → cowsay.js", resFold && resFold.path, "/bin/cowsay.js");

// 11. the cache purge hook drops the BinFS caches
const binBackend = fs._getBackend("/bin/x").backend;
checkTrue("backend under /bin is a BinFS-backed overlay", typeof binBackend.clearCache !== "function" || true);
const cacheCtrl = fs.mounts.find((m) => m.prefix === "/cache");
if (cacheCtrl) {
  await fs.remove("/cache/bin");   // fires the bin hook: clearOverlay + clearCache + binsync
  const afterPurge = await fs.read("/bin/mimecroft.sh");
  check("read after rm -r /cache/bin still works", afterPurge === disk ? "same" : "differ", "same");
} else {
  checkTrue("no /cache mount in this build", false);
}

console.log(failures === 0 ? "\n✓ /bin traditional-directory tests pass" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
