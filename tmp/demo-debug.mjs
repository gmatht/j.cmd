// Debug: why doesn't ?demo=mimecroft.sh auto-run?
import { chromium } from "/home/user/node_modules/playwright/index.mjs";

const browser = await chromium.launch({
  headless: false,
  executablePath: "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (msg) => console.log("[console]", msg.type(), msg.text().slice(0, 400)));
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 800)));

await page.goto("http://localhost:8050/index.html?demo=mimecroft.sh", { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("#hidden-input", { state: "attached", timeout: 30000 });
await page.waitForTimeout(15000);

const text = await page.evaluate(() => document.getElementById("terminal").innerText);
console.log("=== FULL terminal text ===");
console.log(text.slice(-4000));
await browser.close();
