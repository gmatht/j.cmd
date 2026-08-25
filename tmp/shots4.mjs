// Capture settings + TRUE frame 1 (after "ready.", before any move)
import { chromium } from "/home/user/node_modules/playwright/index.mjs";
import { writeFileSync, mkdirSync } from "fs";

const OUT = "/root/src/sh2runtime/tmp/shots2";
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

async function grab() {
  return await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("webgl2");
    const W = canvas.width, H = canvas.height;
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const dataUrl = canvas.toDataURL("image/png");
    return { W, H, px: Array.from(px), png: dataUrl.split(",")[1] };
  });
}

// settings menu
const menu = await grab();
writeFileSync(OUT + "/settings-canvas.png", Buffer.from(menu.png, "base64"));
writeFileSync(OUT + "/settings-pixels.json", JSON.stringify({ W: menu.W, H: menu.H, px: menu.px }));
await page.screenshot({ path: OUT + "/settings-page.png" });
console.log("settings captured");

// SPACE → wait for the game loop to actually start ("ready.")
await page.keyboard.press("Space");
console.log("waiting for ready...");
const t0 = Date.now();
let ready = false;
while (Date.now() - t0 < 90000) {
  await page.waitForTimeout(1000);
  const t = await page.evaluate(() => document.getElementById("terminal").innerText);
  if (t.includes("ready.")) { ready = true; break; }
}
console.log("ready after", ((Date.now() - t0) / 1000).toFixed(1), "s:", ready);
// capture frame 1 immediately (before any move)
const f1 = await grab();
writeFileSync(OUT + "/frame1-canvas.png", Buffer.from(f1.png, "base64"));
writeFileSync(OUT + "/frame1-pixels.json", JSON.stringify({ W: f1.W, H: f1.H, px: f1.px }));
await page.screenshot({ path: OUT + "/frame1-page.png" });
console.log("frame1 captured after ready");

// ── similarity ──
const a = new Uint8Array(menu.px), b = new Uint8Array(f1.px);
const W = menu.W, H = menu.H;
let identical = 0, near = 0;
for (let i = 0; i < a.length; i += 4) {
  if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) identical++;
  else {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (d < 30) near++;
  }
}
const tot = W * H;
const RCOLS = 8, RROWS = 6;
const regions = [];
for (let ry = 0; ry < RROWS; ry++) {
  for (let rx = 0; rx < RCOLS; rx++) {
    let same = 0, t = 0;
    for (let y = Math.floor(ry * H / RROWS); y < Math.floor((ry + 1) * H / RROWS); y++) {
      for (let x = Math.floor(rx * W / RCOLS); x < Math.floor((rx + 1) * W / RCOLS); x++) {
        const i = (y * W + x) * 4; t++;
        if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) same++;
      }
    }
    regions.push({ row: ry, col: rx, pct: +(same / t * 100).toFixed(1) });
  }
}
const result = { size: W + "x" + H, identicalPct: +(identical / tot * 100).toFixed(2), nearPct: +((identical + near) / tot * 100).toFixed(2), regions };
writeFileSync(OUT + "/similarity.json", JSON.stringify(result, null, 1));
console.log("SIMILARITY:", JSON.stringify(result, null, 1));
await browser.close();
