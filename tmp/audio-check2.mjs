import { chromium } from "/home/user/node_modules/playwright/index.mjs";
const browser = await chromium.launch({
  headless: false,
  executablePath: "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
await page.goto("http://127.0.0.1:8060/www/?demo=MIMEcroft.sh", { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("#hidden-input", { state: "attached", timeout: 30000 });
const t0 = Date.now();
let term = "";
while (Date.now() - t0 < 90000) { await page.waitForTimeout(800); term = await page.evaluate(() => document.getElementById("terminal").innerText); if (term.includes("GAME DONE")) break; }
// read the audio log via the shell after the demo ends
await page.evaluate(() => document.getElementById("hidden-input").focus());
await page.keyboard.type("cat /dev/audio/log");
await page.keyboard.press("Enter");
await page.waitForTimeout(2000);
term = await page.evaluate(() => document.getElementById("terminal").innerText);
const log = term.split("\n").filter((l) => /\[audio\]|note|played|context|suspended|resume/i.test(l));
console.log("audio log lines:", log.slice(-12).join("\n") || "(none)");
// did the demo find a treasure?
console.log("TREASURE FOUND:", term.includes("TREASURE FOUND"));
console.log("score line:", (term.match(/Score \d+/g) || []).pop());
await browser.close();
