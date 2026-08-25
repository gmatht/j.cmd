// Run game, start it, play for 10s, then check stats + terminal
import { chromium } from "/home/user/node_modules/playwright/index.mjs";

const browser = await chromium.launch({
  headless: false,
  executablePath: "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (msg) => console.log("[console]", msg.type(), msg.text().slice(0, 300)));
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 800)));
await page.goto("http://127.0.0.1:8060/www/", { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("#hidden-input", { state: "attached", timeout: 30000 });
await page.waitForTimeout(3000);
await page.evaluate(() => document.getElementById("hidden-input").focus());
await page.keyboard.type("MIMEcroft.sh");
await page.keyboard.press("Enter");
await page.waitForTimeout(12000);
await page.keyboard.press("Space");
console.log("=== SPACE pressed, waiting 12s ===");
await page.waitForTimeout(12000);
await page.keyboard.press("w");
await page.waitForTimeout(2000);
await page.keyboard.press("q");
await page.waitForTimeout(5000);
const t = await page.evaluate(() => document.getElementById("terminal").innerText);
const lines = t.split("\n");
const tail = lines.slice(-45).join("\n");
console.log("=== terminal tail ===");
console.log(tail);
await browser.close();
