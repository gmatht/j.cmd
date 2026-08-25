// Test: a .sh script with a file redirect, run via the shell (runShellScript path)
import { chromium } from "/home/user/node_modules/playwright/index.mjs";

const URL = process.env.URL || "http://localhost:8050/index.html";
const browser = await chromium.launch({
  headless: false,
  executablePath: "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (msg) => console.log("[console]", msg.type(), msg.text().slice(0, 600)));
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 1000)));

await page.goto(URL, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("#hidden-input", { state: "attached", timeout: 30000 });
await page.waitForTimeout(3000);

async function run(cmd, waitMs = 8000) {
  await page.evaluate(() => document.getElementById("hidden-input").focus());
  await page.keyboard.type(cmd);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(waitMs);
  return await page.evaluate(() => document.getElementById("terminal").innerText);
}

// write a small .sh script with a redirect, then run it
console.log("=== write + run test.sh ===");
let t = await run("echo 'echo SM-A: entered > /tmp/smdebug.txt' > /tmp/test.sh; bash /tmp/test.sh; echo EXIT=$?; cat /tmp/smdebug.txt");
console.log(t.slice(-1200));

console.log("=== run a script that redirects then echoes ===");
t = await run("echo 'echo one > /tmp/t3.txt; echo two; cat /tmp/t3.txt' > /tmp/test2.sh; bash /tmp/test2.sh; echo EXIT=$?");
console.log(t.slice(-1200));

await browser.close();
