// Check the flash shader + flash rendering
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
await page.waitForTimeout(16000);
await page.keyboard.press("Space");
const t0 = Date.now();
while (Date.now() - t0 < 90000) { await page.waitForTimeout(400); const t = await page.evaluate(() => document.getElementById("terminal").innerText); if (t.includes("ready.")) break; }
// shoot several times and sample the flash region repeatedly
let bestYellow = 0, bestS = null;
for (let shot = 0; shot < 6; shot++) {
  await page.keyboard.press("Space");
  for (let f = 0; f < 4; f++) {
    await page.waitForTimeout(30);
    const s = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      const gl = canvas.getContext("webgl") || canvas.getContext("webgl2");
      const W = canvas.width, H = canvas.height;
      const px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const at = (x, y) => { const i = (y * W + x) * 4; return [px[i], px[i+1], px[i+2]]; };
      // scan a region around the barrel for the brightest yellow
      const cx = Math.floor((0.55 + 1) / 2 * W), cy = Math.floor((1 - (-0.08)) / 2 * H);
      let best = 0, bx = -1, by = -1;
      for (let y = cy - 60; y <= cy + 60; y += 3) for (let x = cx - 60; x <= cx + 60; x += 3) {
        const [r,g,b] = at(x, y);
        const yl = r - b;
        if (yl > best) { best = yl; bx = x; by = y; }
      }
      return { best, bx, by };
    });
    if (s.best > bestYellow) { bestYellow = s.best; bestS = s; }
  }
}
console.log("best yellow in flash region:", JSON.stringify(bestS));
// also grab the device log for flash shader status
await page.keyboard.press("q");
await page.waitForTimeout(2000);
await page.evaluate(() => document.getElementById("hidden-input").focus());
await page.keyboard.type("cat /dev/webgl/log");
await page.keyboard.press("Enter");
await page.waitForTimeout(2000);
const t = await page.evaluate(() => document.getElementById("terminal").innerText);
const logLines = t.split("\n").filter((l) => /flash|shader|FAILED|error/i.test(l));
console.log("log flash/shader lines:", logLines.slice(-8).join(" | "));
await browser.close();
