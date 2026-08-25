import { chromium } from "/home/user/node_modules/playwright/index.mjs";
const browser = await chromium.launch({
  headless: false,
  executablePath: "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto("http://127.0.0.1:8060/www/?demo=MIMEcroft.sh", { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("#hidden-input", { state: "attached", timeout: 30000 });
const t0 = Date.now();
while (Date.now() - t0 < 90000) { await page.waitForTimeout(800); const t = await page.evaluate(() => document.getElementById("terminal").innerText); if (t.includes("GAME DONE")) break; }
// read the FULL audio log
await page.evaluate(() => document.getElementById("hidden-input").focus());
await page.keyboard.type("cat /dev/audio/log");
await page.keyboard.press("Enter");
await page.waitForTimeout(2000);
const term = await page.evaluate(() => document.getElementById("terminal").innerText);
// the audio log section — everything after "cat /dev/audio/log"
const i = term.lastIndexOf("cat /dev/audio/log");
const sec = term.slice(i, i + 2000);
console.log(sec.slice(0, 1500));
await browser.close();
