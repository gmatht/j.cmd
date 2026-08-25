// Test tab completion for M<tab> and m<tab>
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

async function tabTest(prefix) {
  await page.evaluate(() => document.getElementById("hidden-input").focus());
  await page.keyboard.type(prefix);
  await page.keyboard.press("Tab");
  await page.waitForTimeout(1500);
  const line = await page.evaluate(() => {
    const el = document.getElementById("input-span");
    return el ? el.textContent : "";
  });
  console.log(`"${prefix}<Tab>" → input line: "${line}"`);
  // clear the line
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
}

await tabTest("M");
await tabTest("m");
await tabTest("MIME");
await tabTest("mime");

// check what's in /bin
const bin = await page.evaluate(async () => {
  try {
    const r = await fetch("/fs/list?path=/bin");
    return r.ok ? await r.text() : "(no endpoint)";
  } catch { return "(fetch failed)"; }
});
console.log("/bin listing:", bin.slice(0, 500));

await browser.close();
