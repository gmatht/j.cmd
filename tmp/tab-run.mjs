// Verify M<Tab> completes to MIMEcroft.sh and the completed command runs
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

// type M, press Tab, inspect the line
await page.evaluate(() => document.getElementById("hidden-input").focus());
await page.keyboard.type("M");
await page.keyboard.press("Tab");
await page.waitForTimeout(1500);
const line = await page.evaluate(() => {
  const el = document.getElementById("input-span");
  return el ? el.textContent : "";
});
console.log("input line after M<Tab>:", JSON.stringify(line));

// press Enter to run the completed command
await page.keyboard.press("Enter");
await page.waitForTimeout(12000);
await page.keyboard.press("q");
await page.waitForTimeout(5000);
const t = await page.evaluate(() => document.getElementById("terminal").innerText);
console.log("after running completed command:");
console.log("  banner:", t.includes("MIMEcrofT v6.1"));
console.log("  == Quit.:", t.includes("== Quit."));
console.log("  GAME DONE:", t.includes("GAME DONE"));
await browser.close();
