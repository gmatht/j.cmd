// Reproduce: run `mimecroft.sh` in the web browser terminal (no --demo)
// and capture terminal output + the script's own /tmp/smdebug.txt trace.
import { chromium } from "/home/user/node_modules/playwright/index.mjs";

const URL = process.env.URL || "http://localhost:8050/index.html";
const CMD = process.env.CMD || "mimecroft.sh";
const WAIT_MS = parseInt(process.env.WAIT_MS || "40000", 10);

const browser = await chromium.launch({
  headless: false,
  executablePath: "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (msg) => console.log("[console]", msg.type(), msg.text().slice(0, 400)));
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 600)));

await page.goto(URL, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("#hidden-input", { state: "attached", timeout: 30000 });
await page.waitForTimeout(3000);

await page.evaluate(() => document.getElementById("hidden-input").focus());
await page.keyboard.type(CMD);
await page.keyboard.press("Enter");
console.log("=== command submitted:", CMD, "===");

const t0 = Date.now();
let lastText = "";
while (Date.now() - t0 < WAIT_MS) {
  await page.waitForTimeout(2000);
  const text = await page.evaluate(() => document.getElementById("terminal").innerText);
  if (text !== lastText) {
    lastText = text;
    console.log("--- t+" + ((Date.now() - t0) / 1000).toFixed(1) + "s ---");
    console.log(text.slice(-2500));
  }
  if (/GAME DONE|== Quit|GAME OVER/.test(text)) break;
}

// read the script's own debug trace from the browser VFS
const dbg = await page.evaluate(async () => {
  try {
    const r = await fetch("/fs/read?path=/tmp/smdebug.txt");
    if (r.ok) return await r.text();
  } catch {}
  return "(no /fs/read endpoint)";
});
console.log("=== /tmp/smdebug.txt ===");
console.log(dbg.slice(-4000));

console.log("=== FINAL terminal text (last 3000) ===");
console.log(lastText.slice(-3000));
await browser.close();
