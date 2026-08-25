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
let best = null;
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
      const cx = Math.floor((0.55 + 1) / 2 * W), cy = Math.floor((1 - (-0.08)) / 2 * H);
      let bestY = 0, bx = -1, by = -1;
      for (let y = cy - 60; y <= cy + 60; y += 3) for (let x = cx - 60; x <= cx + 60; x += 3) {
        const [r,g,b] = at(x, y); const yl = r - b;
        if (yl > bestY) { bestY = yl; bx = x; by = y; }
      }
      return { bestY, bx, by, W, H };
    });
    if (s.bestY > (best ? best.bestY : 0)) best = s;
  }
}
// sample the gradient from the flash center outward along +x
const grad = await page.evaluate((b) => {
  const canvas = document.querySelector("canvas");
  const gl = canvas.getContext("webgl") || canvas.getContext("webgl2");
  const px = new Uint8Array(b.W * b.H * 4);
  gl.readPixels(0, 0, b.W, b.H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const at = (x, y) => { const i = (y * b.W + x) * 4; return [px[i], px[i+1], px[i+2]]; };
  const out = [];
  for (let dx = 0; dx <= 50; dx += 6) {
    const [r,g,bl] = at(b.bx + dx, b.by);
    out.push([dx, r, g, bl, r - bl]);
  }
  return out;
}, best);
console.log("flash center:", best.bx + "," + best.by, "WxH:", best.W + "x" + best.H);
for (const [dx, r, g, bl, yl] of grad) console.log(`dx=${String(dx).padStart(2)} rgb=${r},${g},${bl} yellow=${yl}`);
await browser.close();
