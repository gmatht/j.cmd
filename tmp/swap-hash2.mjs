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
await page.waitForTimeout(15000);
await page.keyboard.press("q");
await page.waitForTimeout(3000);
await page.evaluate(() => document.getElementById("hidden-input").focus());
await page.keyboard.type("cat /dev/webgl/log");
await page.keyboard.press("Enter");
await page.waitForTimeout(2000);
const t = await page.evaluate(() => document.getElementById("terminal").innerText);
const i = t.lastIndexOf("cat /dev/webgl/log");
const sec = t.slice(i);
const hashes = (sec.match(/\[swap-hash\] (-?\d+) hadFrame=(\w+)/g) || []);
console.log("swap-hash lines:", hashes.length);
const uniq = [...new Set(hashes)];
console.log("unique:", uniq.length);
console.log(uniq.slice(0, 12).join("\n"));
await browser.close();
