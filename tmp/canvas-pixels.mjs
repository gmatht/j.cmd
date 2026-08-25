// Analyze canvas pixels to see what the game drew
import { chromium } from "/home/user/node_modules/playwright/index.mjs";

const URL = process.env.URL || "http://localhost:8050/index.html";
const browser = await chromium.launch({
  headless: false,
  executablePath: "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(URL, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("#hidden-input", { state: "attached", timeout: 30000 });
await page.waitForTimeout(3000);

await page.evaluate(() => document.getElementById("hidden-input").focus());
await page.keyboard.type("mimecroft.sh");
await page.keyboard.press("Enter");
await page.waitForTimeout(12000);

const analysis = await page.evaluate(() => {
  const canvas = document.querySelector("canvas");
  const gl = canvas.getContext("webgl") || canvas.getContext("webgl2");
  const out = { width: canvas.width, height: canvas.height };
  if (gl) {
    const px = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // sample some pixels: center, corners, and count distinct colors
    const sample = (x, y) => {
      const i = (y * canvas.width + x) * 4;
      return [px[i], px[i + 1], px[i + 2], px[i + 3]];
    };
    out.center = sample(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2));
    out.tl = sample(10, 10);
    out.tr = sample(canvas.width - 10, 10);
    out.bl = sample(10, canvas.height - 10);
    out.br = sample(canvas.width - 10, canvas.height - 10);
    // count non-black pixels
    let nonBlack = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] > 8 || px[i + 1] > 8 || px[i + 2] > 8) nonBlack++;
    }
    out.nonBlackPixels = nonBlack;
    out.totalPixels = px.length / 4;
  } else {
    out.gl = "no context";
  }
  return out;
});
console.log("CANVAS:", JSON.stringify(analysis, null, 2));
await browser.close();
