// Check if mimecroft.sh is still running after the banner (settings menu active?)
import { chromium } from "/home/user/node_modules/playwright/index.mjs";

const URL = process.env.URL || "http://localhost:8050/index.html";
const browser = await chromium.launch({
  headless: false,
  executablePath: "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (msg) => console.log("[console]", msg.type(), msg.text().slice(0, 500)));
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 1000)));

await page.goto(URL, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("#hidden-input", { state: "attached", timeout: 30000 });
await page.waitForTimeout(3000);

await page.evaluate(() => document.getElementById("hidden-input").focus());
await page.keyboard.type("mimecroft.sh");
await page.keyboard.press("Enter");
await page.waitForTimeout(15000);

const state1 = await page.evaluate(() => {
  const term = document.getElementById("terminal");
  const canvas = document.querySelector("canvas");
  return {
    termTail: term.innerText.slice(-600),
    canvasCount: document.querySelectorAll("canvas").length,
    canvasVisible: canvas ? getComputedStyle(canvas).display : "none",
    keyCallbacks: window.__keyCallbacks ? "yes" : "unknown",
  };
});
console.log("STATE after 15s:", JSON.stringify(state1, null, 2));

// try typing a new command — if the game owns the keyboard, it won't execute
await page.evaluate(() => document.getElementById("hidden-input").focus());
await page.keyboard.type("echo still-alive");
await page.keyboard.press("Enter");
await page.waitForTimeout(3000);
const state2 = await page.evaluate(() => document.getElementById("terminal").innerText.slice(-800));
console.log("=== after typing 'echo still-alive' ===");
console.log(state2);

await browser.close();
