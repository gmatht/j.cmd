// Screenshot settings + frame1 as PNGs (via canvas.toDataURL) and compute similarity
import { chromium } from "/home/user/node_modules/playwright/index.mjs";
import { writeFileSync, mkdirSync } from "fs";

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
await page.waitForTimeout(16000);

// grab canvas as PNG dataURL
async function grab() {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    return canvas.toDataURL("image/png");
  });
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

// settings menu
const menuPng = await grab();
writeFileSync(OUT + "/settings-canvas.png", menuPng);
// full-page settings shot
await page.screenshot({ path: OUT + "/settings-page.png" });

// press SPACE, capture frame 1
await page.keyboard.press("Space");
await page.waitForTimeout(1500);
const f1Png = await grab();
writeFileSync(OUT + "/frame1-canvas.png", f1Png);
await page.screenshot({ path: OUT + "/frame1-page.png" });

// read the canvas pixels for similarity (from the PNG via a fresh page is overkill — use readPixels)
async function grabPx() {
  return await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("webgl2");
    const W = canvas.width, H = canvas.height;
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { W, H, px: Array.from(px) };
  });
}
// we already pressed SPACE; capture frame1 pixels now
const f1px = await grabPx();
writeFileSync(OUT + "/frame1-pixels.json", JSON.stringify({ W: f1px.W, H: f1px.H, px: f1px.px }));
console.log("frame1 pixels saved; size", f1px.W + "x" + f1px.H);
await browser.close();
