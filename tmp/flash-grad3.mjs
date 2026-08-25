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
// fire and capture every 20ms for 300ms, keeping the best flash frame + its gradient
await page.keyboard.press("Space");
let best = null;
for (let f = 0; f < 16; f++) {
  await page.waitForTimeout(20);
  const s = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("webgl2");
    const W = canvas.width, H = canvas.height;
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const at = (x, y) => { const i = (y * W + x) * 4; return [px[i], px[i+1], px[i+2]]; };
    const cx = Math.floor((0.55 + 1) / 2 * W), cy = Math.floor((1 - (-0.08)) / 2 * H);
    let bestY = -999, bx = cx, by = cy;
    for (let y = cy - 70; y <= cy + 70; y += 2) for (let x = cx - 70; x <= cx + 70; x += 2) {
      const [r,g,b] = at(x, y); const yl = r - b;
      if (yl > bestY) { bestY = yl; bx = x; by = y; }
    }
    // gradient from the found center
    const grad = [];
    for (let dx = 0; dx <= 62; dx += 4) { const [r,g,b] = at(bx + dx, by); grad.push([dx, r, g, b, r - b]); }
    return { bestY, bx, by, grad };
  });
  if (s.bestY > (best ? best.bestY : -999)) best = s;
}
console.log("best frame: center", best.bx + "," + best.by, "bestYellow:", best.bestY);
for (const [dx, r, g, b, yl] of best.grad) console.log(`dx=${String(dx).padStart(2)} rgb=${r},${g},${b} yellow=${yl}`);
await browser.close();
