// Profile the game during movement (renders happen per move)
import { chromium } from "/home/user/node_modules/playwright/index.mjs";

const browser = await chromium.launch({
  headless: false,
  executablePath: "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto("http://127.0.0.1:8060/www/", { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("#hidden-input", { state: "attached", timeout: 30000 });
await page.waitForTimeout(3000);
await page.evaluate(() => document.getElementById("hidden-input").focus());
await page.keyboard.type("MIMEcroft.sh");
await page.keyboard.press("Enter");
await page.waitForTimeout(16000);
await page.keyboard.press("Space");
// wait for ready
const t0 = Date.now();
while (Date.now() - t0 < 90000) {
  await page.waitForTimeout(500);
  const t = await page.evaluate(() => document.getElementById("terminal").innerText);
  if (t.includes("ready.")) break;
}
// move continuously for ~8s (w,s,a,d, arrows) to force renders
const moves = ["w", "a", "s", "d", "ArrowLeft", "ArrowRight", "w", "d", "s", "a"];
const t1 = Date.now();
while (Date.now() - t1 < 8000) {
  await page.keyboard.press(moves[Math.floor(Math.random() * moves.length)]);
  await page.waitForTimeout(250);
}
await page.keyboard.press("q");
await page.waitForTimeout(3000);
const t = await page.evaluate(() => document.getElementById("terminal").innerText);
const stats = t.match(/#stats:[^\n]*/g);
console.log(stats ? stats.slice(0, 4).join("\n") : "(no stats)");
await browser.close();
