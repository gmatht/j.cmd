// Capture one shader per fresh page
import { chromium } from "/home/user/node_modules/playwright/index.mjs";
import { writeFileSync } from "fs";

async function capture(device) {
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
  await page.waitForTimeout(12000);
  await page.keyboard.press("Space");
  await page.waitForTimeout(6000);
  await page.keyboard.press("q");
  await page.waitForTimeout(5000);
  await page.evaluate(() => document.getElementById("hidden-input").focus());
  await page.keyboard.type("cat /dev/webgl/shader/" + device);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3000);
  const t = await page.evaluate(() => document.getElementById("terminal").innerText);
  const lines = t.split("\n");
  const start = lines.findIndex((l) => l.includes("precision") || l.includes("#version"));
  const end = lines.findIndex((l, i) => i > start && l.includes("== Quit"));
  const shader = lines.slice(start, end === -1 ? undefined : end).join("\n");
  await browser.close();
  return shader;
}

const vert = await capture("vertex");
writeFileSync("/tmp/runtime-vertex2.glsl", vert);
console.log("vertex:", vert.length, "chars");
const frag = await capture("fragment");
writeFileSync("/tmp/runtime-frag2.glsl", frag);
console.log("frag:", frag.length, "chars");
