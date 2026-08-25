// Reproduce: blocks invisible in browser. Check webgl log + canvas.
import { chromium } from "/home/user/node_modules/playwright/index.mjs";

const browser = await chromium.launch({
  headless: false,
  executablePath: "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (msg) => console.log("[console]", msg.type(), msg.text().slice(0, 400)));
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 800)));

await page.goto("http://127.0.0.1:8060/www/", { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("#hidden-input", { state: "attached", timeout: 30000 });
await page.waitForTimeout(3000);

await page.evaluate(() => document.getElementById("hidden-input").focus());
await page.keyboard.type("MIMEcroft.sh");
await page.keyboard.press("Enter");
await page.waitForTimeout(12000);
// SPACE to start the game (dismiss settings menu)
await page.keyboard.press("Space");
await page.waitForTimeout(8000);

// read the webgl device log via the shell
const t = await page.evaluate(() => document.getElementById("terminal").innerText);
console.log("terminal tail:", JSON.stringify(t.slice(-400)));

// check canvas pixels + GL state via evaluate
const res = await page.evaluate(() => {
  const canvas = document.querySelector("canvas");
  const gl = canvas.getContext("webgl") || canvas.getContext("webgl2");
  const out = { hasCanvas: !!canvas, hasGL: !!gl };
  if (canvas && gl) {
    out.size = canvas.width + "x" + canvas.height;
    const px = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let nonBlack = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] > 8 || px[i + 1] > 8 || px[i + 2] > 8) nonBlack++;
    }
    out.nonBlack = nonBlack;
    out.total = px.length / 4;
    const at = (x, y) => {
      const i = (y * canvas.width + x) * 4;
      return [px[i], px[i + 1], px[i + 2]];
    };
    out.center = at(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2));
    out.mid = at(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2) - 100);
    out.lower = at(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2) + 100);
    // GL errors?
    out.glError = gl.getError();
  }
  return out;
});
console.log("CANVAS:", JSON.stringify(res));
await browser.close();
