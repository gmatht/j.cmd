// Test: file redirects in the browser terminal
import { chromium } from "/home/user/node_modules/playwright/index.mjs";

const URL = process.env.URL || "http://localhost:8050/index.html";
const browser = await chromium.launch({
  headless: false,
  executablePath: "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (msg) => console.log("[console]", msg.type(), msg.text().slice(0, 500)));
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 800)));

await page.goto(URL, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("#hidden-input", { state: "attached", timeout: 30000 });
await page.waitForTimeout(3000);

async function run(cmd, waitMs = 6000) {
  await page.evaluate(() => document.getElementById("hidden-input").focus());
  await page.keyboard.type(cmd);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(waitMs);
  const text = await page.evaluate(() => document.getElementById("terminal").innerText);
  return text;
}

console.log("=== TEST 1: echo redirect to file ===");
let t = await run("echo hello > /tmp/t1.txt; cat /tmp/t1.txt");
console.log(t.slice(-800));

console.log("=== TEST 2: append redirect ===");
t = await run("echo world >> /tmp/t1.txt; cat /tmp/t1.txt");
console.log(t.slice(-800));

console.log("=== TEST 3: redirect inside a function ===");
t = await run("f() { echo inside > /tmp/t2.txt; }; f; cat /tmp/t2.txt");
console.log(t.slice(-800));

await browser.close();
