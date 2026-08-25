// Claim a treasure and check the audio device log + console
import { chromium } from "/home/user/node_modules/playwright/index.mjs";

const browser = await chromium.launch({
  headless: false,
  executablePath: "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (msg) => { const t = msg.text(); if (/audio|Audio|sound/i.test(t)) console.log("[console]", msg.type(), t.slice(0, 200)); });
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
await page.goto("http://127.0.0.1:8060/www/", { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("#hidden-input", { state: "attached", timeout: 30000 });
await page.waitForTimeout(3000);
await page.evaluate(() => document.getElementById("hidden-input").focus());
await page.keyboard.type("MIMEcroft.sh");
await page.keyboard.press("Enter");
await page.waitForTimeout(16000);
await page.keyboard.press("Space");
const t0 = Date.now();
while (Date.now() - t0 < 90000) { await page.waitForTimeout(400); const t = await page.evaluate(() => document.getElementById("terminal").innerText); if (t.includes("ready.")) break; }
// walk forward into a treasure: spawn (2,2) facing -z, treasure at (2,1,1) is 2 cells ahead? No —
// the win test puts a treasure at (2,1,1); here the maze is random. Just move forward several
// steps and shoot — the treasure claim needs a walk-in. Instead, let the demo do it.
console.log("=== checking sound path via a direct note write ===");
await page.evaluate(() => document.getElementById("hidden-input").focus());
await page.keyboard.type("echo 'C5 0.10' > /dev/audio/note");
await page.keyboard.press("Enter");
await page.waitForTimeout(1500);
let t = await page.evaluate(() => document.getElementById("terminal").innerText);
const err = t.match(/audio[^\n]*error[^\n]*/i) || t.match(/Error[^\n]*/);
console.log("note write result:", err ? err[0] : "(no error shown)");
// audio log
await page.evaluate(() => document.getElementById("hidden-input").focus());
await page.keyboard.type("cat /dev/audio/log");
await page.keyboard.press("Enter");
await page.waitForTimeout(1500);
t = await page.evaluate(() => document.getElementById("terminal").innerText);
const al = t.split("\n").filter((l) => /note|sound|play|context|error/i.test(l));
console.log("audio log:", al.slice(-6).join(" | "));
await browser.close();
