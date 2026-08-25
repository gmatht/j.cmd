// Check settings menu texture thumbnails (edges) + preload + demo
import { chromium } from "/home/user/node_modules/playwright/index.mjs";

const browser = await chromium.launch({
  headless: false,
  executablePath: "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

// 1. settings menu thumbnails: run game, stay in menu, analyze canvas edges
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto("http://127.0.0.1:8060/www/", { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("#hidden-input", { state: "attached", timeout: 30000 });
await page.waitForTimeout(3000);
await page.evaluate(() => document.getElementById("hidden-input").focus());
await page.keyboard.type("MIMEcroft.sh");
await page.keyboard.press("Enter");
await page.waitForTimeout(15000);
const menu = await page.evaluate(() => {
  const canvas = document.querySelector("canvas");
  const gl = canvas.getContext("webgl") || canvas.getContext("webgl2");
  const W = canvas.width, H = canvas.height;
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const at = (x, y) => {
    const i = (y * W + x) * 4;
    return [px[i], px[i + 1], px[i + 2]];
  };
  // count colorful pixels in the LEFT and RIGHT edge strips (thumbnails)
  const edge = (x0, x1) => {
    let colorful = 0;
    for (let y = 0; y < H; y += 3) {
      for (let x = x0; x < x1; x += 2) {
        const [r, g, b] = at(x, y);
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mx - mn > 30 && mx > 60) colorful++;
      }
    }
    return colorful;
  };
  return { leftEdge: edge(0, 80), rightEdge: edge(W - 80, W), W, H };
});
console.log("menu thumbnails (colorful px in edges):", JSON.stringify(menu));
await page.keyboard.press("q");
await page.waitForTimeout(2000);
await page.close();

// 2. demo still works
const page2 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page2.goto("http://127.0.0.1:8060/www/?demo=MIMEcroft.sh", { waitUntil: "load", timeout: 60000 });
await page2.waitForSelector("#hidden-input", { state: "attached", timeout: 30000 });
const t0 = Date.now();
let last = "";
while (Date.now() - t0 < 60000) {
  await page2.waitForTimeout(3000);
  last = await page2.evaluate(() => document.getElementById("terminal").innerText);
  if (/GAME DONE/.test(last)) break;
}
const stats = last.match(/#stats: frames=\d+ time=\d+ms avg=\d+ms\/frame/);
console.log("demo:", { map: /MIMEcroft  artifacts/.test(last), stats: stats ? stats[0] : null, done: /GAME DONE/.test(last) });
await browser.close();
