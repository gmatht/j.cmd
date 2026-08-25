// Compare frame 1 pixels with the pre-change capture (tmp/shots6/frame1-A.png)
import { chromium } from "/home/user/node_modules/playwright/index.mjs";
import { readFileSync, writeFileSync } from "fs";

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
while (Date.now() - t0 < 90000) {
  await page.waitForTimeout(500);
  const t = await page.evaluate(() => document.getElementById("terminal").innerText);
  if (t.includes("ready.")) break;
}
await page.waitForTimeout(2000);
const d = await page.evaluate(() => {
  const canvas = document.querySelector("canvas");
  const gl = canvas.getContext("webgl") || canvas.getContext("webgl2");
  const W = canvas.width, H = canvas.height;
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return { W, H, px: Array.from(px), png: canvas.toDataURL("image/png").split(",")[1] };
});
writeFileSync("/tmp/frame1-new.png", Buffer.from(d.png, "base64"));
writeFileSync("/tmp/frame1-new.json", JSON.stringify({ W: d.W, H: d.H, px: d.px }));

// compare with the pre-change capture
const old = JSON.parse(readFileSync("/root/src/sh2runtime/tmp/shots6/frame1-pixels.json", "utf8"));
const a = new Uint8Array(old.px), b = new Uint8Array(d.px);
const W = d.W, H = d.H;
let identical = 0;
for (let i = 0; i < a.length; i += 4) {
  if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) identical++;
}
console.log("frame1 identical pixels vs pre-change:", (identical / (W * H) * 100).toFixed(2) + "%");
await browser.close();
