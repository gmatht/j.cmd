// Color histogram of the 3D view after starting the game
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
await page.waitForTimeout(12000);
await page.keyboard.press("Space");
await page.waitForTimeout(4000);
// move forward 3 times so the view re-renders
for (let i = 0; i < 3; i++) {
  await page.keyboard.press("w");
  await page.waitForTimeout(600);
}
await page.waitForTimeout(2000);

const res = await page.evaluate(() => {
  const canvas = document.querySelector("canvas");
  const gl = canvas.getContext("webgl") || canvas.getContext("webgl2");
  const W = canvas.width, H = canvas.height;
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  // histogram: bucket colors by quantized rgb
  const hist = {};
  const counts = { black: 0, white: 0, gray: 0, color: 0, other: 0 };
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    if (r < 10 && g < 10 && b < 10) { counts.black++; continue; }
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max > 240 && min > 220) { counts.white++; continue; }
    if (max - min < 20) { counts.gray++; continue; }
    if (max - min > 40) { counts.color++; }
    else counts.other++;
    const key = (r >> 4) + "," + (g >> 4) + "," + (b >> 4);
    hist[key] = (hist[key] || 0) + 1;
  }
  // top color buckets (excluding grays)
  const top = Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 12);
  return { counts, top };
});
console.log(JSON.stringify(res, null, 1));
await browser.close();
