// Press q to quit the game, then read /tmp/smdebug.txt via the shell
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

async function run(cmd, waitMs = 5000) {
  await page.evaluate(() => document.getElementById("hidden-input").focus());
  await page.keyboard.type(cmd);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(waitMs);
  return await page.evaluate(() => document.getElementById("terminal").innerText);
}

await page.evaluate(() => document.getElementById("hidden-input").focus());
await page.keyboard.type("mimecroft.sh");
await page.keyboard.press("Enter");
await page.waitForTimeout(12000);

// press q to quit the game
await page.keyboard.press("q");
await page.waitForTimeout(5000);

let t = await run("cat /tmp/smdebug.txt", 4000);
console.log("=== /tmp/smdebug.txt ===");
console.log(t.slice(-3000));

await browser.close();
