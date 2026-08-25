// Screenshot the settings screen + frame 1, compute similarity
import { chromium } from "/home/user/node_modules/playwright/index.mjs";
import { writeFileSync, existsSync, mkdirSync } from "fs";

const OUT = "/root/src/sh2runtime/tmp/shots";
mkdirSync(OUT, { recursive: true });

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
// wait for the settings menu to be fully drawn (textures loaded, thumbnails shown)
await page.waitForTimeout(16000);

// capture the canvas only (the 3D view), not the whole page
async function grabCanvas() {
  return await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("webgl2");
    const W = canvas.width, H = canvas.height;
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { W, H, px: Array.from(px) };
  });
}
const menu = await grabCanvas();
writeFileSync(OUT + "/settings-canvas.json", JSON.stringify({ W: menu.W, H: menu.H, px: menu.px }));
console.log("settings captured:", menu.W + "x" + menu.H);

// press SPACE to start the game; capture frame 1 (before any move)
await page.keyboard.press("Space");
await page.waitForTimeout(1500);
const frame1 = await grabCanvas();
writeFileSync(OUT + "/frame1-canvas.json", JSON.stringify({ W: frame1.W, H: frame1.H, px: frame1.px }));
console.log("frame1 captured:", frame1.W + "x" + frame1.H);

// also take full-page screenshots for the doc
await page.screenshot({ path: OUT + "/frame1-page.png" });
console.log("frame1 page shot saved");

// recompute the settings screenshot while still in the menu for the page shot
await browser.close();
