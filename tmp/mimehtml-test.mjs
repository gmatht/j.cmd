// Verify mimecroft.html loads and its demo link auto-starts the game
import { chromium } from "/home/user/node_modules/playwright/index.mjs";

const browser = await chromium.launch({
  headless: false,
  executablePath: "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

// 1. mimecroft.html page itself
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto("http://127.0.0.1:8060/www/MIMEcroft.html", { waitUntil: "load", timeout: 60000 });
const h1 = await page.textContent("h1");
const playHref = await page.getAttribute(".play a.big", "href");
console.log("mimecroft.html h1:", JSON.stringify(h1));
console.log("play link href:", playHref);

// 2. follow the demo link — game should auto-start and complete
const page2 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page2.goto("http://127.0.0.1:8060/www/index.html?demo=MIMEcroft.sh", { waitUntil: "load", timeout: 60000 });
await page2.waitForSelector("#hidden-input", { state: "attached", timeout: 30000 });
const t0 = Date.now();
let last = "";
while (Date.now() - t0 < 60000) {
  await page2.waitForTimeout(3000);
  last = await page2.evaluate(() => document.getElementById("terminal").innerText);
  if (/GAME DONE/.test(last)) break;
}
console.log("demo from mimecroft.html link:");
console.log("  map rows:", /MIMEcroft  artifacts/.test(last));
console.log("  #stats:", /#stats:/.test(last));
console.log("  GAME DONE:", /GAME DONE/.test(last));
await browser.close();
