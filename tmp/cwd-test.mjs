// Verify: no ?cwd=/home added; cd to other dirs still adds ?cwd=
import { chromium } from "/home/user/node_modules/playwright/index.mjs";

const browser = await chromium.launch({
  headless: false,
  executablePath: "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

// TEST 1: demo URL should not gain ?cwd=/home
await page.goto("http://127.0.0.1:8060/www/?demo=MIMEcroft.sh", { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("#hidden-input", { state: "attached", timeout: 30000 });
await page.waitForTimeout(5000);
let url = page.url();
console.log("TEST1 demo URL after boot:", url);
console.log("  has cwd=/home:", url.includes("cwd=%2Fhome") || url.includes("cwd=/home"));

// TEST 2: plain boot, then cd to /tmp — should add ?cwd=/tmp
await page.goto("http://127.0.0.1:8060/www/", { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("#hidden-input", { state: "attached", timeout: 30000 });
await page.waitForTimeout(3000);
url = page.url();
console.log("TEST2 plain boot URL:", url);
console.log("  has cwd=/home:", url.includes("cwd=%2Fhome") || url.includes("cwd=/home"));
await page.evaluate(() => document.getElementById("hidden-input").focus());
await page.keyboard.type("cd /tmp");
await page.keyboard.press("Enter");
await page.waitForTimeout(3000);
url = page.url();
console.log("  after cd /tmp URL:", url);
console.log("  has cwd=/tmp:", url.includes("cwd=%2Ftmp") || url.includes("cwd=/tmp"));

// TEST 3: cd back to /home — should drop the cwd param
await page.evaluate(() => document.getElementById("hidden-input").focus());
await page.keyboard.type("cd /home");
await page.keyboard.press("Enter");
await page.waitForTimeout(3000);
url = page.url();
console.log("  after cd /home URL:", url);
console.log("  has cwd=/home:", url.includes("cwd=%2Fhome") || url.includes("cwd=/home"));

await browser.close();
