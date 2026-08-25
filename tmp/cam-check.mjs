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
await page.waitForTimeout(18000);
async function cam() {
  return await page.evaluate(() => {
    const c = document.querySelector("canvas");
    if (!c) return "none";
    // read the camera via the shell? No — read the uniform via the device read
    return "canvas-present";
  });
}
// read /dev/webgl/uniform/3f/uCamPos via the shell
async function readCam() {
  await page.evaluate(() => document.getElementById("hidden-input").focus());
  await page.keyboard.type("cat /dev/webgl/uniform/3f/uCamPos");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  const t = await page.evaluate(() => document.getElementById("terminal").innerText);
  const m = t.match(/uCamPos[^\n]*\n([^\n]*)/);
  return m ? m[1].trim() : "(none)";
}
for (let i = 0; i < 5; i++) {
  console.log("cam t+" + (i*2) + "s:", await readCam());
  await page.waitForTimeout(2000);
}
await browser.close();
