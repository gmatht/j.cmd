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
// read the debug file via the shell
await page.evaluate(() => document.getElementById("hidden-input").focus());
await page.keyboard.type("cat /tmp/aidebug.txt");
await page.keyboard.press("Enter");
await page.waitForTimeout(2000);
const t = await page.evaluate(() => document.getElementById("terminal").innerText);
const lines = t.split("\n").filter((l) => l.startsWith("PF:"));
console.log("debug lines:", lines.length);
console.log(lines.slice(0, 12).join("\n"));
console.log("...");
console.log(lines.slice(-6).join("\n"));
await browser.close();
