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
await page.keyboard.type("mimecroft.sh");
await page.keyboard.press("Enter");
await page.waitForTimeout(12000);
await page.keyboard.press("q");
await page.waitForTimeout(5000);
const t = await page.evaluate(() => document.getElementById("terminal").innerText);
console.log("lowercase mimecroft.sh still works:");
console.log("  banner:", t.includes("MIMEcrofT v6.1"));
console.log("  == Quit.:", t.includes("== Quit."));
console.log("  GAME DONE:", t.includes("GAME DONE"));
await browser.close();
