import { chromium } from "/home/user/node_modules/playwright/index.mjs";
const browser = await chromium.launch({
  headless: false,
  executablePath: "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
try {
  await page.goto("http://127.0.0.1:8060/www/", { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector("#hidden-input", { state: "attached", timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() => document.getElementById("hidden-input").focus());
  await page.keyboard.type("MIMEcroft.sh");
  await page.keyboard.press("Enter");
  // poll for the menu card (up to 240s)
  let ready = false;
  for (let i = 0; i < 48 && !ready; i++) {
    await page.waitForTimeout(5000);
    ready = await page.evaluate(() => {
      const c = document.getElementById("sh2runtime-webgl");
      if (!c || c.width < 200) return false;
      const gl = c.getContext("webgl") || c.getContext("webgl2");
      const W = c.width, H = c.height;
      const px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let bright = 0;
      for (let j = 0; j < px.length; j += 4) if (px[j] > 150 && px[j+1] > 150 && px[j+2] > 150) bright++;
      return bright > 10000;
    });
  }
  console.log("menu card visible:", ready);
  if (!ready) { await browser.close(); process.exit(0); }
  async function grab() {
    return await page.evaluate(() => {
      const c = document.getElementById("sh2runtime-webgl");
      const gl = c.getContext("webgl") || c.getContext("webgl2");
      const W = c.width, H = c.height;
      const px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let h = 0;
      for (let i = 0; i < px.length; i += 997) h = (h * 31 + px[i] * 3 + px[i+1] * 5 + px[i+2] * 7) | 0;
      return h;
    });
  }
  // sample 20s — the AI should move continuously
  const changes = [];
  let prev = await grab();
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    await page.waitForTimeout(200);
    const cur = await grab();
    if (cur !== prev) changes.push(Date.now() - t0);
    prev = cur;
  }
  const gaps = changes.slice(1).map((c, i) => c - changes[i]);
  console.log("canvas changes:", changes.length, "in 15s");
  console.log("avg gap:", gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : -1, "ms | max gap:", gaps.length ? Math.max(...gaps) : -1, "ms");
} catch (e) {
  console.log("ERROR:", e.message);
}
await browser.close();
