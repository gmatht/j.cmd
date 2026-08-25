// Verify rebrand: MIMEcroft.sh in terminal + ?demo=MIMEcroft.sh in URL
import { chromium } from "/home/user/node_modules/playwright/index.mjs";

const browser = await chromium.launch({
  headless: false,
  executablePath: "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 500)));

// ── TEST 1: MIMEcroft.sh in the terminal ──
await page.goto("http://127.0.0.1:8060/www/", { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("#hidden-input", { state: "attached", timeout: 30000 });
await page.waitForTimeout(3000);
await page.evaluate(() => document.getElementById("hidden-input").focus());
await page.keyboard.type("MIMEcroft.sh");
await page.keyboard.press("Enter");
await page.waitForTimeout(12000);
// press q to quit the settings menu
await page.keyboard.press("q");
await page.waitForTimeout(5000);
let t = await page.evaluate(() => document.getElementById("terminal").innerText);
console.log("TEST1 MIMEcroft.sh in terminal:");
console.log("  banner:", t.includes("MIMEcrofT v6.1"));
console.log("  map rows:", /MIMEcroft  artifacts/.test(t));
console.log("  == Quit.:", t.includes("== Quit."));
console.log("  GAME DONE:", t.includes("GAME DONE"));

// ── TEST 2: ?demo=MIMEcroft.sh in the URL ──
const page2 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page2.on("pageerror", (e) => console.log("[pageerror2]", String(e).slice(0, 500)));
await page2.goto("http://127.0.0.1:8060/www/?demo=MIMEcroft.sh", { waitUntil: "load", timeout: 60000 });
await page2.waitForSelector("#hidden-input", { state: "attached", timeout: 30000 });
const t0 = Date.now();
let last = "";
while (Date.now() - t0 < 60000) {
  await page2.waitForTimeout(3000);
  last = await page2.evaluate(() => document.getElementById("terminal").innerText);
  if (/GAME DONE/.test(last)) break;
}
console.log("TEST2 ?demo=MIMEcroft.sh:");
console.log("  map rows:", /MIMEcroft  artifacts/.test(last));
console.log("  #stats:", /#stats:/.test(last));
console.log("  GAME DONE:", /GAME DONE/.test(last));

await browser.close();
