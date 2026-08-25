// Read /dev/webgl/log properly — capture the log section of terminal text
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
await page.waitForTimeout(12000);
await page.keyboard.press("Space");
await page.waitForTimeout(6000);
await page.keyboard.press("q");
await page.waitForTimeout(5000);

async function run(cmd) {
  await page.evaluate(() => document.getElementById("hidden-input").focus());
  await page.keyboard.type(cmd);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3000);
  return await page.evaluate(() => document.getElementById("terminal").innerText);
}
const t = await run("cat /dev/webgl/log");
const logIdx = t.lastIndexOf("shader");
console.log("=== log content (from shader mentions) ===");
console.log(t.slice(logIdx - 200, logIdx + 2000));
await browser.close();
