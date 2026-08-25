// Verify the AI preview shows behind the menu
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

async function snap() {
  return await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return { canvas: "none" };
    const gl = canvas.getContext("webgl") || canvas.getContext("webgl2");
    const W = canvas.width, H = canvas.height;
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const at = (x, y) => { const i = (y * W + x) * 4; return [px[i], px[i+1], px[i+2]]; };
    // 3D area: the top-right corner (away from the menu card)
    let nonBlack = 0, sum = 0;
    for (let y = 10; y < 150; y += 2) for (let x = W - 160; x < W - 10; x += 2) {
      const [r,g,b] = at(x, y);
      if (r > 15 || g > 15 || b > 15) nonBlack++;
      sum += r + g + b;
    }
    // menu card area: the SETTINGS title (bright text)
    const ty = Math.floor((1 - (1750/1000 - 1)) / 2 * H);
    const tx = Math.floor((840/1000 - 1 + 1) / 2 * W);
    let cardBright = 0;
    for (let y = ty - 20; y <= ty + 20; y++) for (let x = tx - 80; x <= tx + 80; x++) {
      const [r,g,b] = at(x, y);
      if (r > 150 && g > 150 && b > 150) cardBright++;
    }
    return { W, H, threeDNonBlack: nonBlack, threeDSum: sum, cardBright };
  });
}
const a = await snap();
await page.waitForTimeout(2500);
const b = await snap();
console.log("snap1:", JSON.stringify(a));
console.log("snap2:", JSON.stringify(b));
console.log("3D visible:", a.threeDNonBlack > 50, "| AI moving:", a.threeDSum !== b.threeDSum, "| menu card bright:", a.cardBright > 100);
await browser.close();
