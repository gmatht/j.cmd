// Inspect page state after running mimecroft.sh: canvas, key queue, tasks
import { chromium } from "/home/user/node_modules/playwright/index.mjs";

const URL = process.env.URL || "http://localhost:8050/index.html";
const browser = await chromium.launch({
  headless: false,
  executablePath: "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (msg) => console.log("[console]", msg.type(), msg.text().slice(0, 300)));
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 800)));

await page.goto(URL, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("#hidden-input", { state: "attached", timeout: 30000 });
await page.waitForTimeout(3000);

await page.evaluate(() => document.getElementById("hidden-input").focus());
await page.keyboard.type("mimecroft.sh");
await page.keyboard.press("Enter");
await page.waitForTimeout(12000);

const state = await page.evaluate(() => {
  const canvas = document.querySelector("canvas");
  const dev = window.__webgldev;
  return {
    canvasDisplay: canvas ? getComputedStyle(canvas).display : "no canvas",
    canvasSize: canvas ? canvas.width + "x" + canvas.height : null,
    shellTasks: window.__shellTasks ? [...window.__shellTasks.keys()] : "n/a",
    bgJobs: window.__bgJobs ? "n/a" : "n/a",
    // try to reach the webgl device internals via the fs
    hasWebglDev: !!dev,
  };
});
console.log("STATE:", JSON.stringify(state, null, 2));

// screenshot
await page.screenshot({ path: "/root/src/sh2runtime/tmp/shot1.png" });
console.log("screenshot saved");

// press space and check the key queue via the device
await page.keyboard.press("Space");
await page.waitForTimeout(2000);
const after = await page.evaluate(() => {
  const canvas = document.querySelector("canvas");
  return { canvasDisplay: canvas ? getComputedStyle(canvas).display : "none" };
});
console.log("after space:", JSON.stringify(after));
await page.screenshot({ path: "/root/src/sh2runtime/tmp/shot2.png" });
await browser.close();
