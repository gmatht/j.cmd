// Test string slicing in the browser shell
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

async function run(cmd, waitMs = 5000) {
  await page.evaluate(() => document.getElementById("hidden-input").focus());
  await page.keyboard.type(cmd);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(waitMs);
  return await page.evaluate(() => document.getElementById("terminal").innerText);
}

console.log("=== test1: slice with literal index ===");
let t = await run('s=SETTINGS; echo ${s:0:1}${s:3:1}${s:6:1}');
console.log(t.slice(-300));

console.log("=== test2: slice in a loop (like draw_text) ===");
t = await run('s=SETTINGS; i=0; while [ $i -lt 4 ]; do echo -n ${s:$i:1}; i=$((i+1)); done; echo');
console.log(t.slice(-300));

await browser.close();
