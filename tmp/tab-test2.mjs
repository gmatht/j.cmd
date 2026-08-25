// Check /bin contents and tab completion, one test per fresh page
import { chromium } from "/home/user/node_modules/playwright/index.mjs";

const browser = await chromium.launch({
  headless: false,
  executablePath: "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

async function freshPage() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto("http://127.0.0.1:8060/www/", { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector("#hidden-input", { state: "attached", timeout: 30000 });
  await page.waitForTimeout(3000);
  return page;
}

// 1. list /bin via the shell
let page = await freshPage();
await page.evaluate(() => document.getElementById("hidden-input").focus());
await page.keyboard.type("ls /bin");
await page.keyboard.press("Enter");
await page.waitForTimeout(3000);
let t = await page.evaluate(() => document.getElementById("terminal").innerText);
console.log("=== ls /bin (tail) ===");
console.log(t.slice(-600));
await page.close();

// 2. M<Tab> on a fresh page
page = await freshPage();
await page.evaluate(() => document.getElementById("hidden-input").focus());
await page.keyboard.type("M");
await page.keyboard.press("Tab");
await page.waitForTimeout(1500);
t = await page.evaluate(() => {
  const el = document.getElementById("input-span");
  return el ? el.textContent : "";
});
console.log("=== M<Tab> input line:", JSON.stringify(t));
await page.close();

// 3. m<Tab> on a fresh page
page = await freshPage();
await page.evaluate(() => document.getElementById("hidden-input").focus());
await page.keyboard.type("m");
await page.keyboard.press("Tab");
await page.waitForTimeout(1500);
t = await page.evaluate(() => {
  const el = document.getElementById("input-span");
  return el ? el.textContent : "";
});
console.log("=== m<Tab> input line:", JSON.stringify(t));
await page.close();

await browser.close();
