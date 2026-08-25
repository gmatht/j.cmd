// Verify CMD popup lists MIMEcroft.sh
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

// open the CMD popup
await page.click("#tb-cmd");
await page.waitForTimeout(2000);
const names = await page.evaluate(() => {
  const btns = document.querySelectorAll("#tb-cmd-pop .tb-cmd-btn .tb-cmd-name");
  return [...btns].map((b) => b.textContent);
});
console.log("CMD popup has MIMEcroft.sh:", names.includes("MIMEcroft.sh"));
console.log("CMD popup has mimecroft.sh:", names.includes("mimecroft.sh"));
console.log("total commands:", names.length);
await browser.close();
