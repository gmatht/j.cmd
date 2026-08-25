// Verify --demo mode still works: open ?demo=mimecroft.sh and check map + stats print
import { chromium } from "/home/user/node_modules/playwright/index.mjs";

const browser = await chromium.launch({
  headless: false,
  executablePath: "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 500)));

await page.goto("http://127.0.0.1:8060/www/?demo=mimecroft.sh", { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("#hidden-input", { state: "attached", timeout: 30000 });
await page.waitForTimeout(3000);

const t0 = Date.now();
let lastText = "";
while (Date.now() - t0 < 60000) {
  await page.waitForTimeout(3000);
  const text = await page.evaluate(() => document.getElementById("terminal").innerText);
  if (text !== lastText) {
    lastText = text;
    console.log("--- t+" + ((Date.now() - t0) / 1000).toFixed(1) + "s ---");
    console.log(text.slice(-1500));
  }
  if (/GAME DONE/.test(text)) break;
}
console.log("=== has map rows:", /MIMEcroft  artifacts/.test(lastText));
console.log("=== has #stats:", /#stats:/.test(lastText));
console.log("=== has GAME DONE:", /GAME DONE/.test(lastText));
await browser.close();
