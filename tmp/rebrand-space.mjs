// Verify: MIMEcroft.sh in terminal, press SPACE to start, map prints
import { chromium } from "/home/user/node_modules/playwright/index.mjs";

const browser = await chromium.launch({
  headless: false,
  executablePath: "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 500)));

await page.goto("http://127.0.0.1:8060/www/", { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("#hidden-input", { state: "attached", timeout: 30000 });
await page.waitForTimeout(3000);
await page.evaluate(() => document.getElementById("hidden-input").focus());
await page.keyboard.type("MIMEcroft.sh");
await page.keyboard.press("Enter");
await page.waitForTimeout(12000);
// press SPACE to start the game (dismiss settings menu)
await page.keyboard.press("Space");
await page.waitForTimeout(15000);
const t = await page.evaluate(() => document.getElementById("terminal").innerText);
console.log("MIMEcroft.sh in terminal (SPACE to start):");
console.log("  banner:", t.includes("MIMEcrofT v6.1"));
console.log("  map rows:", /MIMEcroft  artifacts/.test(t));
console.log("  ready.:", t.includes("ready."));
console.log("  tail:", JSON.stringify(t.slice(-200)));
await browser.close();
