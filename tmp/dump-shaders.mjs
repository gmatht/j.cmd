// Dump the runtime vertex+fragment shaders to files
import { chromium } from "/home/user/node_modules/playwright/index.mjs";
import { writeFileSync } from "fs";

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
async function run(cmd) {
  await page.evaluate(() => document.getElementById("hidden-input").focus());
  await page.keyboard.type(cmd);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3000);
  return await page.evaluate(() => document.getElementById("terminal").innerText);
}
let t = await run("cat /dev/webgl/shader/vertex");
// extract the GLSL (from "precision" or "#" to the end of shader code)
const v = t.split("\n");
const startV = v.findIndex((l) => l.includes("precision") || l.includes("#version"));
const vert = v.slice(Math.max(0, startV)).join("\n").split("== Quit")[0];
writeFileSync("/tmp/runtime-vertex.glsl", vert);
console.log("vertex saved:", vert.length, "chars");

t = await run("cat /dev/webgl/shader/fragment");
const f = t.split("\n");
const startF = f.findIndex((l) => l.includes("precision") || l.includes("#version"));
const frag = f.slice(Math.max(0, startF)).join("\n").split("== Quit")[0];
writeFileSync("/tmp/runtime-frag.glsl", frag);
console.log("frag saved:", frag.length, "chars");
await browser.close();
