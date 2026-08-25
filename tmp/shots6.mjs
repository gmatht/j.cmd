// Final clean capture: settings x2, true frame1 x2 (after ready + 2s)
import { chromium } from "/home/user/node_modules/playwright/index.mjs";
import { writeFileSync, mkdirSync } from "fs";

const OUT = "/root/src/sh2runtime/tmp/shots6";
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
await page.waitForTimeout(20000);

async function grab(tag) {
  const d = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("webgl2");
    const W = canvas.width, H = canvas.height;
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { W, H, px: Array.from(px), png: canvas.toDataURL("image/png").split(",")[1] };
  });
  writeFileSync(OUT + "/" + tag + ".png", Buffer.from(d.png, "base64"));
  console.log("captured", tag);
  return d;
}

const sA = await grab("settings-A");
await page.waitForTimeout(2000);
const sB = await grab("settings-B");

await page.keyboard.press("Space");
const t0 = Date.now();
let ready = false;
while (Date.now() - t0 < 90000) {
  await page.waitForTimeout(500);
  const t = await page.evaluate(() => document.getElementById("terminal").innerText);
  if (t.includes("ready.")) { ready = true; break; }
}
console.log("ready at", ((Date.now() - t0) / 1000).toFixed(1) + "s");
// let the game loop render frame 1 (ready → sleep 0.8 → loop; give it 2s)
await page.waitForTimeout(2000);
const fA = await grab("frame1-A");
await page.waitForTimeout(500);
const fB = await grab("frame1-B");

function compare(name, x, y) {
  const W = x.W, H = x.H;
  const a = new Uint8Array(x.px), b = new Uint8Array(y.px);
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
        for (let x2 = Math.floor(rx * W / RCOLS); x2 < Math.floor((rx + 1) * W / RCOLS); x2++) {
          const i = (y * W + x2) * 4; t++;
          if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) same++;
        }
      }
      regions.push({ row: ry, col: rx, pct: +(same / t * 100).toFixed(1) });
    }
  }
  const r = { name, size: W + "x" + H, identicalPct: +(identical / tot * 100).toFixed(2), nearPct: +((identical + near) / tot * 100).toFixed(2), regions };
  console.log("RESULT", name, "identical=" + r.identicalPct + "% near=" + r.nearPct + "%");
  return r;
}

const results = {
  settings_vs_settings: compare("settings-A vs settings-B", sA, sB),
  frame1_vs_frame1: compare("frame1-A vs frame1-B", fA, fB),
  settings_vs_frame1: compare("settings-A vs frame1-A", sA, fA),
};
writeFileSync(OUT + "/all-similarity.json", JSON.stringify(results, null, 1));
await browser.close();
